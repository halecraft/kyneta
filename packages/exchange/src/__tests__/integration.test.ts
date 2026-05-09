// Integration tests — two-peer sync for all three sync protocols.
//
// These tests prove documents converge across two Exchange instances
// connected via BridgeTransport, for each sync protocol:
// - Authoritative (PlainSubstrate via json.bind)
// - Collaborative (LoroSubstrate via loro.bind)
// - Ephemeral (TimestampVersion via ephemeral.bind)
// - Heterogeneous (mixed substrates in one exchange)

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { loro } from "@kyneta/loro-schema"
import {
  change,
  Defer,
  ephemeral,
  Interpret,
  json,
  Reject,
  Replicate,
  Schema,
} from "@kyneta/schema"
import { cborCodec } from "@kyneta/wire"
import { yjs } from "@kyneta/yjs-schema"
import { afterEach, describe, expect, it } from "vitest"
import {
  Exchange,
  type ExchangeParams,
  type PeerIdentityInput,
} from "../exchange.js"
import { sync } from "../sync.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Drain microtask queue — necessary for BridgeTransport async delivery.
 * We do multiple rounds because messages trigger responses which trigger
 * more async deliveries.
 */
async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    // Also yield to promise queue
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

/** Active exchanges that need cleanup */
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
      // ignore
    }
  }
  activeExchanges.length = 0
})

// ---------------------------------------------------------------------------
// Bound schemas (module scope)
// ---------------------------------------------------------------------------

const sequentialSchema = Schema.struct({
  title: Schema.string(),
  count: Schema.number(),
})
const SequentialDoc = json.bind(sequentialSchema)

const loroSchema = Schema.struct({
  title: Schema.text(),
  items: Schema.list(Schema.struct.json({ name: Schema.string() })),
})
const LoroDoc = loro.bind(loroSchema)

const presenceSchema = Schema.struct({
  cursor: Schema.struct({
    x: Schema.number(),
    y: Schema.number(),
  }),
  name: Schema.string(),
})
const PresenceDoc = ephemeral.bind(presenceSchema)

const yjsTextSchema = Schema.struct({
  title: Schema.text(),
})
const YjsDoc = yjs.bind(yjsTextSchema)

// ---------------------------------------------------------------------------
// Authoritative (PlainSubstrate) — two-peer sync
// ---------------------------------------------------------------------------

describe("Authoritative sync (PlainSubstrate)", () => {
  it("peer A creates doc, peer B syncs and gets the same state", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })

    // Alice creates a doc and populates via change()
    const docA = exchangeA.get("doc-1", SequentialDoc)
    change(docA, (d: any) => {
      d.title.set("Hello from Alice")
      d.count.set(42)
    })

    expect(docA.title()).toBe("Hello from Alice")
    expect(docA.count()).toBe(42)

    // Bob creates the same doc (empty initially)
    const docB = exchangeB.get("doc-1", SequentialDoc)

    // Wait for sync
    await drain()

    // After sync, Bob should have Alice's state
    expect(docB.title()).toBe("Hello from Alice")
    expect(docB.count()).toBe(42)
  })

  it("mutations propagate from A to B after initial sync", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })

    const docA = exchangeA.get("doc-1", SequentialDoc)
    change(docA, (d: any) => {
      d.title.set("V1")
      d.count.set(1)
    })
    const docB = exchangeB.get("doc-1", SequentialDoc)

    // Initial sync
    await drain()
    expect(docB.title()).toBe("V1")

    // Alice mutates
    change(docA, (d: any) => {
      d.title.set("V2")
      d.count.set(2)
    })

    await drain()

    // Bob should see the mutation
    expect(docB.title()).toBe("V2")
    expect(docB.count()).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Collaborative (LoroSubstrate) — two-peer CRDT sync
// ---------------------------------------------------------------------------

describe("Collaborative sync (LoroSubstrate)", () => {
  it("peer A creates doc with text, peer B syncs and gets the same state", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [LoroDoc],
    })

    // Alice creates a doc
    const docA = exchangeA.get("doc-1", LoroDoc)

    // Insert text
    change(docA, (d: any) => {
      d.title.insert(0, "Hello CRDT")
    })

    // Bob creates the same doc
    const docB = exchangeB.get("doc-1", LoroDoc)

    await drain()

    // Bob should have Alice's text
    expect(docB.title()).toBe("Hello CRDT")
  })

  it("concurrent edits from both peers converge", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [LoroDoc],
    })

    // Both create the doc
    const docA = exchangeA.get("doc-1", LoroDoc)
    const docB = exchangeB.get("doc-1", LoroDoc)

    // Initial sync
    await drain()

    // Both insert concurrently
    change(docA, (d: any) => {
      d.title.insert(0, "Alice")
    })

    change(docB, (d: any) => {
      d.title.insert(0, "Bob")
    })

    // Let sync happen
    await drain()

    // Both should converge to the same value (CRDT merge)
    const valueA = docA.title()
    const valueB = docB.title()
    expect(valueA).toBe(valueB)
    // Both "Alice" and "Bob" should appear in the merged text
    expect(valueA).toContain("Alice")
    expect(valueA).toContain("Bob")
  })
})

// ---------------------------------------------------------------------------
// Collaborative (YjsSubstrate) — delete sync regression
// ---------------------------------------------------------------------------

