// lineage — two lineages of one plain document converge on the later one, and
// every peer that meets them reports it.
//
// A plain document has one writer, and its lineage is that writer's identity.
// Two meet when a writer restarts without its history, or when two writers
// author one document. Every peer crosses toward the lineage minted later, so
// they converge instead of swapping, and each reports a `lineage-collision`.
//
// Each case sets the clock before a writer's first write, so which lineage is
// later does not depend on random suffixes minted within one millisecond.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { json, Schema } from "@kyneta/schema"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ExchangeParams } from "../exchange.js"
import { persisted } from "../persistence.js"
import { createInMemoryStore } from "../store/in-memory-store.js"
import { exchangesPerTest, sleep } from "./exchanges.js"
import { wrapStore } from "./wrap-store.js"

const Doc = json.bind(Schema.struct({ title: Schema.string() }))

const EARLY = Date.UTC(2026, 0, 1)
const LATE = Date.UTC(2026, 0, 2)

const createExchange = exchangesPerTest()
afterEach(() => {
  vi.useRealTimers()
})

/** An exchange on `bridges`, recording the lineage collisions it reports. */
function open(
  id: string,
  bridges: Bridge[],
  params: Partial<ExchangeParams> = {},
) {
  const exchange = createExchange({
    principal: id,
    transports: bridges.map((bridge, i) =>
      createBridgeTransport({ bridge, transportId: `${id}-${i}` }),
    ),
    ...params,
  })
  const collisions: string[] = []
  exchange.observe(o => {
    if (o.kind === "diagnostic" && o.code === "lineage-collision") {
      collisions.push(o.remote)
    }
  })
  return { exchange, doc: exchange.get("doc", Doc), collisions }
}

/** Write the title with the clock at `at`, which mints the lineage if new. */
function writeAt(
  at: number,
  doc: ReturnType<typeof open>["doc"],
  title: string,
) {
  vi.setSystemTime(at)
  doc.title.set(title)
}

// The diagnostic is an error, and the shell logs it; these cases cause it on
// purpose.
function quietErrors(): void {
  vi.spyOn(console, "error").mockImplementation(() => {})
}

describe("two lineages of a plain document", () => {
  it("converge on the restarted writer's, which is later", async () => {
    quietErrors()
    const bridge = new Bridge()
    const server = open("server", [bridge])
    const first = open("writer", [bridge])
    writeAt(EARLY, first.doc, "old")
    await sleep(40)
    expect(server.doc.title()).toBe("old")
    createExchange.forget(first.exchange)
    first.exchange.reset()

    // No store: the new session writes before it has heard anything.
    const second = open("writer", [bridge], {
      transports: [
        createBridgeTransport({ bridge, transportId: "writer-again" }),
      ],
    })
    writeAt(LATE, second.doc, "new")
    await sleep(40)

    expect(server.doc.title()).toBe("new")
    expect(second.doc.title()).toBe("new")
    expect(server.collisions.length).toBeGreaterThan(0)
  })

  it("converge, without looping, when two writers synced empty and wrote in one tick", async () => {
    quietErrors()
    const bridge = new Bridge()
    const a = open("a", [bridge])
    const b = open("b", [bridge])
    await sleep(40)

    writeAt(EARLY, a.doc, "a")
    writeAt(LATE, b.doc, "b")
    await sleep(40)

    expect(a.doc.title()).toBe("b")
    expect(b.doc.title()).toBe("b")
    expect(a.collisions.length).toBeGreaterThan(0)
    expect(b.collisions.length).toBeGreaterThan(0)
  })

  it("converge along a line of relays", async () => {
    quietErrors()
    // a — s1 — s2 — b, with a and b writing different lineages.
    const [as1, s1s2, s2b] = [new Bridge(), new Bridge(), new Bridge()]
    const a = open("a", [as1])
    const s1 = open("s1", [as1, s1s2])
    const s2 = open("s2", [s1s2, s2b])
    const b = open("b", [s2b])

    writeAt(EARLY, a.doc, "a")
    writeAt(LATE, b.doc, "b")
    await sleep(80)

    expect([a, s1, s2, b].map(p => p.doc.title())).toEqual(["b", "b", "b", "b"])
  })

  it("keep ours and still report it when canReset vetoes the later one", async () => {
    quietErrors()
    const bridge = new Bridge()
    const keeper = open("keeper", [bridge])
    keeper.exchange.register({ canReset: () => false })
    const other = open("other", [bridge])
    await sleep(40)

    writeAt(EARLY, keeper.doc, "kept")
    writeAt(LATE, other.doc, "later")
    await sleep(40)

    expect(keeper.doc.title()).toBe("kept")
    expect(keeper.collisions.length).toBeGreaterThan(0)
  })

  it("publish again after a reset discards an unconfirmed own write", async () => {
    // Store-first holds the loser's write until its store confirms it. The
    // reset discards it, so there is nothing left to confirm, and the
    // document must not stay held forever.
    quietErrors()
    const inner = createInMemoryStore()
    let waiting: (() => void)[] | undefined = []
    const held = wrapStore(inner, {
      append: async (docId, record, options) => {
        const w = waiting
        if (w) await new Promise<void>(resolve => w.push(resolve))
        await inner.append(docId, record, options)
      },
    })
    const bridge = new Bridge()
    const loser = open("loser", [bridge], { store: held })
    const winner = open("winner", [bridge])
    await sleep(40)

    writeAt(EARLY, loser.doc, "lost")
    writeAt(LATE, winner.doc, "won")
    await sleep(40)
    expect(loser.doc.title()).toBe("won")

    const released = waiting ?? []
    waiting = undefined
    for (const resolve of released) resolve()
    await sleep(40)
    expect(persisted(loser.doc)).toBe(true)

    loser.doc.title.set("after")
    await sleep(40)
    expect(winner.doc.title()).toBe("after")
  })
})
