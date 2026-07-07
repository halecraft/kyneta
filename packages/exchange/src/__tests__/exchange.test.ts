// Exchange — unit tests for the public Exchange API.

import {
  Bridge,
  BridgeTransport,
  createBridgeTransport,
} from "@kyneta/bridge-transport"
import { hasChangefeed } from "@kyneta/changefeed"
import { loro } from "@kyneta/loro-schema"
import {
  batch,
  bind,
  Defer,
  json,
  type PlainState,
  plainReplicaFactory,
  plainSubstrateFactory,
  Schema,
  SUBSTRATE,
  type Substrate,
  SYNC_AUTHORITATIVE,
  unwrap,
} from "@kyneta/schema"
import type { PeerIdentityDetails } from "@kyneta/transport"
import type {
  LoroDoc as LoroDocNative,
  LoroMap as LoroMapNative,
} from "loro-crdt"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  Exchange,
  type ExchangeParams,
  type PeerIdentityInput,
} from "../exchange.js"
import { hasSync, sync } from "../sync.js"
import type { PeerChange } from "../types.js"

// ---------------------------------------------------------------------------
// Test schemas (bound at module scope)
// ---------------------------------------------------------------------------

const testSchema = Schema.struct({
  title: Schema.string(),
  count: Schema.number(),
})

const TestDoc = json.bind(testSchema)

const otherSchema = Schema.struct({ name: Schema.string() })
const OtherDoc = json.bind(otherSchema)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers for multi-peer tests
// ---------------------------------------------------------------------------

async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

const activeExchanges: Exchange[] = []

function createExchange(params: Partial<ExchangeParams> = {}): Exchange {
  const merged = { id: "test" as string | PeerIdentityInput, ...params }
  const ex = new Exchange(merged as ExchangeParams)
  activeExchanges.push(ex)
  return ex
}

afterEach(async () => {
  for (const ex of activeExchanges) {
    try {
      await ex.shutdown()
    } catch {
      /* ignore */
    }
  }
  activeExchanges.length = 0
})

// ---------------------------------------------------------------------------