describe("Collaborative sync: Yjs delete propagation", () => {
  it("text delete syncs from peer A to peer B", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [YjsDoc],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [YjsDoc],
    })

    const docA = exchangeA.get("doc-1", YjsDoc)
    const docB = exchangeB.get("doc-1", YjsDoc)

    // Seed text and sync
    change(docA, (d: any) => {
      d.title.insert(0, "hello")
    })
    await drain()
    expect(docB.title()).toBe("hello")

    // Delete a character — this must sync to peer B.
    // Before the fix, Yjs's state vector did not advance on delete,
    // so the sync protocol saw "no gap" and skipped the push.
    change(docA, (d: any) => {
      d.title.delete(1, 1)
    })
    await drain()

    expect(docA.title()).toBe("hllo")
    expect(docB.title()).toBe("hllo")
  })

  it("bidirectional deletes converge", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [YjsDoc],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [YjsDoc],
    })

    const docA = exchangeA.get("doc-1", YjsDoc)
    const docB = exchangeB.get("doc-1", YjsDoc)

    change(docA, (d: any) => {
      d.title.insert(0, "abcd")
    })
    await drain()
    expect(docB.title()).toBe("abcd")

    // Alice deletes first char, Bob deletes last char — concurrently
    change(docA, (d: any) => {
      d.title.delete(0, 1)
    })
    change(docB, (d: any) => {
      d.title.delete(3, 1)
    })
    await drain()

    // Both should converge to "bc"
    expect(docA.title()).toBe(docB.title())
    expect(docA.title()).toBe("bc")
  })
})

// ---------------------------------------------------------------------------
// Ephemeral (Ephemeral/Presence) — broadcast sync
// ---------------------------------------------------------------------------

describe("Ephemeral sync (Ephemeral/Presence)", () => {
  it("peer A sets presence, peer B receives via broadcast", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })

    // Alice sets presence with change() so the version bumps
    const presA = exchangeA.get("presence", PresenceDoc)

    change(presA, (d: any) => {
      d.cursor.x.set(100)
      d.cursor.y.set(200)
      d.name.set("Alice")
    })

    // Bob creates the same presence doc
    const presB = exchangeB.get("presence", PresenceDoc)

    await drain()

    // Bob should have Alice's presence
    expect(presB.name()).toBe("Alice")
    expect(presB.cursor.x()).toBe(100)
    expect(presB.cursor.y()).toBe(200)
  })

  it("updates propagate via ephemeral broadcast", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })

    const presA = exchangeA.get("presence", PresenceDoc)
    const presB = exchangeB.get("presence", PresenceDoc)

    // Set initial values via change() so version bumps
    change(presA, (d: any) => {
      d.cursor.x.set(0)
      d.cursor.y.set(0)
      d.name.set("Alice")
    })

    await drain()
    expect(presB.name()).toBe("Alice")

    // Alice moves cursor
    change(presA, (d: any) => {
      d.cursor.x.set(500)
      d.cursor.y.set(600)
    })

    await drain()

    // Bob sees updated cursor
    expect(presB.cursor.x()).toBe(500)
    expect(presB.cursor.y()).toBe(600)
  })
})

// ---------------------------------------------------------------------------
// Heterogeneous — mixed substrates in one exchange
// ---------------------------------------------------------------------------

describe("Heterogeneous documents", () => {
  it("one exchange hosts both authoritative and collaborative docs, both sync", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const plainSchema = Schema.struct({
      config: Schema.string(),
    })
    const ConfigDoc = json.bind(plainSchema)

    const collabSchema = Schema.struct({
      text: Schema.text(),
    })
    const CollabDoc = loro.bind(collabSchema)

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [CollabDoc],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [CollabDoc],
    })

    // Alice: plain config doc
    const configA = exchangeA.get("config", ConfigDoc)
    change(configA, (d: any) => {
      d.config.set("dark-mode")
    })

    // Alice: loro collaborative doc
    const textA = exchangeA.get("collab", CollabDoc)
    change(textA, (d: any) => {
      d.text.insert(0, "collaborative text")
    })
    // Bob: create both docs
    const configB = exchangeB.get("config", ConfigDoc)
    const textB = exchangeB.get("collab", CollabDoc)

    await drain()

    // Both docs should sync
    expect(configB.config()).toBe("dark-mode")
    expect(textB.text()).toBe("collaborative text")
  })
})

// ---------------------------------------------------------------------------
// Multi-hop relay — three-peer topology (A ↔ Hub ↔ B)
// ---------------------------------------------------------------------------

