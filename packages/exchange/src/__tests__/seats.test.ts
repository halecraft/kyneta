// seats — the reproductions a caller-chosen peer id failed, through the
// Exchange, and the durable seats a store issues.
//
// When the caller chose the peer id, a store-less page that reloaded, or a
// duplicated tab, wrote again under an id whose history it did not hold. Its
// operations took addresses the earlier writer's operations already occupied,
// so both sides reached equal version vectors over different text and never
// synced again. A Runtime without a store now issues itself a fresh seat, and
// one with a store takes a seat from it that no other live writer holds and
// whose history the store holds, so every one of these converges.

import {
  Bridge,
  BridgeTransport,
  createBridgeTransport,
} from "@kyneta/bridge-transport"
import { loro } from "@kyneta/loro-schema"
import { type BoundSchema, batch, Schema } from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"
import { describe, expect, it } from "vitest"
import type { Exchange } from "../exchange.js"
import { persisted, persistenceError } from "../persistence.js"
import { whenHydrated } from "../settle.js"
import {
  abandonSeat,
  createInMemoryStoreData,
  InMemoryStore,
  recordsOf,
} from "../store/in-memory-store.js"
import { SeatLostError } from "../store/seats.js"
import type { Store } from "../store/store.js"
import { drain, exchangesPerTest } from "./exchanges.js"
import { wrapStore } from "./wrap-store.js"

const TextSchema = Schema.struct({ text: Schema.text() })

type Bound = BoundSchema<typeof TextSchema>

const backends: ReadonlyArray<readonly [string, Bound]> = [
  ["yjs", yjs.bind(TextSchema)],
  ["loro", loro.bind(TextSchema)],
]

const createExchange = exchangesPerTest()

/** An Exchange for `principal`, connected to `bridge` as `transportId` unless
 *  `offline`, over `store` if given. */
function open(
  principal: string,
  bridge: Bridge,
  transportId: string,
  offline = false,
  store?: Store,
): Exchange {
  return createExchange({
    principal,
    transports: offline ? [] : [createBridgeTransport({ transportId, bridge })],
    ...(store ? { store } : {}),
  })
}

function textOf(ex: Exchange, bound: Bound): string {
  return ex.get("doc", bound).text()
}

function insert(ex: Exchange, bound: Bound, at: number, s: string): void {
  batch(ex.get("doc", bound), d => d.text.insert(at, s))
}

function append(ex: Exchange, bound: Bound, s: string): void {
  insert(ex, bound, textOf(ex, bound).length, s)
}

describe.each(backends)("seats (%s)", (_name, bound) => {
  it("two Exchanges with the same principal have different peer ids", () => {
    const bridge = new Bridge()
    const a = open("alice", bridge, "a", true)
    const b = open("alice", bridge, "b", true)
    expect(a.peerId).not.toBe(b.peerId)
  })

  it("reload: a store-less page that writes before syncing converges", async () => {
    const bridge = new Bridge()
    const host = open("host", bridge, "host")
    insert(host, bound, 0, "Other.")

    // First page load: sync, then type.
    const page1 = open("user", bridge, "page-1")
    textOf(page1, bound)
    await drain()
    insert(page1, bound, 0, "D2 ")
    insert(page1, bound, 0, "D1 ")
    await drain()
    expect(textOf(host, bound)).toBe("D1 D2 Other.")

    // Reload: the page's memory is gone, the principal is not. It writes
    // before it has synced anything.
    await page1.shutdown()
    const page2 = open("user", bridge, "page-2", true)
    insert(page2, bound, 0, "EARLY ")
    await page2.addTransport(
      new BridgeTransport({ transportId: "page-2", bridge }),
    )
    await drain()

    const text = textOf(host, bound)
    expect(textOf(page2, bound)).toBe(text)
    for (const part of ["EARLY ", "D1 ", "D2 ", "Other."]) {
      expect(text).toContain(part)
    }
  })

  it("duplicated tab: a copy that writes before syncing converges", async () => {
    const bridge = new Bridge()
    const host = open("host", bridge, "host")
    insert(host, bound, 0, "base")

    const tabA = open("user", bridge, "tab-a")
    textOf(tabA, bound)
    await drain()
    append(tabA, bound, "-A")
    await drain()

    // The duplicate starts with nothing and writes before syncing.
    const tabB = open("user", bridge, "tab-b", true)
    insert(tabB, bound, 0, "B-")
    await tabB.addTransport(
      new BridgeTransport({ transportId: "tab-b", bridge }),
    )
    await drain()

    // Where "B-" falls relative to "base-A" is the backend's tiebreak between
    // concurrent inserts; that all three agree is the point.
    const text = textOf(host, bound)
    expect(textOf(tabA, bound)).toBe(text)
    expect(textOf(tabB, bound)).toBe(text)
    expect([...text].sort().join("")).toBe([..."B-base-A"].sort().join(""))
    expect(text).toContain("base-A")
  })

  it("duplicated tab: two copies that sync first, then write, converge", async () => {
    const bridge = new Bridge()
    const host = open("host", bridge, "host")
    insert(host, bound, 0, "host")

    const tabA = open("user", bridge, "tab-a")
    const tabB = open("user", bridge, "tab-b")
    textOf(tabA, bound)
    textOf(tabB, bound)
    await drain()
    expect(textOf(tabA, bound)).toBe("host")
    expect(textOf(tabB, bound)).toBe("host")

    insert(tabA, bound, 0, "AAA")
    append(tabB, bound, "BBB")
    await drain()

    for (const ex of [host, tabA, tabB]) {
      expect(textOf(ex, bound)).toBe("AAAhostBBB")
    }
  })
})

