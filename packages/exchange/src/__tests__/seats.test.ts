// seats — the reproductions a caller-chosen peer id failed, through the
// Exchange.
//
// When the caller chose the peer id, a store-less page that reloaded, or a
// duplicated tab, wrote again under an id whose history it did not hold. Its
// operations took addresses the earlier writer's operations already occupied,
// so both sides reached equal version vectors over different text and never
// synced again. Each Runtime now issues its own seat, so every one of these
// converges.

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
import { drain, exchangesPerTest } from "./exchanges.js"

const TextSchema = Schema.struct({ text: Schema.text() })

type Bound = BoundSchema<typeof TextSchema>

const backends: ReadonlyArray<readonly [string, Bound]> = [
  ["yjs", yjs.bind(TextSchema)],
  ["loro", loro.bind(TextSchema)],
]

const createExchange = exchangesPerTest()

/** An Exchange for `principal`, connected to `bridge` as `transportId` unless
 *  `offline`. */
function open(
  principal: string,
  bridge: Bridge,
  transportId: string,
  offline = false,
): Exchange {
  return createExchange({
    principal,
    transports: offline ? [] : [createBridgeTransport({ transportId, bridge })],
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