describe("Multi-hop relay (three-peer topology)", () => {
  it("collaborative: mutation on A propagates through Hub to B", async () => {
    // Two separate bridges: Alice↔Hub and Hub↔Bob
    const bridgeAH = new Bridge({ codec: cborCodec })
    const bridgeHB = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [
        createBridgeTransport({ transportId: "alice", bridge: bridgeAH }),
      ],
      schemas: [LoroDoc],
    })

    const exchangeHub = createExchange({
      id: "hub",
      transports: [
        createBridgeTransport({ transportId: "hub-a", bridge: bridgeAH }),
        createBridgeTransport({ transportId: "hub-b", bridge: bridgeHB }),
      ],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [
        createBridgeTransport({ transportId: "bob", bridge: bridgeHB }),
      ],
      schemas: [LoroDoc],
    })

    // All three open the same doc
    const docA = exchangeA.get("doc-1", LoroDoc)
    const docHub = exchangeHub.get("doc-1", LoroDoc)
    const docB = exchangeB.get("doc-1", LoroDoc)

    // Let initial handshakes settle
    await drain()

    // Alice inserts text
    change(docA, (d: any) => {
      d.title.insert(0, "hello from alice")
    })

    // Drain enough rounds for A→Hub→B relay
    await drain(40)

    // Hub should have Alice's text (direct peer)
    expect(docHub.title()).toBe("hello from alice")
    // Bob should have Alice's text (relayed through Hub)
    expect(docB.title()).toBe("hello from alice")
  })

  it("authoritative: mutation on A propagates through Hub to B", async () => {
    const bridgeAH = new Bridge({ codec: cborCodec })
    const bridgeHB = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [
        createBridgeTransport({ transportId: "alice", bridge: bridgeAH }),
      ],
    })

    const exchangeHub = createExchange({
      id: "hub",
      transports: [
        createBridgeTransport({ transportId: "hub-a", bridge: bridgeAH }),
        createBridgeTransport({ transportId: "hub-b", bridge: bridgeHB }),
      ],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [
        createBridgeTransport({ transportId: "bob", bridge: bridgeHB }),
      ],
    })

    // Hub creates the doc with initial state (authoritative needs a populated source)
    const docHub = exchangeHub.get("doc-1", SequentialDoc)
    change(docHub, (d: any) => {
      d.title.set("initial")
      d.count.set(0)
    })

    const docA = exchangeA.get("doc-1", SequentialDoc)
    const docB = exchangeB.get("doc-1", SequentialDoc)

    // Let initial sync settle
    await drain(40)

    expect(docA.title()).toBe("initial")
    expect(docB.title()).toBe("initial")

    // Alice mutates
    change(docA, (d: any) => {
      d.title.set("updated by alice")
      d.count.set(99)
    })

    // Drain for A→Hub→B relay
    await drain(40)

    // Hub should have Alice's mutation
    expect(docHub.title()).toBe("updated by alice")
    expect(docHub.count()).toBe(99)
    // Bob should have Alice's mutation (relayed through Hub)
    expect(docB.title()).toBe("updated by alice")
    expect(docB.count()).toBe(99)
  })
})

// ---------------------------------------------------------------------------
// resolve — dynamic document creation
// ---------------------------------------------------------------------------

describe("resolve (dynamic document creation)", () => {
  it("peer A creates doc, peer B materializes it via resolve", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      resolve: (docId: string) => {
        if (docId === "dynamic-doc") return Interpret(SequentialDoc)
        return undefined
      },
    })

    // Alice creates a doc that Bob doesn't have yet
    const docA = exchangeA.get("dynamic-doc", SequentialDoc)
    change(docA, (d: any) => {
      d.title.set("created by alice")
      d.count.set(7)
    })

    // Drain — present → ensure-doc → callback → doc-ensure → present → interest → offer
    await drain(40)

    // Bob should now have the doc with Alice's content
    expect(exchangeB.has("dynamic-doc")).toBe(true)
    const docB = exchangeB.get("dynamic-doc", SequentialDoc)
    expect(docB.title()).toBe("created by alice")
    expect(docB.count()).toBe(7)
  })

  it("resolve returning Reject() does not create the doc", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      resolve: () => Reject(),
    })

    exchangeA.get("ignored-doc", SequentialDoc)

    await drain(40)

    expect(exchangeB.has("ignored-doc")).toBe(false)
  })

  it("ephemeral dynamic doc syncs correctly", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      resolve: docId => {
        if (docId === "presence") return Interpret(PresenceDoc)
        return Reject()
      },
    })

    // Alice creates an ephemeral doc
    const presA = exchangeA.get("presence", PresenceDoc)
    change(presA, (d: any) => {
      d.cursor.x.set(100)
      d.cursor.y.set(200)
      d.name.set("Alice")
    })

    await drain(40)

    // Bob should have Alice's presence
    expect(exchangeB.has("presence")).toBe(true)
    const presB = exchangeB.get("presence", PresenceDoc)
    expect(presB.name()).toBe("Alice")
    expect(presB.cursor.x()).toBe(100)
    expect(presB.cursor.y()).toBe(200)

    // Alice updates — ephemeral broadcasts snapshot
    change(presA, (d: any) => {
      d.cursor.x.set(500)
      d.cursor.y.set(600)
    })

    await drain(40)

    expect(presB.cursor.x()).toBe(500)
    expect(presB.cursor.y()).toBe(600)
  })
})

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// canShare predicate
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

describe("canShare predicate", () => {
  it("canShare prevents document announcement", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      canShare: docId => docId !== "secret",
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })

    // Alice creates doc that bob shouldn't see
    exchangeA.get("secret", SequentialDoc)

    await drain(40)

    expect(exchangeB.has("secret")).toBe(false)
  })

  it("canShare prevents relay in three-peer topology", async () => {
    const bridgeAH = new Bridge({ codec: cborCodec })
    const bridgeHB = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [
        createBridgeTransport({ transportId: "alice", bridge: bridgeAH }),
      ],
    })

    const exchangeHub = createExchange({
      id: "hub",
      transports: [
        createBridgeTransport({ transportId: "hub-a", bridge: bridgeAH }),
        createBridgeTransport({ transportId: "hub-b", bridge: bridgeHB }),
      ],
      canShare: (docId, peer) => {
        if (docId === "private-doc" && peer.peerId === "bob") return false
        return true
      },
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [
        createBridgeTransport({ transportId: "bob", bridge: bridgeHB }),
      ],
    })

    // Hub creates doc
    const docHub = exchangeHub.get("private-doc", SequentialDoc)
    change(docHub, (d: any) => {
      d.title.set("hub data")
      d.count.set(42)
    })

    // Alice creates same doc
    const docA = exchangeA.get("private-doc", SequentialDoc)

    await drain(40)

    // Alice (allowed) should have the data
    expect(docA.title()).toBe("hub data")

    // Bob (denied) should not have the doc
    expect(exchangeB.has("private-doc")).toBe(false)
  })
})

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// canAccept predicate
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