describe.each(backends)("durable seats (%s)", (_name, bound) => {
  it("two live Exchanges over one storage hold different seats, and a reload keeps one", async () => {
    const bridge = new Bridge()
    const storage = createInMemoryStoreData()
    const a = open("user", bridge, "a", true, new InMemoryStore(storage))
    const b = open("user", bridge, "b", true, new InMemoryStore(storage))
    expect(a.peerId).not.toBe(b.peerId)

    await a.shutdown()
    const reloaded = open("user", bridge, "c", true, new InMemoryStore(storage))
    expect(reloaded.peerId).toBe(a.peerId)
  })

  it("a crash that lost a write converges when the reload takes the same seat, and the lost write's late commit is refused", async () => {
    // Store-first's reproduction, with the seat the crashed writer held
    // issued again: the write the network never saw is lost, and the reload
    // reissues its addresses. Nothing of it left the process, so no peer
    // holds the old operations.
    const bridge = new Bridge()
    const host = open("host", bridge, "host")
    textOf(host, bound)

    const storage = createInMemoryStoreData()
    const inner = new InMemoryStore(storage)
    // Appends made while `held` is set wait for it, and each one's outcome
    // is kept in `late`.
    let release = () => {}
    let held: Promise<void> | undefined
    const late: Promise<unknown>[] = []
    const store = wrapStore(inner, {
      append: async (docId, record) => {
        if (held === undefined) return inner.append(docId, record)
        const waiting = held
        const outcome = waiting.then(() => inner.append(docId, record))
        late.push(
          outcome.then(
            () => "stored",
            (error: unknown) => error,
          ),
        )
        return outcome
      },
    })
    const before = open("browser", bridge, "browser", false, store)
    insert(before, bound, 0, "A")
    await drain()
    expect(textOf(host, bound)).toBe("A")

    held = new Promise(resolve => {
      release = resolve
    })
    append(before, bound, "B")
    await drain()
    expect(textOf(host, bound)).toBe("A")

    // The crash: nothing is flushed, and the platform releases the seat.
    createExchange.forget(before)
    before.reset()
    abandonSeat(inner)

    const after = open(
      "browser",
      bridge,
      "browser-2",
      false,
      new InMemoryStore(storage),
    )
    expect(after.peerId).toBe(before.peerId)
    await whenHydrated(after.get("doc", bound))
    append(after, bound, "C")
    await drain()

    // The crashed writer's held append lands late, and the fence refuses it.
    const storedBefore = recordsOf(storage, "doc").length
    release()
    expect(late).toHaveLength(1)
    for (const outcome of await Promise.all(late)) {
      expect(outcome).toBeInstanceOf(SeatLostError)
    }
    expect(recordsOf(storage, "doc")).toHaveLength(storedBefore)
    await drain()

    expect(textOf(host, bound)).toBe("AC")
    expect(textOf(after, bound)).toBe("AC")
  })

  it("a lost seat stops every write, reports itself on every document, and lets flush() resolve", async () => {
    const bridge = new Bridge()
    const host = open("host", bridge, "host")
    textOf(host, bound)

    const storage = createInMemoryStoreData()
    const store = new InMemoryStore(storage)
    const errors: unknown[] = []
    const writer = createExchange({
      principal: "writer",
      transports: [createBridgeTransport({ transportId: "writer", bridge })],
      store,
      onStoreError: (_docId, _operation, error) => errors.push(error),
    })
    insert(writer, bound, 0, "A")
    await drain()
    expect(textOf(host, bound)).toBe("A")

    // Another writer takes the seat, as a new tab does once this one's lock
    // is released while it still runs.
    abandonSeat(store)
    const other = open(
      "writer",
      bridge,
      "other",
      true,
      new InMemoryStore(storage),
    )
    expect(other.peerId).toBe(writer.peerId)

    append(writer, bound, "X")
    await drain()
    const doc = writer.get("doc", bound)
    expect(textOf(host, bound)).toBe("A")
    expect(persisted(doc)).toBe(false)
    expect(persistenceError(doc)).toBeInstanceOf(SeatLostError)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(SeatLostError)

    // A document opened after the loss reports it too.
    const later = writer.get("later", bound)
    await whenHydrated(later)
    expect(persistenceError(later)).toBeInstanceOf(SeatLostError)
    batch(later, d => d.text.insert(0, "Y"))
    await drain()
    expect(persisted(later)).toBe(false)
    expect(host.get("later", bound).text()).toBe("")

    await writer.flush()
    append(writer, bound, "Z")
    await drain()
    expect(textOf(host, bound)).toBe("A")
    expect(errors).toHaveLength(1)
  })
})
