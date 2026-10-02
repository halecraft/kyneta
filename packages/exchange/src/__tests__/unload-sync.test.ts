// unload-sync — unloading over the network, hub and spoke.
//
// The host serves (`authority: "self"`); each client defers to it. A client's
// last writes reach the host though the client unloads at once; a client's
// unloaded document stays unloaded across a reconnect; a cancelled unload
// catches up on what it ignored while leaving; and a host's unloaded document
// loads again when a client asks for it.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { loro } from "@kyneta/loro-schema"
import { Schema } from "@kyneta/schema"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Exchange } from "../exchange.js"
import type { ObsEvent } from "../observe.js"
import { whenHydrated } from "../settle.js"
import { createInMemoryStore } from "../store/in-memory-store.js"
import type { Store } from "../store/store.js"
import { whenSettled } from "../sync.js"
import { drain, exchangesPerTest } from "./exchanges.js"
import { gated } from "./wrap-store.js"

const createExchange = exchangesPerTest()

const Card = loro.bind(
  Schema.struct({ title: Schema.string(), n: Schema.number() }),
)

type Doc = any

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
})

function host(bridge: Bridge, store: Store = createInMemoryStore()): Exchange {
  return createExchange({
    principal: "host",
    store,
    authority: "self",
    transports: [createBridgeTransport({ transportId: "host", bridge })],
  })
}

function client(
  bridge: Bridge,
  name: string,
  store: Store = createInMemoryStore(),
): Exchange {
  return createExchange({
    principal: name,
    store,
    authority: peer => peer.principal === "host",
    transports: [createBridgeTransport({ transportId: name, bridge })],
  })
}

const phaseOf = (exchange: Exchange, docId: string) =>
  exchange.runtime.lifecycleOf(docId)?.phase

/** `exchange` and the host hold the card, settled and stored. */
async function shared(exchange: Exchange, hub: Exchange): Promise<Doc[]> {
  const mine: Doc = exchange.get("card", Card)
  const theirs: Doc = hub.get("card", Card)
  await whenSettled(mine)
  await whenSettled(theirs)
  await exchange.flush()
  await hub.flush()
  return [mine, theirs]
}

function reloadDiagnostics(events: readonly ObsEvent[]): ObsEvent[] {
  return events.filter(
    e => e.layer === "diagnostic" && e.code === "unloaded-doc-reloaded",
  )
}

describe("unload over the network", () => {
  it("a client's last edit reaches the host, and the client never opens it again", async () => {
    const bridge = new Bridge()
    const hub = host(bridge)
    const gate = gated(createInMemoryStore(), "append")
    const alice = client(bridge, "alice", gate.store)
    const [mine, theirs] = await shared(alice, hub)

    gate.hold()
    mine.title.set("last")
    alice.unload("card")
    await drain()
    // Store-first: the write leaves only once alice's store holds it.
    expect(theirs.title()).toBe("")
    expect(phaseOf(alice, "card")).toBe("unloading")

    gate.release()
    await alice.flush()
    await drain()
    expect(phaseOf(alice, "card")).toBe("unloaded")
    expect(theirs.title()).toBe("last")
  })

  it("a client's unloaded document stays unloaded across a reconnect and a host write", async () => {
    const bridge = new Bridge()
    const hub = host(bridge)
    const alice = client(bridge, "alice")
    const [, theirs] = await shared(alice, hub)
    alice.unload("card")
    await alice.flush()
    expect(phaseOf(alice, "card")).toBe("unloaded")

    await alice.removeTransport("alice")
    await alice.addTransport(
      createBridgeTransport({ transportId: "alice", bridge }),
    )
    await drain()
    theirs.title.set("host's")
    await drain()

    expect(phaseOf(alice, "card")).toBe("unloaded")
    expect(alice.runtime.instanceOf("card")).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it("a cancelled unload catches up on what it ignored while leaving", async () => {
    const bridge = new Bridge()
    const hub = host(bridge)
    const gate = gated(createInMemoryStore(), "append")
    const alice = client(bridge, "alice", gate.store)
    const [mine, theirs] = await shared(alice, hub)

    gate.hold()
    mine.n.set(1)
    alice.unload("card")
    await drain()
    theirs.title.set("host's")
    await drain()
    // Leaving: the host's offer was not taken in.
    expect(mine.title()).toBe("")

    expect(alice.get("card", Card)).toBe(mine)
    await drain()
    expect(mine.title()).toBe("host's")
    gate.release()
    await alice.flush()
    await drain()
    expect(theirs.n()).toBe(1)
    expect(phaseOf(alice, "card")).toBe("ready")
  })

  describe("the host unloads", () => {
    it("a client that asks loads it again, once, and receives its content", async () => {
      const bridge = new Bridge()
      const hub = host(bridge)
      const events: ObsEvent[] = []
      hub.observe(e => events.push(e))
      const written: Doc = hub.get("card", Card)
      await whenHydrated(written)
      written.title.set("stored")
      await hub.flush()
      hub.unload("card")
      await hub.flush()
      expect(phaseOf(hub, "card")).toBe("unloaded")

      // The client's present and interest both arrive while the host loads.
      const bob = client(bridge, "bob")
      const doc: Doc = bob.get("card", Card)
      await whenSettled(doc)
      await drain()

      expect(doc.title()).toBe("stored")
      expect(hub.documents.get("card")).toEqual({
        mode: "interpret",
        suspended: false,
      })
      expect(reloadDiagnostics(events)).toHaveLength(1)
      expect(reloadDiagnostics(events)[0]).toMatchObject({
        severity: "warning",
        peer: bob.peerId,
        docId: "card",
      })
    })
  })
})