describe("canAccept predicate", () => {
  it("canAccept rejects offer — doc content unchanged", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      canAccept: () => false,
    })

    const docA = exchangeA.get("doc-1", SequentialDoc)
    const docB = exchangeB.get("doc-1", SequentialDoc)

    change(docA, (d: any) => {
      d.title.set("from alice")
      d.count.set(99)
    })

    await drain(40)

    // Bob's doc should remain at defaults (canAccept rejected the offer)
    expect(docB.title()).toBe("")
    expect(docB.count()).toBe(0)
  })
})

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// Destroy
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

describe("destroy", () => {
  it("destroy removes doc locally and stops sync", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })

    exchangeA.get("doc-1", SequentialDoc)
    const docB = exchangeB.get("doc-1", SequentialDoc)

    await drain(40)

    // Alice destroys — doc should be removed locally
    exchangeA.destroy("doc-1")
    expect(exchangeA.has("doc-1")).toBe(false)

    // Bob writes
    change(docB, (d: any) => {
      d.title.set("bob update")
    })

    await drain(40)

    // Alice should NOT re-acquire the doc
    expect(exchangeA.has("doc-1")).toBe(false)
  })
})

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// canShare + resolve interaction
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

describe("canShare + resolve interaction", () => {
  it("canShare denying a peer prevents resolve from firing", async () => {
    const bridge = new Bridge({ codec: cborCodec })
    let discoveredCallCount = 0

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      canShare: docId => docId !== "blocked-doc",
      resolve: docId => {
        discoveredCallCount++
        if (docId === "blocked-doc") return Interpret(SequentialDoc)
        return Reject()
      },
    })

    // Alice creates the doc
    exchangeA.get("blocked-doc", SequentialDoc)

    await drain(40)

    // Bob's resolve should never have fired (canShare blocked it)
    expect(discoveredCallCount).toBe(0)
    expect(exchangeB.has("blocked-doc")).toBe(false)
  })
})

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// Relay via exchange.replicate() — schema-free relay tests
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