describe("Exchange", () => {
  describe("constructor", () => {
    it("creates with explicit peerId", () => {
      const exchange = new Exchange({
        id: "my-peer",
      })

      expect(exchange.peerId).toBe("my-peer")
    })
  })

  describe("get()", () => {
    it("returns a Ref<S> that can be read", () => {
      const exchange = new Exchange({ id: "test" })
      const doc = exchange.get("doc-1", TestDoc)

      // The ref should be callable (returns plain value)
      const value = doc()
      expect(value).toEqual({ title: "", count: 0 })
    })

    it("returns a Ref<S> with navigation and batch()-applied values", () => {
      const exchange = new Exchange({ id: "test" })
      const doc = exchange.get("doc-1", TestDoc)
      batch(doc, (d: any) => {
        d.title.set("Hello")
        d.count.set(42)
      })

      expect(doc.title()).toBe("Hello")
      expect(doc.count()).toBe(42)
    })

    it("same docId returns same instance", () => {
      const exchange = new Exchange({ id: "test" })

      const doc1 = exchange.get("doc-1", TestDoc)
      const doc2 = exchange.get("doc-1", TestDoc)

      expect(doc1).toBe(doc2)
    })

    it("different BoundSchema for same docId throws", () => {
      const exchange = new Exchange({ id: "test" })

      exchange.get("doc-1", TestDoc)
      expect(() => exchange.get("doc-1", OtherDoc)).toThrow(
        "different BoundSchema",
      )
    })

    it("batch() values are applied", () => {
      const exchange = new Exchange({ id: "test" })
      const doc = exchange.get("doc-1", TestDoc)
      batch(doc, (d: any) => {
        d.title.set("Changed")
        d.count.set(99)
      })

      expect(doc.title()).toBe("Changed")
      expect(doc.count()).toBe(99)
    })
  })

  describe("factory builder lifecycle", () => {
    it("factory builder is called with the exchange's peerId", () => {
      const builder = vi.fn(() => plainSubstrateFactory)
      const Doc = bind({
        schema: testSchema,
        factory: builder,
        syncMode: SYNC_AUTHORITATIVE,
      })

      const exchange = new Exchange({ id: "alice-123" })
      exchange.get("doc-1", Doc)

      expect(builder).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: "alice-123" }),
      )
    })

    it("factory builder is called per use site (no caching)", () => {
      const builder = vi.fn(() => plainSubstrateFactory)
      const DocA = bind({
        schema: testSchema,
        factory: builder,
        syncMode: SYNC_AUTHORITATIVE,
      })

      const exchange = new Exchange({ id: "test" })
      exchange.get("doc-1", DocA)

      // Builder is invoked at each use site: registerSchema (capabilities +
      // auto-promote scan) and #interpretDoc. No WeakMap caching.
      for (const call of builder.mock.calls as unknown as Array<
        [{ peerId: string }]
      >) {
        expect(call[0]).toEqual(expect.objectContaining({ peerId: "test" }))
      }
    })

    it("two exchanges sharing the same BoundSchema pass their own peerId", () => {
      const peerIds: string[] = []
      const builder = vi.fn((ctx: { peerId: string }) => {
        peerIds.push(ctx.peerId)
        return plainSubstrateFactory
      })
      const Doc = bind({
        schema: testSchema,
        factory: builder,
        syncMode: SYNC_AUTHORITATIVE,
      })

      const exchangeA = new Exchange({ id: "alice" })
      const exchangeB = new Exchange({ id: "bob" })

      exchangeA.get("doc-1", Doc)
      exchangeB.get("doc-1", Doc)

      // Each exchange passes its own peerId to every builder invocation
      expect(builder).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: "alice" }),
      )
      expect(builder).toHaveBeenCalledWith(
        expect.objectContaining({ peerId: "bob" }),
      )
      expect(peerIds).toContain("alice")
      expect(peerIds).toContain("bob")
    })
  })

  describe("has()", () => {
    it("returns false for unknown doc", () => {
      const exchange = new Exchange({ id: "test" })
      expect(exchange.has("nonexistent")).toBe(false)
    })

    it("returns true after get()", () => {
      const exchange = new Exchange({ id: "test" })
      exchange.get("doc-1", TestDoc)
      expect(exchange.has("doc-1")).toBe(true)
    })
  })

  describe("destroy()", () => {
    it("removes a document", () => {
      const exchange = new Exchange({ id: "test" })

      exchange.get("doc-1", TestDoc)
      expect(exchange.has("doc-1")).toBe(true)

      exchange.destroy("doc-1")
      expect(exchange.has("doc-1")).toBe(false)
    })
  })

  describe("sync()", () => {
    it("returns a SyncRef with peerId and docId", () => {
      const exchange = new Exchange({ id: "alice" })
      const doc = exchange.get("doc-1", TestDoc)
      const s = sync(doc)

      expect(s.peerId).toBe("alice")
      expect(s.docId).toBe("doc-1")
    })

    it("hasSync returns true for exchange docs", () => {
      const exchange = new Exchange({ id: "test" })
      const doc = exchange.get("doc-1", TestDoc)
      expect(hasSync(doc)).toBe(true)
    })

    it("hasSync returns false for non-exchange objects", () => {
      expect(hasSync({})).toBe(false)
    })

    it("sync() throws for non-exchange objects", () => {
      expect(() => sync({})).toThrow("exchange.get()")
    })

    it("peerStates is initially empty", () => {
      const exchange = new Exchange({ id: "test" })
      const doc = exchange.get("doc-1", TestDoc)
      expect(sync(doc).peerStates).toEqual([])
    })
  })

  describe("lifecycle", () => {
    it("reset() clears doc cache", () => {
      const exchange = new Exchange({ id: "test" })

      exchange.get("doc-1", TestDoc)
      expect(exchange.has("doc-1")).toBe(true)

      exchange.reset()
      expect(exchange.has("doc-1")).toBe(false)
    })

    it("shutdown() clears doc cache", async () => {
      const exchange = new Exchange({ id: "test" })

      exchange.get("doc-1", TestDoc)
      await exchange.shutdown()
      expect(exchange.has("doc-1")).toBe(false)
    })

    describe("escape hatches", () => {
      it("ref[SUBSTRATE] returns the substrate for an exchange-created doc", () => {
        const exchange = new Exchange({ id: "test" })
        const doc = exchange.get("doc-1", TestDoc)
        batch(doc, (d: any) => {
          d.title.set("Hi")
          d.count.set(1)
        })

        const substrate = (doc as any)[SUBSTRATE] as Substrate
        expect(substrate.version()).toBeDefined()

        const snapshot = substrate.exportEntirety()
        expect(snapshot.encoding).toBe("json")
        expect(
          (JSON.parse(snapshot.data as string) as any).s ||
            JSON.parse(snapshot.data as string),
        ).toEqual({
          title: "Hi",
          count: 1,
        })
      })

      it("unwrap(ref) returns the LoroDoc for a Loro-backed exchange doc", () => {
        const LoroBound = loro.bind(
          Schema.struct({
            title: Schema.text(),
            meta: Schema.struct({ author: Schema.string() }),
          }),
        )
        const exchange = new Exchange({
          id: "test",
          schemas: [LoroBound],
        })
        const doc = exchange.get("doc-1", LoroBound)

        // Precise root native: unwrap(doc) is exactly LoroDoc — no union, no
        // narrowing, no `as any`. The native map threads through Exchange.get.
        const loroDoc: LoroDocNative = unwrap(doc)
        expect(typeof loroDoc.toJSON).toBe("function")
        expect(typeof loroDoc.getText).toBe("function")

        // Nested struct fields resolve to the per-node container (LoroMap),
        // NOT the root LoroDoc — the root override applies only to the root.
        const nested: LoroMapNative = unwrap(doc.meta)
        expect(nested).toBeDefined()
      })

      it("unwrap(ref) returns the PlainState for a plain-backed exchange doc", () => {
        const exchange = new Exchange({ id: "test" })
        const doc = exchange.get("doc-1", TestDoc)

        // Precise root native: PlainState (the backing JS object), threaded
        // from json.bind()'s PlainNativeMap — not `unknown`, not a LoroDoc.
        const native: PlainState = unwrap(doc)
        expect(native).toBeDefined()
        expect((native as { getText?: unknown }).getText).toBeUndefined()
      })
    })

    describe("changefeed → synchronizer auto-wiring", () => {
      it("batch() auto-notifies synchronizer — no manual notifyLocalChange needed", async () => {
        const bridge = new Bridge()

        const exchangeA = new Exchange({
          id: "alice",
          transports: [createBridgeTransport({ transportId: "alice", bridge })],
        })
        const exchangeB = new Exchange({
          id: "bob",
          transports: [createBridgeTransport({ transportId: "bob", bridge })],
        })

        const docA = exchangeA.get("doc-1", TestDoc)
        batch(docA, (d: any) => {
          d.title.set("V1")
          d.count.set(1)
        })
        const docB = exchangeB.get("doc-1", TestDoc)

        // Initial sync
        await drain()
        expect(docB.title()).toBe("V1")

        // Mutate WITHOUT calling notifyLocalChange — auto-wiring should handle it
        batch(docA, (d: any) => {
          d.title.set("V2")
          d.count.set(2)
        })

        await drain()

        // Bob should see the mutation via auto-wired sync
        expect(docB.title()).toBe("V2")
        expect(docB.count()).toBe(2)
      })
    })
  })

  // =========================================================================
  // exchange.peers — peer lifecycle changefeed
  // =========================================================================

  describe("peers", () => {
    it("exchange.peers() starts empty", () => {
      const exchange = createExchange()
      expect(exchange.peers()).toEqual(new Map())
      expect(exchange.peers.current).toEqual(new Map())
    })

    it("hasChangefeed(exchange.peers) returns true", () => {
      const exchange = createExchange()
      expect(hasChangefeed(exchange.peers)).toBe(true)
    })

    it("peer-established fires when a remote peer connects via Bridge", async () => {
      const bridge = new Bridge()
      const exchange1 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })
      const _exchange2 = createExchange({
        id: { peerId: "bob", name: "Bob" },
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })

      const changes: PeerChange[] = []
      exchange1.peers.subscribe(cs => {
        changes.push(...cs.changes)
      })

      await drain()

      // Alice should see bob as a peer
      expect(exchange1.peers().size).toBe(1)
      expect(exchange1.peers().has("bob")).toBe(true)
      const bobIdentity = exchange1.peers().get("bob")
      expect(bobIdentity).toBeDefined()
      expect(bobIdentity?.peerId).toBe("bob")
      expect(bobIdentity?.name).toBe("Bob")

      // Should have received a peer-established change
      expect(changes.length).toBe(1)
      expect(changes[0].type).toBe("peer-established")
      expect(changes[0].peer.peerId).toBe("bob")
    })

    it("peer-departed fires when a remote peer disconnects", async () => {
      const bridge = new Bridge()
      const exchange1 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })
      const exchange2 = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })

      await drain()
      expect(exchange1.peers().size).toBe(1)

      const changes: PeerChange[] = []
      exchange1.peers.subscribe(cs => {
        changes.push(...cs.changes)
      })

      // Shutdown bob
      await exchange2.shutdown()

      await drain()

      // Alice should see no peers
      expect(exchange1.peers().size).toBe(0)

      // Should have received a peer-departed change
      expect(changes.length).toBe(1)
      expect(changes[0].type).toBe("peer-departed")
      expect(changes[0].peer.peerId).toBe("bob")
    })

    it("exchange.peers() reflects correct state during subscriber callback", async () => {
      const bridge = new Bridge()
      const exchange1 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })
      const _exchange2 = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })

      let peersDuringCallback:
        | ReadonlyMap<string, PeerIdentityDetails>
        | undefined
      exchange1.peers.subscribe(() => {
        peersDuringCallback = exchange1.peers()
      })

      await drain()

      // During the callback, peers() should reflect the updated state
      expect(peersDuringCallback).toBeDefined()
      expect(peersDuringCallback?.size).toBe(1)
      expect(peersDuringCallback?.has("bob")).toBe(true)
    })

    it("multi-transport: one peer-established on first bridge, no second on second bridge", async () => {
      const bridge1 = new Bridge()
      const bridge2 = new Bridge()
      const exchange1 = createExchange({
        id: "alice",
        transports: [
          createBridgeTransport({ transportId: "alice-1", bridge: bridge1 }),
          createBridgeTransport({ transportId: "alice-2", bridge: bridge2 }),
        ],
      })
      const _exchange2 = createExchange({
        id: "bob",
        transports: [
          createBridgeTransport({ transportId: "bob-1", bridge: bridge1 }),
          createBridgeTransport({ transportId: "bob-2", bridge: bridge2 }),
        ],
      })

      const changes: PeerChange[] = []
      exchange1.peers.subscribe(cs => {
        changes.push(...cs.changes)
      })

      await drain()

      // Only one peer-established, even though two bridges connect the same peer
      expect(exchange1.peers().size).toBe(1)
      const joinedChanges = changes.filter(c => c.type === "peer-established")
      expect(joinedChanges.length).toBe(1)
      expect(joinedChanges[0].peer.peerId).toBe("bob")
    })

    it("shutdown emits peer-departed for all connected peers", async () => {
      const bridge = new Bridge()
      const exchange1 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })
      const _exchange2 = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })

      await drain()
      expect(exchange1.peers().size).toBe(1)

      const changes: PeerChange[] = []
      exchange1.peers.subscribe(cs => {
        changes.push(...cs.changes)
      })

      // Shutdown alice's own exchange — should emit peer-departed for bob
      await exchange1.shutdown()

      expect(changes.length).toBe(1)
      expect(changes[0].type).toBe("peer-departed")
      expect(changes[0].peer.peerId).toBe("bob")
      expect(exchange1.peers().size).toBe(0)
    })

    it("reset() emits peer-departed for all connected peers", async () => {
      const bridge = new Bridge()
      const exchange1 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })
      const _exchange2 = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })

      await drain()
      expect(exchange1.peers().size).toBe(1)

      const changes: PeerChange[] = []
      exchange1.peers.subscribe(cs => {
        changes.push(...cs.changes)
      })

      // Reset is synchronous — should emit peer-departed for bob
      exchange1.reset()

      expect(changes.length).toBe(1)
      expect(changes[0].type).toBe("peer-departed")
      expect(changes[0].peer.peerId).toBe("bob")
      expect(exchange1.peers().size).toBe(0)
    })

    // -----------------------------------------------------------------------
    // Involuntary disconnect — transport removed without depart
    // -----------------------------------------------------------------------

    it("involuntary disconnect: peer-disconnected fires, peer preserved in peers()", async () => {
      const bridge = new Bridge()
      const exchange1 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })
      const _exchange2 = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })

      await drain()
      expect(exchange1.peers().size).toBe(1)

      const changes: PeerChange[] = []
      exchange1.peers.subscribe(cs => {
        changes.push(...cs.changes)
      })

      // Remove bob's transport — simulates network failure (no depart sent)
      await _exchange2.removeTransport("bob")
      await drain()

      // Alice should see peer-disconnected (not peer-departed)
      expect(changes.length).toBe(1)
      expect(changes[0].type).toBe("peer-disconnected")
      expect(changes[0].peer.peerId).toBe("bob")

      // Bob is still in alice's peer map — connection is not presence
      expect(exchange1.peers().size).toBe(1)
      expect(exchange1.peers().has("bob")).toBe(true)
    })

    it("involuntary disconnect then shutdown: peer-departed fires", async () => {
      const bridge = new Bridge()
      const exchange1 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })
      const exchange2 = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })

      await drain()

      // Involuntary disconnect — remove bob's transport (no depart)
      await exchange2.removeTransport("bob")
      await drain()

      const changes: PeerChange[] = []
      exchange1.peers.subscribe(cs => {
        changes.push(...cs.changes)
      })

      // Alice shuts down — should emit peer-departed for the disconnected bob
      await exchange1.shutdown()

      const departed = changes.filter(c => c.type === "peer-departed")
      expect(departed.length).toBe(1)
      expect(departed[0].peer.peerId).toBe("bob")
      expect(exchange1.peers().size).toBe(0)
    })

    it("reconnection after involuntary disconnect: peer-reconnected fires", async () => {
      const bridge = new Bridge()
      const exchange1 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })
      const exchange2 = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })

      await drain()
      expect(exchange1.peers().size).toBe(1)

      // Involuntary disconnect
      await exchange2.removeTransport("bob")
      await drain()

      const changes: PeerChange[] = []
      exchange1.peers.subscribe(cs => {
        changes.push(...cs.changes)
      })

      // Reconnect — add a new transport on the same bridge
      await exchange2.addTransport(
        new BridgeTransport({ transportId: "bob", bridge }),
      )
      await drain()

      // Alice should see peer-reconnected
      const reconnected = changes.filter(c => c.type === "peer-reconnected")
      expect(reconnected.length).toBe(1)
      expect(reconnected[0].peer.peerId).toBe("bob")

      // Peer still in map (continuously present)
      expect(exchange1.peers().size).toBe(1)
      expect(exchange1.peers().has("bob")).toBe(true)
    })

    it("sync resumes after reconnection", async () => {
      const bridge = new Bridge()
      const exchange1 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })
      const exchange2 = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })

      // Alice creates a doc
      const doc1 = exchange1.get("doc-1", TestDoc)
      batch(doc1, d => {
        d.title.set("hello")
        d.count.set(1)
      })
      await drain()

      // Bob should have the doc
      const doc2 = exchange2.get("doc-1", TestDoc)
      await sync(doc2).waitForSync()
      expect(doc2.title()).toBe("hello")

      // Involuntary disconnect
      await exchange2.removeTransport("bob")
      await drain()

      // Alice mutates while bob is disconnected
      batch(doc1, d => d.count.set(42))
      await drain()

      // Reconnect
      await exchange2.addTransport(
        new BridgeTransport({ transportId: "bob", bridge }),
      )
      await drain()

      // Bob should receive the mutation made during disconnect
      await sync(doc2).waitForSync()
      expect(doc2.count()).toBe(42)
    })

    // -----------------------------------------------------------------------
    // Departure timeout — configurable grace period
    // -----------------------------------------------------------------------

    it("departureTimeout: 0 — involuntary disconnect triggers immediate peer-departed", async () => {
      const bridge = new Bridge()
      const exchange1 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
        departureTimeout: 0,
      })
      const exchange2 = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })

      await drain()
      expect(exchange1.peers().size).toBe(1)

      const changes: PeerChange[] = []
      exchange1.peers.subscribe(cs => {
        changes.push(...cs.changes)
      })

      // Involuntary disconnect — no depart sent
      await exchange2.removeTransport("bob")
      await drain()

      // With timeout=0, alice skips peer-disconnected and goes straight to peer-departed
      expect(changes.length).toBe(1)
      expect(changes[0].type).toBe("peer-departed")
      expect(changes[0].peer.peerId).toBe("bob")
      expect(exchange1.peers().size).toBe(0)
    })

    it("departure timer fires after grace period", async () => {
      vi.useFakeTimers()
      try {
        const bridge = new Bridge()
        const exchange1 = createExchange({
          id: "alice",
          transports: [createBridgeTransport({ transportId: "alice", bridge })],
          departureTimeout: 5_000,
        })
        const exchange2 = createExchange({
          id: "bob",
          transports: [createBridgeTransport({ transportId: "bob", bridge })],
        })

        // Flush zero-delay timers only (microtask rounds) — does NOT advance clock
        await vi.advanceTimersByTimeAsync(0)

        const changes: PeerChange[] = []
        exchange1.peers.subscribe(cs => {
          changes.push(...cs.changes)
        })

        // Involuntary disconnect
        await exchange2.removeTransport("bob")
        // Flush zero-delay timers without advancing the departure timer
        await vi.advanceTimersByTimeAsync(0)

        // Immediately after: peer-disconnected, peer still in map
        expect(changes).toEqual([
          {
            type: "peer-disconnected",
            peer: expect.objectContaining({ peerId: "bob" }),
          },
        ])
        expect(exchange1.peers().size).toBe(1)

        // Now advance clock past the departure timeout
        await vi.advanceTimersByTimeAsync(5_000)

        // peer-departed should have fired
        const departed = changes.filter(c => c.type === "peer-departed")
        expect(departed.length).toBe(1)
        expect(departed[0].peer.peerId).toBe("bob")
        expect(exchange1.peers().size).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it("reconnection before departure timer cancels the timer", async () => {
      vi.useFakeTimers()
      try {
        const bridge = new Bridge()
        const exchange1 = createExchange({
          id: "alice",
          transports: [createBridgeTransport({ transportId: "alice", bridge })],
          departureTimeout: 5_000,
        })
        const exchange2 = createExchange({
          id: "bob",
          transports: [createBridgeTransport({ transportId: "bob", bridge })],
        })

        await vi.advanceTimersByTimeAsync(0)

        const changes: PeerChange[] = []
        exchange1.peers.subscribe(cs => {
          changes.push(...cs.changes)
        })

        // Involuntary disconnect
        await exchange2.removeTransport("bob")
        await vi.advanceTimersByTimeAsync(0)

        expect(changes.at(-1)?.type).toBe("peer-disconnected")

        // Reconnect before the departure timer fires
        await exchange2.addTransport(
          new BridgeTransport({ transportId: "bob", bridge }),
        )
        await vi.advanceTimersByTimeAsync(0)

        expect(changes.at(-1)?.type).toBe("peer-reconnected")

        // Advance well past the original departure timeout
        await vi.advanceTimersByTimeAsync(10_000)

        // No peer-departed should have fired — timer was cancelled
        const departed = changes.filter(c => c.type === "peer-departed")
        expect(departed.length).toBe(0)
        expect(exchange1.peers().size).toBe(1)
        expect(exchange1.peers().has("bob")).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // =========================================================================
  // exchange.replicate() — headless replication
  // =========================================================================

  describe("replicate()", () => {
    it("registers a replicated doc visible via has()", () => {
      const exchange = createExchange()
      exchange.replicate(
        "rep-doc",
        plainReplicaFactory,
        SYNC_AUTHORITATIVE,
        "00test",
      )
      expect(exchange.has("rep-doc")).toBe(true)
    })

    it("replicate() throws if docId already registered via get()", () => {
      const exchange = createExchange()
      exchange.get("doc-1", TestDoc)
      expect(() =>
        exchange.replicate(
          "doc-1",
          plainReplicaFactory,
          SYNC_AUTHORITATIVE,
          "00test",
        ),
      ).toThrow(/already registered/)
    })

    it("replicate() throws if docId already registered via replicate()", () => {
      const exchange = createExchange()
      exchange.replicate(
        "doc-1",
        plainReplicaFactory,
        SYNC_AUTHORITATIVE,
        "00test",
      )
      expect(() =>
        exchange.replicate(
          "doc-1",
          plainReplicaFactory,
          SYNC_AUTHORITATIVE,
          "00test",
        ),
      ).toThrow(/already registered/)
    })

    it("get() throws if docId is registered in replicate mode", () => {
      const exchange = createExchange()
      exchange.replicate(
        "doc-1",
        plainReplicaFactory,
        SYNC_AUTHORITATIVE,
        "00test",
      )
      expect(() => exchange.get("doc-1", TestDoc)).toThrow(/replicate mode/)
    })

    it("destroy() works for replicated docs", () => {
      const exchange = createExchange()
      exchange.replicate(
        "rep-doc",
        plainReplicaFactory,
        SYNC_AUTHORITATIVE,
        "00test",
      )
      expect(exchange.has("rep-doc")).toBe(true)
      exchange.destroy("rep-doc")
      expect(exchange.has("rep-doc")).toBe(false)
    })

    it("has() returns true for both interpret and replicate modes", () => {
      const exchange = createExchange()
      exchange.get("int-doc", TestDoc)
      exchange.replicate(
        "rep-doc",
        plainReplicaFactory,
        SYNC_AUTHORITATIVE,
        "00test",
      )
      expect(exchange.has("int-doc")).toBe(true)
      expect(exchange.has("rep-doc")).toBe(true)
      expect(exchange.has("unknown")).toBe(false)
    })
  })

  // =========================================================================
  // suspend / resume
  // =========================================================================

  describe("suspend / resume", () => {
    it("suspend() keeps doc in cache but removes from sync model", () => {
      const exchange = createExchange()
      exchange.get("doc-1", TestDoc)
      expect(exchange.has("doc-1")).toBe(true)

      exchange.suspend("doc-1")

      // Doc still exists in cache
      expect(exchange.has("doc-1")).toBe(true)
      // But is suspended in documents feed
      expect(exchange.documents.get("doc-1")?.suspended).toBe(true)
    })

    it("exchange.documents emits doc-suspended on suspend", () => {
      const exchange = createExchange()
      exchange.get("doc-1", TestDoc)

      const changes: any[] = []
      exchange.documents.subscribe(cs => changes.push(...cs.changes))

      exchange.suspend("doc-1")

      const suspended = changes.filter((c: any) => c.type === "doc-suspended")
      expect(suspended.length).toBe(1)
      expect(suspended[0].docId).toBe("doc-1")
    })

    it("resume() re-enters sync graph", () => {
      const exchange = createExchange()
      exchange.get("doc-1", TestDoc)
      exchange.suspend("doc-1")

      expect(exchange.documents.get("doc-1")?.suspended).toBe(true)

      exchange.resume("doc-1")

      expect(exchange.documents.get("doc-1")?.suspended).toBe(false)
    })

    it("exchange.documents emits doc-resumed on resume", () => {
      const exchange = createExchange()
      exchange.get("doc-1", TestDoc)
      exchange.suspend("doc-1")

      const changes: any[] = []
      exchange.documents.subscribe(cs => changes.push(...cs.changes))

      exchange.resume("doc-1")

      const resumed = changes.filter((c: any) => c.type === "doc-resumed")
      expect(resumed.length).toBe(1)
      expect(resumed[0].docId).toBe("doc-1")
    })

    it("destroy() after suspend purges all local state", () => {
      const exchange = createExchange()
      exchange.get("doc-1", TestDoc)
      exchange.suspend("doc-1")

      expect(exchange.has("doc-1")).toBe(true)

      exchange.destroy("doc-1")

      expect(exchange.has("doc-1")).toBe(false)
      expect(exchange.documents.has("doc-1")).toBe(false)
    })

    it("get() on suspended doc throws with guidance to call resume()", () => {
      const exchange = createExchange()
      exchange.get("doc-1", TestDoc)
      exchange.suspend("doc-1")

      expect(() => exchange.get("doc-1", TestDoc)).toThrow(/suspended/)
      expect(() => exchange.get("doc-1", TestDoc)).toThrow(/resume/)
    })

    it("suspend() is idempotent", () => {
      const exchange = createExchange()
      exchange.get("doc-1", TestDoc)
      exchange.suspend("doc-1")

      // Second suspend should not throw
      exchange.suspend("doc-1")

      expect(exchange.documents.get("doc-1")?.suspended).toBe(true)
    })

    it("resume() on non-suspended doc throws", () => {
      const exchange = createExchange()
      exchange.get("doc-1", TestDoc)

      expect(() => exchange.resume("doc-1")).toThrow(/not suspended/)
    })

    it("suspend() on deferred doc throws", async () => {
      const bridge = new Bridge()
      const exchangeA = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })
      const exchangeB = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
        resolve: () => Defer(),
      })

      exchangeA.get("deferred-doc", TestDoc)
      await drain()

      expect(exchangeB.deferred.has("deferred-doc")).toBe(true)
      expect(() => exchangeB.suspend("deferred-doc")).toThrow(/deferred/)
    })
  })

  // =========================================================================
  // canConnect
  // =========================================================================

  describe("canConnect", () => {
    it("canConnect returning false prevents peer establishment", async () => {
      const bridge = new Bridge()

      const _exchange1 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })

      const exchange2 = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })
      exchange2.register({
        canConnect: () => false,
      })

      await drain()

      // Alice should NOT see bob as a peer (bob rejected the connection)
      expect(exchange2.peers().size).toBe(0)
    })

    it("canConnect returning undefined defers (default open)", async () => {
      const bridge = new Bridge()

      const _exchange1 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })

      const exchange2 = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })
      exchange2.register({
        canConnect: () => undefined,
      })

      await drain()

      // Undefined = no opinion, default is open
      expect(exchange2.peers().size).toBe(1)
    })
  })

  describe("getPeerFeatures", () => {
    it("returns the peer's advertised features after handshake", async () => {
      const bridge = new Bridge()

      const alice = new Exchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })
      const bob = new Exchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })
      activeExchanges.push(alice, bob)

      await drain()

      // v1 default features: { alias: true } (set by initSession default).
      expect(alice.getPeerFeatures("bob")).toEqual({ alias: true })
      expect(bob.getPeerFeatures("alice")).toEqual({ alias: true })
    })

    it("returns undefined for a peer that has not established yet", () => {
      const bridge = new Bridge()
      const alice = new Exchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })
      activeExchanges.push(alice)
      expect(alice.getPeerFeatures("bob")).toBeUndefined()
    })
  })

  // =========================================================================
  // Incarnated PlainVersion — writer restart with no persisted store
  // =========================================================================

  describe("writer restart (incarnated PlainVersion)", () => {
    it("a same-peerId writer that restarts with no persisted store still delivers its writes", async () => {
      const bridge = new Bridge()

      // ── "Session 1" ── alice writes, bob syncs and caches sync state.
      const aliceSession1 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice-1", bridge })],
      })
      const bob = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })

      const docA1 = aliceSession1.get("shared-doc", TestDoc)
      batch(docA1, d => {
        d.title.set("from session 1")
        d.count.set(1)
      })
      await drain()

      const docB = bob.get("shared-doc", TestDoc)
      await sync(docB).waitForSync()
      expect(docB.title()).toBe("from session 1")

      // ── Involuntary disconnect ── no depart, so bob's cached sync state for
      // alice survives (this is the scenario that exposes the bug: a bare
      // version comparison would see the restarted writer's fresh version
      // as "behind", not as a different lineage).
      await aliceSession1.removeTransport("alice-1")
      await drain()

      // ── "Session 2" ── same peerId, brand-new Exchange (no persisted store),
      // mirroring a real browser refresh. This mints a fresh substrate at
      // DEFAULT_INCARNATION for "shared-doc", independent of session 1's.
      const aliceSession2 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice-2", bridge })],
      })
      const docA2 = aliceSession2.get("shared-doc", TestDoc)
      await drain()

      // The restarted writer produces new state.
      batch(docA2, d => {
        d.title.set("from session 2")
        d.count.set(2)
      })
      await drain()

      // Bob must receive it: "concurrent" version comparison (cross-incarnation)
      // → gap → entirety fallback → canReset epoch-boundary accept → merge with
      // incarnation adoption → subsequent comparisons match.
      await sync(docB).waitForSync()
      expect(docB.title()).toBe("from session 2")
      expect(docB.count()).toBe(2)

      // Further writes from session 2 continue to sync normally — proving the
      // adopted incarnation is stable, not a one-shot fluke.
      batch(docA2, d => d.count.set(3))
      await drain()
      await sync(docB).waitForSync()
      expect(docB.count()).toBe(3)
    })

    it("subsequent writes after restart are delivered even when the receiver's version was inflated by many pre-restart writes", async () => {
      // This test reproduces the production bug where a long-lived server's
      // cached version of a client's doc (from many exchanges in session 1)
      // inflates beyond the client's fresh version after restart. The epoch
      // boundary merge adds 1 to the server's version but carries over the
      // old flush count. If the old flush count was high (e.g. 10+), the
      // server's post-epoch version (11+) is far above the client's fresh
      // version (2), and all subsequent offers are classified as "behind".
      const bridge = new Bridge()

      // ── Session 1: many writes to inflate Bob's version ──
      const alice1 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice-1", bridge })],
      })
      const bob = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
      })

      const docA1 = alice1.get("inflated-doc", TestDoc)
      const docB = bob.get("inflated-doc", TestDoc)

      // Write many times to inflate the version
      for (let i = 0; i < 10; i++) {
        batch(docA1, d => d.count.set(i))
      }
      await drain()
      await sync(docB).waitForSync()
      expect(docB.count()).toBe(9)

      // ── Restart alice ──
      await alice1.removeTransport("alice-1")
      await drain()

      const alice2 = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice-2", bridge })],
      })
      const docA2 = alice2.get("inflated-doc", TestDoc)
      await drain()

      // First write after restart — should arrive via epoch boundary
      batch(docA2, d => {
        d.title.set("from session 2")
        d.count.set(100)
      })
      await drain()
      await sync(docB).waitForSync()
      expect(docB.title()).toBe("from session 2")

      // Second write after restart — this is where the bug manifests
      // if the server's inflated version blocks the sync.
      const bobVBefore = (docB as any)[Symbol.for("kyneta:substrate")]
        .version()
        .serialize()
      batch(docA2, d => d.count.set(200))
      const aliceVAfter = (docA2 as any)[Symbol.for("kyneta:substrate")]
        .version()
        .serialize()
      console.log("DIAG inflated:", { bobVBefore, aliceVAfter })
      await drain()
      await sync(docB).waitForSync()
      const bobVAfter = (docB as any)[Symbol.for("kyneta:substrate")]
        .version()
        .serialize()
      console.log("DIAG inflated result:", {
        bobVAfter,
        bobCount: docB.count(),
      })
      expect(docB.count()).toBe(200)
    })

    it("Line RPC: second request after restart is delivered (production repro)", async () => {
      // Production scenario: a Line RPC where the client sends a request,
      // gets a response, then restarts. After restart, the FIRST request
      // arrives via epoch boundary, but the SECOND request (the LLM host's
      // credential call) times out because the server's version is inflated.
      //
      // This test isolates the issue by using Line.protocol + a simple
      // echo handler, matching the voice-credentials RPC topology.
      //
      // Regression coverage (jj:5e9e318542ee2006ccb720fd4ec9f819): a stale
      // steady-state push crossing the epoch boundary as a `kind: "since"`
      // payload used to crash resetFromEntirety ("expects a JSON entirety
      // payload") and silently drop the offer. Spy on console.warn/error to
      // assert that failure mode no longer occurs.
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      const { Line } = await import("../line.js")

      const bridge = new Bridge()
      const serverExchange = createExchange({
        id: "server",
        transports: [createBridgeTransport({ transportId: "server", bridge })],
      })

      // Simple echo protocol
      const EchoProto = Line.protocol({
        topic: "echo",
        schema: Schema.struct({ value: Schema.number() }),
      })

      // Server listens and echoes
      const received: number[] = []
      const listener = EchoProto.listen(serverExchange)
      listener.onReceive((sender, receiver) => {
        void (async () => {
          for await (const msg of receiver) {
            received.push(msg.value)
            sender.send({ value: msg.value })
          }
        })()
      })

      // ── Session 1: client sends, server echoes, client receives ──
      const client1 = createExchange({
        id: "client",
        transports: [
          createBridgeTransport({ transportId: "client-1", bridge }),
        ],
      })

      // Do many request/response cycles to inflate versions
      const sender1 = EchoProto.sender(client1, "server")
      const receiver1 = EchoProto.claimReceiver(client1, "server")
      const responses1: number[] = []
      void (async () => {
        for await (const msg of receiver1) responses1.push(msg.value)
      })()

      for (let i = 0; i < 5; i++) {
        sender1.send({ value: i })
        await drain()
      }
      expect(responses1.length).toBeGreaterThanOrEqual(1)

      sender1.close()
      receiver1.close()

      // ── Restart client ──
      await client1.removeTransport("client-1")
      await drain()

      const client2 = createExchange({
        id: "client",
        transports: [
          createBridgeTransport({ transportId: "client-2", bridge }),
        ],
      })
      await drain()

      const sender2 = EchoProto.sender(client2, "server")
      const receiver2 = EchoProto.claimReceiver(client2, "server")
      const responses2: number[] = []
      void (async () => {
        for await (const msg of receiver2) responses2.push(msg.value)
      })()

      // First request after restart
      sender2.send({ value: 100 })
      await drain(40)

      // Second request after restart — this is where the bug manifests
      sender2.send({ value: 200 })
      await drain(40)

      // Both requests should be received by the server
      expect(received).toContain(100)
      expect(received).toContain(200)

      // The crash symptom never occurs: no "epoch boundary reset failed"
      // warning, and no offer silently dropped via that path.
      const allWarnings = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .map(args => String(args[0]))
        .join("\n")
      expect(allWarnings).not.toContain("epoch boundary reset failed")

      warnSpy.mockRestore()
      errorSpy.mockRestore()

      sender2.close()
      receiver2.close()
    })

    it("double-mount race (same peerId, two concurrent client Exchanges — StrictMode/HMR): epoch boundary crash is recovered, not thrown (production repro)", async () => {
      // Production repro (jj:5e9e318542ee2006ccb720fd4ec9f819): the actual
      // trigger observed in production is TWO client Exchange instances
      // sharing the same peerId connecting concurrently (e.g. React
      // StrictMode's double-invoke, or an HMR reload racing the previous
      // module instance's teardown) — not a clean sequential restart.
      // Each instance mints its own epoch; cross-traffic between them
      // causes the server's cached epoch for this peerId to whiplash
      // between the two, so a steady-state `since`-kind push from one
      // instance can arrive while the server's local epoch reflects the
      // other. Confirmed to reproduce the exact production stack trace
      // (`PlainSubstrate.resetFromEntirety expects a JSON entirety
      // payload`) when the synchronizer's guard is removed.
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
      const { Line } = await import("../line.js")

      const RealProto = Line.protocol({
        topic: "voice-credentials-v2",
        schema: Schema.struct({
          id: Schema.string(),
          request: Schema.boolean(),
        }),
      })

      const bridge = new Bridge()
      const server = createExchange({
        id: "loomi-server",
        transports: [createBridgeTransport({ transportId: "server", bridge })],
      })
      const serverReceived: Array<{ id: string; request: boolean }> = []
      const listener = RealProto.listen(server)
      listener.onReceive((_sender, receiver) => {
        void (async () => {
          for await (const msg of receiver) serverReceived.push(msg)
        })()
      })

      // Client "instance 1" mounts.
      const client1 = createExchange({
        id: "87f8ec6c3fb92285",
        transports: [
          createBridgeTransport({ transportId: "client-1", bridge }),
        ],
      })
      const sender1 = RealProto.sender(client1, "loomi-server")
      sender1.send({ id: "req-1", request: true })

      // Client "instance 2" mounts with the SAME peerId almost immediately
      // (StrictMode/HMR double-invoke) — no drain, no clean teardown of
      // instance 1 in between.
      const client2 = createExchange({
        id: "87f8ec6c3fb92285",
        transports: [
          createBridgeTransport({ transportId: "client-2", bridge }),
        ],
      })
      const sender2 = RealProto.sender(client2, "loomi-server")
      sender2.send({ id: "req-2", request: true })

      await drain(60)

      // Both requests still arrive — the epoch-boundary guard recovers via
      // a fresh interest/entirety round-trip rather than crashing and
      // dropping the offer.
      const ids = serverReceived.map(m => m.id)
      expect(ids).toContain("req-1")
      expect(ids).toContain("req-2")

      const allWarnings = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .map(args => String(args[0]))
        .join("\n")
      expect(allWarnings).not.toContain("epoch boundary reset failed")

      warnSpy.mockRestore()
      errorSpy.mockRestore()

      sender1.close()
      sender2.close()
    })
  })
})