describe("relay via exchange.replicate()", () => {
  it("collaborative doc syncs through a schema-free relay: peer A → relay → peer B", async () => {
    const bridgeAR = new Bridge({ codec: cborCodec })
    const bridgeRB = new Bridge({ codec: cborCodec })

    // Peer A — full interpreter
    const exchangeA = createExchange({
      id: "alice",
      transports: [
        createBridgeTransport({ transportId: "alice", bridge: bridgeAR }),
      ],
      schemas: [LoroDoc],
    })

    const relay = createExchange({
      id: "relay",
      transports: [
        createBridgeTransport({ transportId: "relay-a", bridge: bridgeAR }),
        createBridgeTransport({ transportId: "relay-b", bridge: bridgeRB }),
      ],
      replicas: [loro.replica()],
      resolve: () => Replicate(),
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [
        createBridgeTransport({ transportId: "bob", bridge: bridgeRB }),
      ],
      schemas: [LoroDoc],
      resolve: (docId: string) => {
        if (docId === "doc-1") return Interpret(LoroDoc)
        return undefined
      },
    })

    // Alice creates the doc and writes
    const docA = exchangeA.get("shared", LoroDoc)
    change(docA, (d: any) => {
      d.title.insert(0, "Hello from Alice")
    })

    await drain(60)

    // Relay should have the doc (replicated)
    expect(relay.has("shared")).toBe(true)

    // Bob should have the doc (interpreted) with Alice's content
    expect(exchangeB.has("shared")).toBe(true)
    const docB = exchangeB.get("shared", LoroDoc)
    expect(docB.title()).toBe("Hello from Alice")
  })

  it("authoritative doc syncs through a schema-free relay", async () => {
    const bridgeAR = new Bridge({ codec: cborCodec })
    const bridgeRB = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [
        createBridgeTransport({ transportId: "alice", bridge: bridgeAR }),
      ],
    })

    const relay = createExchange({
      id: "relay",
      transports: [
        createBridgeTransport({ transportId: "relay-a", bridge: bridgeAR }),
        createBridgeTransport({ transportId: "relay-b", bridge: bridgeRB }),
      ],
      resolve: () => Replicate(),
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [
        createBridgeTransport({ transportId: "bob", bridge: bridgeRB }),
      ],
      resolve: docId => {
        if (docId === "config") return Interpret(SequentialDoc)
        return Reject()
      },
    })

    const docA = exchangeA.get("config", SequentialDoc)
    change(docA, (d: any) => {
      d.title.set("Config Value")
      d.count.set(42)
    })

    await drain(60)

    expect(relay.has("config")).toBe(true)
    expect(exchangeB.has("config")).toBe(true)
    const docB = exchangeB.get("config", SequentialDoc)
    expect(docB.title()).toBe("Config Value")
    expect(docB.count()).toBe(42)
  })

  it("ephemeral doc syncs through a schema-free relay", async () => {
    const bridgeAR = new Bridge({ codec: cborCodec })
    const bridgeRB = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [
        createBridgeTransport({ transportId: "alice", bridge: bridgeAR }),
      ],
    })

    const relay = createExchange({
      id: "relay",
      transports: [
        createBridgeTransport({ transportId: "relay-a", bridge: bridgeAR }),
        createBridgeTransport({ transportId: "relay-b", bridge: bridgeRB }),
      ],
      resolve: () => Replicate(),
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [
        createBridgeTransport({ transportId: "bob", bridge: bridgeRB }),
      ],
      resolve: docId => {
        if (docId === "presence") return Interpret(PresenceDoc)
        return Reject()
      },
    })

    const docA = exchangeA.get("presence", PresenceDoc)
    change(docA, (d: any) => {
      d.cursor.x.set(100)
      d.cursor.y.set(200)
      d.name.set("Alice")
    })

    await drain(60)

    expect(relay.has("presence")).toBe(true)
    expect(exchangeB.has("presence")).toBe(true)
    const docB = exchangeB.get("presence", PresenceDoc)
    expect(docB.cursor.x()).toBe(100)
    expect(docB.cursor.y()).toBe(200)
    expect(docB.name()).toBe("Alice")
  })

  it("resolve returning Replicate() creates replicated doc from peer discovery", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [LoroDoc],
    })

    let discoveredDocId: string | null = null
    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      replicas: [loro.replica()],
      resolve: (docId: string) => {
        discoveredDocId = docId
        return Replicate()
      },
    })

    // Alice creates a doc
    exchangeA.get("test-doc", LoroDoc)

    await drain(40)

    // Bob should have discovered and replicated the doc
    expect(discoveredDocId).toBe("test-doc")
    expect(exchangeB.has("test-doc")).toBe(true)
  })

  it("late-joiner via relay: peer A pushes, peer B connects later, relay serves B", async () => {
    const bridgeAR = new Bridge({ codec: cborCodec })

    // Phase 1: Alice connects to relay, writes data
    const exchangeA = createExchange({
      id: "alice",
      transports: [
        createBridgeTransport({ transportId: "alice", bridge: bridgeAR }),
      ],
      schemas: [LoroDoc],
    })

    const relay = createExchange({
      id: "relay",
      transports: [
        createBridgeTransport({ transportId: "relay-a", bridge: bridgeAR }),
      ],
      replicas: [loro.replica()],
      resolve: () => Replicate(),
    })

    const docA = exchangeA.get("shared", LoroDoc)
    change(docA, (d: any) => {
      d.title.insert(0, "Written before Bob joined")
    })

    await drain(60)

    // Relay should have accumulated Alice's state
    expect(relay.has("shared")).toBe(true)

    // Phase 2: Bob connects to relay AFTER Alice wrote
    const bridgeRB = new Bridge({ codec: cborCodec })
    await relay.addTransport(
      createBridgeTransport({ transportId: "relay-b", bridge: bridgeRB })(),
    )

    const exchangeB = createExchange({
      id: "bob",
      transports: [
        createBridgeTransport({ transportId: "bob", bridge: bridgeRB }),
      ],
      schemas: [LoroDoc],
      resolve: docId => {
        if (docId === "shared") return Interpret(LoroDoc)
        return Reject()
      },
    })

    await drain(60)

    // Bob should have received Alice's content via the relay
    expect(exchangeB.has("shared")).toBe(true)
    const docB = exchangeB.get("shared", LoroDoc)
    expect(docB.title()).toBe("Written before Bob joined")
  })

  it("mixed dispositions: one exchange with interpreted + replicated docs", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [SequentialDoc],
      replicas: [loro.replica()],
      resolve: docId => {
        // Interpret some docs, replicate others
        if (docId === "app-doc") return Interpret(SequentialDoc)
        if (docId === "relay-doc") return Replicate()
        return Reject()
      },
    })

    // Alice creates both docs
    const appDoc = exchangeA.get("app-doc", SequentialDoc)
    const loroDoc = exchangeA.get("relay-doc", LoroDoc)

    change(appDoc, (d: any) => {
      d.title.set("App Data")
      d.count.set(7)
    })
    change(loroDoc, (d: any) => {
      d.title.insert(0, "Loro Data")
    })

    await drain(60)

    // Bob should have both docs
    expect(exchangeB.has("app-doc")).toBe(true)
    expect(exchangeB.has("relay-doc")).toBe(true)

    // The interpreted doc should be readable
    const bobAppDoc = exchangeB.get("app-doc", SequentialDoc)
    expect(bobAppDoc.title()).toBe("App Data")
    expect(bobAppDoc.count()).toBe(7)

    // The replicated doc should exist but not be gettable as interpreted
    expect(() => exchangeB.get("relay-doc", LoroDoc)).toThrow(/replicate mode/)
  })

  it("nested authoritative doc relays through schema-free node", async () => {
    // Three-exchange topology: Alice (Interpret) → Relay (Replicate) → Bob (Interpret)
    // The doc has nested structure (list of structs) — validates that the
    // append-log replica + init ops fix works end-to-end through a relay.
    // Context: jj:oyouvrss (Phase 4 — general integration test)
    const bridgeAR = new Bridge({ codec: cborCodec })
    const bridgeRB = new Bridge({ codec: cborCodec })

    const nestedSchema = Schema.struct({
      title: Schema.string(),
      items: Schema.list(
        Schema.struct({
          name: Schema.string(),
          done: Schema.boolean(),
        }),
      ),
      count: Schema.number(),
    })
    const NestedDoc = json.bind(nestedSchema)

    const exchangeA = createExchange({
      id: "alice",
      transports: [
        createBridgeTransport({ transportId: "alice", bridge: bridgeAR }),
      ],
    })

    const relay = createExchange({
      id: "relay",
      transports: [
        createBridgeTransport({ transportId: "relay-a", bridge: bridgeAR }),
        createBridgeTransport({ transportId: "relay-b", bridge: bridgeRB }),
      ],
      resolve: () => Replicate(),
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [
        createBridgeTransport({ transportId: "bob", bridge: bridgeRB }),
      ],
      resolve: (docId: string) => {
        if (docId === "nested") return Interpret(NestedDoc)
        return undefined
      },
    })

    // Alice creates a doc with nested structure and writes data.
    // Separate change() calls so each push is its own flush cycle —
    // sequence ops within a single batch may reorder during
    // serialization round-trips.
    const docA = exchangeA.get("nested", NestedDoc)
    change(docA, (d: any) => {
      d.title.set("Task List")
      d.count.set(2)
    })
    change(docA, (d: any) => {
      d.items.push({ name: "Buy milk", done: false })
    })
    change(docA, (d: any) => {
      d.items.push({ name: "Write tests", done: true })
    })

    await drain(60)

    // Relay should have the doc (replicated, no schema)
    expect(relay.has("nested")).toBe(true)

    // Bob should have the doc with Alice's content
    expect(exchangeB.has("nested")).toBe(true)
    const docB = exchangeB.get("nested", NestedDoc)
    expect(docB.title()).toBe("Task List")
    expect(docB.count()).toBe(2)
    expect(docB.items.length).toBe(2)
    expect(docB.items.at(0)?.name()).toBe("Buy milk")
    expect(docB.items.at(0)?.done()).toBe(false)
    expect(docB.items.at(1)?.name()).toBe("Write tests")
    expect(docB.items.at(1)?.done()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// waitForSync — targeted ready-state emission via notification co-product
// ---------------------------------------------------------------------------

describe("waitForSync", () => {
  it("resolves after peer completes sync", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })

    const docA = exchangeA.get("doc-1", SequentialDoc)
    change(docA, (d: any) => {
      d.title.set("hello")
      d.count.set(1)
    })

    const docB = exchangeB.get("doc-1", SequentialDoc)

    // waitForSync should resolve — not hang or time out
    await sync(docB).waitForSync({ timeout: 5000 })

    expect(docB.title()).toBe("hello")
    expect(docB.count()).toBe(1)
  })

  it("onReadyStateChange fires only for the doc that synced", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })

    // Alice has two docs
    const docA1 = exchangeA.get("doc-1", SequentialDoc)
    change(docA1, (d: any) => d.title.set("first"))
    const docA2 = exchangeA.get("doc-2", SequentialDoc)
    change(docA2, (d: any) => d.title.set("second"))

    // Bob has both docs
    exchangeB.get("doc-1", SequentialDoc)
    exchangeB.get("doc-2", SequentialDoc)

    // Track which docIds fire ready-state changes on Bob's synchronizer
    const notifiedDocIds = new Set<string>()
    exchangeB.synchronizer.onReadyStateChange(docId => {
      notifiedDocIds.add(docId)
    })

    await drain()

    // Both docs should have been notified (they both synced)
    expect(notifiedDocIds.has("doc-1")).toBe(true)
    expect(notifiedDocIds.has("doc-2")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Capability gate
// ---------------------------------------------------------------------------

describe("capability gate", () => {
  it("no callback, unsupported type → rejected by default", async () => {
    // Peer A uses Loro. Peer B has default capabilities (no Loro)
    // and no resolve callback. Two-tiered default: unsupported → Reject.
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })

    exchangeA.get("loro-doc", LoroDoc)
    await drain(40)

    expect(exchangeB.has("loro-doc")).toBe(false)
    expect(exchangeB.deferred.has("loro-doc")).toBe(false)

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })

  it("callback provided, unsupported type → callback fires", async () => {
    // Same setup, but Peer B provides resolve: () => Defer().
    // The callback fires even for unsupported types (no synchronizer gate).
    const bridge = new Bridge({ codec: cborCodec })
    let classifyCallCount = 0

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      resolve: () => {
        classifyCallCount++
        return Defer()
      },
    })

    exchangeA.get("loro-doc", LoroDoc)
    await drain(40)

    expect(classifyCallCount).toBeGreaterThan(0)
    expect(exchangeB.deferred.has("loro-doc")).toBe(true)

    // Now B calls get() — auto-registers Loro, promotes deferred doc
    const _docB = exchangeB.get("loro-doc", LoroDoc)
    await drain(40)

    // Doc should now be interpreted
    expect(exchangeB.has("loro-doc")).toBe(true)

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })
})

// ---------------------------------------------------------------------------
// Two-tiered default (no callback)
// ---------------------------------------------------------------------------

describe("two-tiered default", () => {
  it("supported type → deferred, unsupported type → rejected", async () => {
    // Peer A creates both an authoritative doc (supported by default) and
    // a Loro doc (unsupported by default on B).
    // Peer B has no resolve callback and no Loro schemas.
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })

    // A creates both docs
    const seqA = exchangeA.get("seq-doc", SequentialDoc)
    change(seqA, (d: any) => d.title.set("hello"))
    exchangeA.get("loro-doc", LoroDoc)

    await drain(40)

    // Authoritative doc: supported type → deferred by default
    // has() returns true for deferred docs (they're in the cache),
    // but deferred.has() distinguishes them from interpreted docs.
    expect(exchangeB.deferred.has("seq-doc")).toBe(true)

    // Loro doc: unsupported type → rejected (not in deferred set, not in cache)
    expect(exchangeB.deferred.has("loro-doc")).toBe(false)
    expect(exchangeB.has("loro-doc")).toBe(false)

    // B calls get() for the authoritative doc — promotes from deferred, syncs
    const seqB = exchangeB.get("seq-doc", SequentialDoc)
    await drain(40)

    // Now promoted — no longer deferred, fully interpreted
    expect(exchangeB.deferred.has("seq-doc")).toBe(false)
    expect(exchangeB.has("seq-doc")).toBe(true)
    expect(seqB.title()).toBe("hello")

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })
})

// ---------------------------------------------------------------------------
// Auto-interpretation from schema registry
// ---------------------------------------------------------------------------

describe("auto-interpretation from schema registry", () => {
  it("registered schema auto-interprets without resolve", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [SequentialDoc],
    })

    const docA = exchangeA.get("auto-doc", SequentialDoc)
    change(docA, (d: any) => d.title.set("hello"))

    await drain(40)

    expect(exchangeB.has("auto-doc")).toBe(true)
    const docB = exchangeB.get("auto-doc", SequentialDoc)
    expect(docB.title()).toBe("hello")

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })
})

// ---------------------------------------------------------------------------
// Deferred document lifecycle
// ---------------------------------------------------------------------------

describe("deferred document lifecycle", () => {
  it("Defer() defers doc, exchange.get() promotes it and syncs data", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      resolve: () => Defer(),
    })

    const docA = exchangeA.get("deferred-doc", SequentialDoc)
    change(docA, (d: any) => d.title.set("deferred-value"))

    await drain(40)

    // B has deferred the doc — visible in deferred set
    expect(exchangeB.deferred.has("deferred-doc")).toBe(true)

    // Promote via get()
    const docB = exchangeB.get("deferred-doc", SequentialDoc)
    await drain(40)

    expect(exchangeB.has("deferred-doc")).toBe(true)
    expect(exchangeB.deferred.has("deferred-doc")).toBe(false)
    expect(docB.title()).toBe("deferred-value")

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })

  it("registerSchema() auto-promotes matching deferred docs", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      resolve: () => Defer(),
    })

    const docA = exchangeA.get("auto-promote-doc", SequentialDoc)
    change(docA, (d: any) => d.title.set("auto-promoted"))

    await drain(40)

    // B has deferred the doc
    expect(exchangeB.deferred.has("auto-promote-doc")).toBe(true)

    // Register the schema — should auto-promote
    exchangeB.registerSchema(SequentialDoc)
    await drain(40)

    expect(exchangeB.deferred.has("auto-promote-doc")).toBe(false)
    expect(exchangeB.has("auto-promote-doc")).toBe(true)
    const docB = exchangeB.get("auto-promote-doc", SequentialDoc)
    expect(docB.title()).toBe("auto-promoted")

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })

  it("exchange.deferred accessor tracks deferred state", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      resolve: () => Defer(),
    })

    exchangeA.get("d1", SequentialDoc)
    exchangeA.get("d2", SequentialDoc)

    await drain(20)

    expect(exchangeB.deferred.size).toBe(2)
    expect(exchangeB.deferred.has("d1")).toBe(true)
    expect(exchangeB.deferred.has("d2")).toBe(true)

    // Promote d1 via get() — this calls registerSchema(SequentialDoc)
    // internally, which auto-promotes ALL deferred docs matching the
    // same (schemaHash, replicaType, syncProtocol) triple.
    // Since d2 also uses SequentialDoc, both are promoted.
    exchangeB.get("d1", SequentialDoc)
    await drain(20)

    expect(exchangeB.deferred.size).toBe(0)
    expect(exchangeB.deferred.has("d1")).toBe(false)
    expect(exchangeB.deferred.has("d2")).toBe(false)

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })
})

// ---------------------------------------------------------------------------
// exchange.get() validation
// ---------------------------------------------------------------------------

describe("exchange.get() validation", () => {
  it("exchange.get() with unregistered Loro schema succeeds via auto-registration", () => {
    const exchange = createExchange({
      id: "test",
    })

    // Should NOT throw — get() auto-registers the schema
    const doc = exchange.get("doc", LoroDoc)
    expect(doc).toBeDefined()

    exchange.reset()
  })
})

// ---------------------------------------------------------------------------
// waitForSync — semantics: receiver-side primitive
// ---------------------------------------------------------------------------

describe("waitForSync semantics", () => {
  it("receiver-side waitForSync resolves after originator's data arrives", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })

    const docA = exchangeA.get("config", SequentialDoc)
    change(docA, (d: any) => {
      d.title.set("dark")
      d.count.set(42)
    })

    const docB = exchangeB.get("config", SequentialDoc)

    // Receiver-side waitForSync resolves — Bob received Alice's data
    await sync(docB).waitForSync({ timeout: 5000 })
    expect(docB.title()).toBe("dark")
    expect(docB.count()).toBe(42)
  })

  it("originator sees peer as 'pending' (not 'synced') — waitForSync is receiver-side", async () => {
    // waitForSync answers "has someone sent me state?" not "has my state
    // reached all peers?" — the originator never receives an offer back
    // from the receiver, so the peer stays "pending" from its perspective.
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })

    const docA = exchangeA.get("config", SequentialDoc)
    change(docA, (d: any) => d.title.set("dark"))

    const docB = exchangeB.get("config", SequentialDoc)
    await sync(docB).waitForSync({ timeout: 5000 })

    // From Alice's perspective, Bob is "pending" — Alice sent an offer
    // but never received one back, so the handshake is one-sided.
    const readyStates = sync(docA).readyStates
    expect(readyStates).toHaveLength(1)
    expect(readyStates[0].identity.peerId).toBe("bob")
    expect(readyStates[0].status).toBe("pending")
  })

  it("three-peer hub: receiver-side waitForSync resolves through relay", async () => {
    const bridgeAH = new Bridge({ codec: cborCodec })
    const bridgeHB = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [
        createBridgeTransport({ transportId: "alice", bridge: bridgeAH }),
      ],
      schemas: [LoroDoc],
    })

    const exchangeHub = createExchange({
      id: "hub",
      transports: [
        createBridgeTransport({ transportId: "hub-a", bridge: bridgeAH }),
        createBridgeTransport({ transportId: "hub-b", bridge: bridgeHB }),
      ],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [
        createBridgeTransport({ transportId: "bob", bridge: bridgeHB }),
      ],
      schemas: [LoroDoc],
    })

    const docA = exchangeA.get("collab", LoroDoc)
    change(docA, (d: any) => d.title.insert(0, "hello from alice"))

    exchangeHub.get("collab", LoroDoc)
    const docB = exchangeB.get("collab", LoroDoc)

    // Receiver-side waitForSync resolves even through a relay hop
    await sync(docB).waitForSync({ timeout: 5000 })
    expect(docB.title()).toBe("hello from alice")
  })
})

// ---------------------------------------------------------------------------
// ensure-doc idempotency
// ---------------------------------------------------------------------------

describe("ensure-doc idempotency", () => {
  it("exchange.get() is idempotent — second call returns same ref", () => {
    const exchange = new Exchange({ id: "test" })
    const ref1 = exchange.get("doc-1", SequentialDoc)
    const ref2 = exchange.get("doc-1", SequentialDoc)
    expect(ref1).toBe(ref2)
  })

  it("duplicate present for replicated doc does not throw", async () => {
    const bridge = new Bridge({ codec: cborCodec })
    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [SequentialDoc],
    })

    // Alice creates a doc — Bob will auto-resolve it
    const _ref = exchangeA.get("doc-1", SequentialDoc)

    // Drain to sync — no errors should occur even if cmd/ensure-doc fires
    // multiple times for the same doc via batched present
    await drain(40)

    expect(exchangeB.has("doc-1")).toBe(true)

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })
})

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// suspend → resume — two-peer convergence
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

describe("suspend / resume sync convergence", () => {
  it("suspended doc re-converges with peer after resume (collaborative)", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [LoroDoc],
    })

    // Alice creates a collaborative (Loro CRDT) doc and writes
    const docA = exchangeA.get("shared", LoroDoc)
    change(docA, (d: any) => {
      d.title.insert(0, "hello")
    })

    await drain(40)

    // Bob has the doc and it converged
    expect(exchangeB.has("shared")).toBe(true)
    const docB = exchangeB.get("shared", LoroDoc)
    expect(docB.title()).toBe("hello")

    // Alice suspends — leaves sync graph, keeps local state
    exchangeA.suspend("shared")
    await drain(40)

    // Alice mutates while suspended — Bob should NOT see this yet
    change(docA, (d: any) => {
      d.title.insert(5, " world")
    })
    await drain(40)
    expect(docB.title()).toBe("hello") // Bob unchanged

    // Bob mutates — Alice won't see this until resume
    change(docB, (d: any) => {
      d.items.push({ name: "bob-item" })
    })
    await drain(40)
    expect(docA.items().length).toBe(0) // Alice unchanged

    // Alice resumes — both peers should converge
    exchangeA.resume("shared")
    await drain(60)

    // Both peers converge: Alice's suspended mutation + Bob's mutation
    expect(docB.title()).toBe("hello world")
    expect(docA.items().length).toBe(1)
    expect((docA.items()[0] as any).name).toBe("bob-item")
  })

  it("destroy after suspend removes doc from both peers' sync graph", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [SequentialDoc],
    })

    exchangeA.get("ephemeral", SequentialDoc)
    await drain(40)
    expect(exchangeB.has("ephemeral")).toBe(true)

    // Suspend then destroy
    exchangeA.suspend("ephemeral")
    exchangeA.destroy("ephemeral")

    expect(exchangeA.has("ephemeral")).toBe(false)
    expect(exchangeA.documents.has("ephemeral")).toBe(false)
  })
})

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// canConnect — peer rejection at establish
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

describe("canConnect gate", () => {
  it("rejected peer cannot sync documents", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [LoroDoc],
      canConnect: () => false,
    })

    // Alice creates a doc — Bob should never see it
    exchangeA.get("secret", SequentialDoc)
    await drain(40)

    expect(exchangeB.peers().size).toBe(0)
    expect(exchangeB.has("secret")).toBe(false)
  })

  it("selective canConnect: accept some peers, reject others", async () => {
    const bridgeAB = new Bridge({ codec: cborCodec })
    const bridgeAC = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [
        createBridgeTransport({ transportId: "alice-b", bridge: bridgeAB }),
        createBridgeTransport({ transportId: "alice-c", bridge: bridgeAC }),
      ],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [
        createBridgeTransport({ transportId: "bob", bridge: bridgeAB }),
      ],
      canConnect: peer => (peer.peerId === "alice" ? true : undefined),
    })

    const _exchangeC = createExchange({
      id: "charlie",
      transports: [
        createBridgeTransport({ transportId: "charlie", bridge: bridgeAC }),
      ],
    })

    await drain(40)

    // Bob sees alice, alice sees both
    expect(exchangeB.peers().has("alice")).toBe(true)
    expect(exchangeA.peers().has("bob")).toBe(true)
    expect(exchangeA.peers().has("charlie")).toBe(true)
  })
})
