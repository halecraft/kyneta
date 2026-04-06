// Integration tests — two-peer sync for all three merge strategies.
//
// These tests prove documents converge across two Exchange instances
// connected via BridgeTransport, for each merge strategy:
// - Sequential (PlainSubstrate via bindPlain)
// - Causal (LoroSubstrate via bindLoro)
// - LWW (TimestampVersion via bindEphemeral)
// - Heterogeneous (mixed substrates in one exchange)

import { bindLoro, LoroSchema, loroReplicaFactory } from "@kyneta/loro-schema"
import {
  BoundReplica,
  bindEphemeral,
  bindPlain,
  change,
  Defer,
  Interpret,
  Reject,
  Replicate,
  Schema,
} from "@kyneta/schema"
import { Bridge, createBridgeTransport } from "@kyneta/transport"
import { afterEach, describe, expect, it } from "vitest"

import { Exchange } from "../exchange.js"
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

function createExchange(
  params: ConstructorParameters<typeof Exchange>[0] = {},
): Exchange {
  const merged = {
    ...params,
    identity: { peerId: "test", ...params?.identity },
  }
  const ex = new Exchange(merged)
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

const sequentialSchema = Schema.doc({
  title: Schema.string(),
  count: Schema.number(),
})
const SequentialDoc = bindPlain(sequentialSchema)

const loroSchema = LoroSchema.doc({
  title: LoroSchema.text(),
  items: LoroSchema.list(
    LoroSchema.plain.struct({ name: LoroSchema.plain.string() }),
  ),
})
const LoroDoc = bindLoro(loroSchema)

const presenceSchema = Schema.doc({
  cursor: Schema.struct({
    x: Schema.number(),
    y: Schema.number(),
  }),
  name: Schema.string(),
})
const PresenceDoc = bindEphemeral(presenceSchema)

// ---------------------------------------------------------------------------
// Sequential (PlainSubstrate) — two-peer sync
// ---------------------------------------------------------------------------

describe("Sequential sync (PlainSubstrate)", () => {
  it("peer A creates doc, peer B syncs and gets the same state", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
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
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
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
// Causal (LoroSubstrate) — two-peer CRDT sync
// ---------------------------------------------------------------------------

describe("Causal sync (LoroSubstrate)", () => {
  it("peer A creates doc with text, peer B syncs and gets the same state", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
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
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
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
// LWW (Ephemeral/Presence) — broadcast sync
// ---------------------------------------------------------------------------

describe("LWW sync (Ephemeral/Presence)", () => {
  it("peer A sets presence, peer B receives via broadcast", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
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

  it("updates propagate via LWW broadcast", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
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
  it("one exchange hosts both sequential and causal docs, both sync", async () => {
    const bridge = new Bridge()

    const plainSchema = Schema.doc({
      config: Schema.string(),
    })
    const ConfigDoc = bindPlain(plainSchema)

    const collabSchema = LoroSchema.doc({
      text: LoroSchema.text(),
    })
    const CollabDoc = bindLoro(collabSchema)

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
      schemas: [CollabDoc],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
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
  it("causal: mutation on A propagates through Hub to B", async () => {
    // Two separate bridges: Alice↔Hub and Hub↔Bob
    const bridgeAH = new Bridge()
    const bridgeHB = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [
        createBridgeTransport({ transportType: "alice", bridge: bridgeAH }),
      ],
      schemas: [LoroDoc],
    })

    const exchangeHub = createExchange({
      identity: { peerId: "hub" },
      transports: [
        createBridgeTransport({ transportType: "hub-a", bridge: bridgeAH }),
        createBridgeTransport({ transportType: "hub-b", bridge: bridgeHB }),
      ],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge: bridgeHB }),
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

  it("sequential: mutation on A propagates through Hub to B", async () => {
    const bridgeAH = new Bridge()
    const bridgeHB = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [
        createBridgeTransport({ transportType: "alice", bridge: bridgeAH }),
      ],
    })

    const exchangeHub = createExchange({
      identity: { peerId: "hub" },
      transports: [
        createBridgeTransport({ transportType: "hub-a", bridge: bridgeAH }),
        createBridgeTransport({ transportType: "hub-b", bridge: bridgeHB }),
      ],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge: bridgeHB }),
      ],
    })

    // Hub creates the doc with initial state (sequential needs a populated source)
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
// onUnresolvedDoc — dynamic document creation
// ---------------------------------------------------------------------------

describe("onUnresolvedDoc (dynamic document creation)", () => {
  it("peer A creates doc, peer B materializes it via onUnresolvedDoc", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onUnresolvedDoc: docId => {
        if (docId === "dynamic-doc") return Interpret(SequentialDoc)
        return Reject()
      },
    })

    // Alice creates a doc that Bob doesn't have yet
    const docA = exchangeA.get("dynamic-doc", SequentialDoc)
    change(docA, (d: any) => {
      d.title.set("created by alice")
      d.count.set(7)
    })

    // Drain — present → request-doc-creation → callback → doc-ensure → present → interest → offer
    await drain(40)

    // Bob should now have the doc with Alice's content
    expect(exchangeB.has("dynamic-doc")).toBe(true)
    const docB = exchangeB.get("dynamic-doc", SequentialDoc)
    expect(docB.title()).toBe("created by alice")
    expect(docB.count()).toBe(7)
  })

  it("onUnresolvedDoc returning Reject() does not create the doc", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onUnresolvedDoc: () => Reject(),
    })

    exchangeA.get("ignored-doc", SequentialDoc)

    await drain(40)

    expect(exchangeB.has("ignored-doc")).toBe(false)
  })

  it("LWW dynamic doc syncs correctly", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onUnresolvedDoc: docId => {
        if (docId === "presence") return Interpret(PresenceDoc)
        return Reject()
      },
    })

    // Alice creates an LWW doc
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

    // Alice updates — LWW broadcasts snapshot
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
// Route predicate
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

describe("route predicate", () => {
  it("route prevents document announcement", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
      // Deny bob from seeing "secret"
      route: docId => docId !== "secret",
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })

    // Alice creates doc that bob shouldn't see
    exchangeA.get("secret", SequentialDoc)

    await drain(40)

    expect(exchangeB.has("secret")).toBe(false)
  })

  it("route prevents relay in three-peer topology", async () => {
    const bridgeAH = new Bridge()
    const bridgeHB = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [
        createBridgeTransport({ transportType: "alice", bridge: bridgeAH }),
      ],
    })

    // Hub allows alice but denies bob for "private-doc"
    const exchangeHub = createExchange({
      identity: { peerId: "hub" },
      transports: [
        createBridgeTransport({ transportType: "hub-a", bridge: bridgeAH }),
        createBridgeTransport({ transportType: "hub-b", bridge: bridgeHB }),
      ],
      route: (docId, peer) => {
        if (docId === "private-doc" && peer.peerId === "bob") return false
        return true
      },
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge: bridgeHB }),
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
// Authorize predicate
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

describe("authorize predicate", () => {
  it("authorize rejects offer — doc content unchanged", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    // Bob rejects all mutations
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      authorize: () => false,
    })

    const docA = exchangeA.get("doc-1", SequentialDoc)
    const docB = exchangeB.get("doc-1", SequentialDoc)

    change(docA, (d: any) => {
      d.title.set("from alice")
      d.count.set(99)
    })

    await drain(40)

    // Bob's doc should remain at defaults (authorize rejected the offer)
    expect(docB.title()).toBe("")
    expect(docB.count()).toBe(0)
  })
})

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// Dismiss
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

describe("dismiss", () => {
  it("dismiss triggers onDocDismissed on the receiving peer", async () => {
    const bridge = new Bridge()
    let dismissedDocId: string | undefined
    let dismissedPeerId: string | undefined

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onDocDismissed: (docId, peer) => {
        dismissedDocId = docId
        dismissedPeerId = peer.peerId
      },
    })

    // Both create and sync a doc
    const _docA = exchangeA.get("shared-doc", SequentialDoc)
    exchangeB.get("shared-doc", SequentialDoc)

    await drain(40)

    // Alice dismisses
    exchangeA.dismiss("shared-doc")

    await drain(40)

    expect(dismissedDocId).toBe("shared-doc")
    expect(dismissedPeerId).toBe("alice")
  })

  it("dismiss removes doc locally and stops sync", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })

    exchangeA.get("doc-1", SequentialDoc)
    const docB = exchangeB.get("doc-1", SequentialDoc)

    await drain(40)

    // Alice dismisses — doc should be removed locally
    exchangeA.dismiss("doc-1")
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
// Route + onUnresolvedDoc interaction
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

describe("route + onUnresolvedDoc interaction", () => {
  it("route denying a peer prevents onUnresolvedDoc from firing", async () => {
    const bridge = new Bridge()
    let discoveredCallCount = 0

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      // Route denies alice for "blocked-doc"
      route: docId => docId !== "blocked-doc",
      onUnresolvedDoc: docId => {
        discoveredCallCount++
        if (docId === "blocked-doc") return Interpret(SequentialDoc)
        return Reject()
      },
    })

    // Alice creates the doc
    exchangeA.get("blocked-doc", SequentialDoc)

    await drain(40)

    // Bob's onUnresolvedDoc should never have fired (route blocked it)
    expect(discoveredCallCount).toBe(0)
    expect(exchangeB.has("blocked-doc")).toBe(false)
  })
})

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// Relay via exchange.replicate() — schema-free relay tests
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

describe("relay via exchange.replicate()", () => {
  it("causal doc syncs through a schema-free relay: peer A → relay → peer B", async () => {
    const bridgeAR = new Bridge()
    const bridgeRB = new Bridge()

    // Peer A — full interpreter
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [
        createBridgeTransport({ transportType: "alice", bridge: bridgeAR }),
      ],
      schemas: [LoroDoc],
    })

    // Relay — headless replication, no schema knowledge
    const relay = createExchange({
      identity: { peerId: "relay" },
      transports: [
        createBridgeTransport({ transportType: "relay-a", bridge: bridgeAR }),
        createBridgeTransport({ transportType: "relay-b", bridge: bridgeRB }),
      ],
      replicas: [BoundReplica(loroReplicaFactory, "causal")],
      onUnresolvedDoc: () => Replicate(),
    })

    // Peer B — full interpreter
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge: bridgeRB }),
      ],
      schemas: [LoroDoc],
      onUnresolvedDoc: docId => {
        if (docId === "shared") return Interpret(LoroDoc)
        return Reject()
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

  it("sequential doc syncs through a schema-free relay", async () => {
    const bridgeAR = new Bridge()
    const bridgeRB = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [
        createBridgeTransport({ transportType: "alice", bridge: bridgeAR }),
      ],
    })

    const relay = createExchange({
      identity: { peerId: "relay" },
      transports: [
        createBridgeTransport({ transportType: "relay-a", bridge: bridgeAR }),
        createBridgeTransport({ transportType: "relay-b", bridge: bridgeRB }),
      ],
      onUnresolvedDoc: () => Replicate(),
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge: bridgeRB }),
      ],
      onUnresolvedDoc: docId => {
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

  it("LWW doc syncs through a schema-free relay", async () => {
    const bridgeAR = new Bridge()
    const bridgeRB = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [
        createBridgeTransport({ transportType: "alice", bridge: bridgeAR }),
      ],
    })

    const relay = createExchange({
      identity: { peerId: "relay" },
      transports: [
        createBridgeTransport({ transportType: "relay-a", bridge: bridgeAR }),
        createBridgeTransport({ transportType: "relay-b", bridge: bridgeRB }),
      ],
      onUnresolvedDoc: () => Replicate(),
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge: bridgeRB }),
      ],
      onUnresolvedDoc: docId => {
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

  it("onUnresolvedDoc returning Replicate() creates replicated doc from peer discovery", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
      schemas: [LoroDoc],
    })

    let discoveredDocId: string | undefined
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      replicas: [BoundReplica(loroReplicaFactory, "causal")],
      onUnresolvedDoc: docId => {
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
    const bridgeAR = new Bridge()

    // Phase 1: Alice connects to relay, writes data
    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [
        createBridgeTransport({ transportType: "alice", bridge: bridgeAR }),
      ],
      schemas: [LoroDoc],
    })

    const relay = createExchange({
      identity: { peerId: "relay" },
      transports: [
        createBridgeTransport({ transportType: "relay-a", bridge: bridgeAR }),
      ],
      replicas: [BoundReplica(loroReplicaFactory, "causal")],
      onUnresolvedDoc: () => Replicate(),
    })

    const docA = exchangeA.get("shared", LoroDoc)
    change(docA, (d: any) => {
      d.title.insert(0, "Written before Bob joined")
    })

    await drain(60)

    // Relay should have accumulated Alice's state
    expect(relay.has("shared")).toBe(true)

    // Phase 2: Bob connects to relay AFTER Alice wrote
    const bridgeRB = new Bridge()
    await relay.addTransport(
      createBridgeTransport({ transportType: "relay-b", bridge: bridgeRB })(),
    )

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge: bridgeRB }),
      ],
      schemas: [LoroDoc],
      onUnresolvedDoc: docId => {
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
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      schemas: [SequentialDoc],
      replicas: [BoundReplica(loroReplicaFactory, "causal")],
      onUnresolvedDoc: docId => {
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
})

// ---------------------------------------------------------------------------
// waitForSync — targeted ready-state emission via notification co-product
// ---------------------------------------------------------------------------

describe("waitForSync", () => {
  it("resolves after peer completes sync", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
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
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
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
    // and no onUnresolvedDoc callback. Two-tiered default: unsupported → Reject.
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      // No Loro capability, no onUnresolvedDoc callback
    })

    exchangeA.get("loro-doc", LoroDoc)
    await drain(40)

    expect(exchangeB.has("loro-doc")).toBe(false)
    expect(exchangeB.deferred.has("loro-doc")).toBe(false)

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })

  it("callback provided, unsupported type → callback fires", async () => {
    // Same setup, but Peer B provides onUnresolvedDoc: () => Defer().
    // The callback fires even for unsupported types (no synchronizer gate).
    const bridge = new Bridge()
    let classifyCallCount = 0

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onUnresolvedDoc: () => {
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
    // Peer A creates both a sequential doc (supported by default) and
    // a Loro doc (unsupported by default on B).
    // Peer B has no onUnresolvedDoc callback and no Loro schemas.
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      // No onUnresolvedDoc, no Loro schemas — default replicas only
    })

    // A creates both docs
    const seqA = exchangeA.get("seq-doc", SequentialDoc)
    change(seqA, (d: any) => d.title.set("hello"))
    exchangeA.get("loro-doc", LoroDoc)

    await drain(40)

    // Sequential doc: supported type → deferred by default
    // has() returns true for deferred docs (they're in the cache),
    // but deferred.has() distinguishes them from interpreted docs.
    expect(exchangeB.deferred.has("seq-doc")).toBe(true)

    // Loro doc: unsupported type → rejected (not in deferred set, not in cache)
    expect(exchangeB.deferred.has("loro-doc")).toBe(false)
    expect(exchangeB.has("loro-doc")).toBe(false)

    // B calls get() for the sequential doc — promotes from deferred, syncs
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
  it("registered schema auto-interprets without onUnresolvedDoc", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      schemas: [SequentialDoc],
      // No onUnresolvedDoc callback at all
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
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onUnresolvedDoc: () => Defer(),
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
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onUnresolvedDoc: () => Defer(),
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
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onUnresolvedDoc: () => Defer(),
    })

    exchangeA.get("d1", SequentialDoc)
    exchangeA.get("d2", SequentialDoc)

    await drain(20)

    expect(exchangeB.deferred.size).toBe(2)
    expect(exchangeB.deferred.has("d1")).toBe(true)
    expect(exchangeB.deferred.has("d2")).toBe(true)

    // Promote d1 via get() — this calls registerSchema(SequentialDoc)
    // internally, which auto-promotes ALL deferred docs matching the
    // same (schemaHash, replicaType, mergeStrategy) triple.
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
      identity: { peerId: "test" },
      // Default replicas — no Loro
    })

    // Should NOT throw — get() auto-registers the schema
    const doc = exchange.get("doc", LoroDoc)
    expect(doc).toBeDefined()

    exchange.reset()
  })
})

// ---------------------------------------------------------------------------
// onDocCreated
// ---------------------------------------------------------------------------

describe("onDocCreated", () => {
  it("fires for local get()", async () => {
    const calls: Array<{ docId: string; mode: string; origin: string }> = []
    const exchange = createExchange({
      identity: { peerId: "alice" },
      onDocCreated: (docId, _peer, mode, origin) => {
        calls.push({ docId, mode, origin })
      },
    })

    exchange.get("doc-1", SequentialDoc)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      docId: "doc-1",
      mode: "interpret",
      origin: "local",
    })

    exchange.reset()
  })

  it("fires for remote auto-resolve", async () => {
    const bridge = new Bridge()
    const calls: Array<{
      docId: string
      peerId: string
      mode: string
      origin: string
    }> = []

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      schemas: [SequentialDoc],
      onDocCreated: (docId, peer, mode, origin) => {
        calls.push({ docId, peerId: peer.peerId, mode, origin })
      },
    })

    exchangeA.get("doc-1", SequentialDoc)
    await drain(40)

    const remote = calls.filter(c => c.origin === "remote")
    expect(remote).toHaveLength(1)
    expect(remote[0]).toMatchObject({
      docId: "doc-1",
      peerId: "alice",
      mode: "interpret",
      origin: "remote",
    })

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })

  it("fires for onUnresolvedDoc → Interpret", async () => {
    const bridge = new Bridge()
    let unresolvedFired = false
    const calls: Array<{ docId: string; origin: string }> = []

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onUnresolvedDoc: () => {
        unresolvedFired = true
        return Interpret(SequentialDoc)
      },
      onDocCreated: (docId, _peer, _mode, origin) => {
        calls.push({ docId, origin })
      },
    })

    exchangeA.get("doc-1", SequentialDoc)
    await drain(40)

    expect(unresolvedFired).toBe(true)
    const remote = calls.filter(c => c.origin === "remote")
    expect(remote).toHaveLength(1)
    expect(remote[0]).toMatchObject({ docId: "doc-1", origin: "remote" })

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })

  it("fires on deferred → promoted via get()", async () => {
    const bridge = new Bridge()
    const calls: Array<{ docId: string; origin: string }> = []

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onUnresolvedDoc: () => Defer(),
      onDocCreated: (docId, _peer, _mode, origin) => {
        calls.push({ docId, origin })
      },
    })

    exchangeA.get("doc-1", SequentialDoc)
    await drain(40)

    // Deferred — onDocCreated should NOT have fired yet
    expect(calls).toHaveLength(0)
    expect(exchangeB.deferred.has("doc-1")).toBe(true)

    // Promote via get()
    exchangeB.get("doc-1", SequentialDoc)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ docId: "doc-1", origin: "local" })

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })

  it("does not fire for deferred docs (two-tiered default)", async () => {
    const bridge = new Bridge()
    const calls: Array<{ docId: string }> = []

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      // No onUnresolvedDoc, no schemas — supported type → deferred by two-tiered default
      onDocCreated: docId => {
        calls.push({ docId })
      },
    })

    exchangeA.get("doc-1", SequentialDoc)
    await drain(40)

    // Sequential is a default-supported type → deferred, NOT created
    expect(exchangeB.deferred.has("doc-1")).toBe(true)
    expect(calls).toHaveLength(0)

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })

  it("composes via scopes (broadcast)", async () => {
    const calls1: string[] = []
    const calls2: string[] = []

    const exchange = createExchange({
      identity: { peerId: "alice" },
      onDocCreated: docId => {
        calls1.push(docId)
      },
    })

    exchange.register({
      onDocCreated: docId => {
        calls2.push(docId)
      },
    })

    exchange.get("doc-1", SequentialDoc)

    expect(calls1).toEqual(["doc-1"])
    expect(calls2).toEqual(["doc-1"])

    exchange.reset()
  })

  it("auto-resolve fires onDocCreated for every doc, not just the first (regression)", async () => {
    const bridge = new Bridge()
    const calls: string[] = []

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      schemas: [SequentialDoc],
      onDocCreated: (docId, _peer, _mode, origin) => {
        if (origin === "remote") calls.push(docId)
      },
    })

    exchangeA.get("doc-1", SequentialDoc)
    exchangeA.get("doc-2", SequentialDoc)
    await drain(40)

    expect(calls).toContain("doc-1")
    expect(calls).toContain("doc-2")
    expect(calls).toHaveLength(2)

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })

  it("internal get() from Interpret does not register schema for future auto-resolve", async () => {
    const bridge = new Bridge()
    let unresolvedCount = 0

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      replicas: [BoundReplica(loroReplicaFactory, "causal")],
      // No schemas — rely on onUnresolvedDoc for Loro docs
      onUnresolvedDoc: () => {
        unresolvedCount++
        return Interpret(LoroDoc)
      },
    })

    exchangeA.get("doc-1", LoroDoc)
    await drain(40)
    expect(unresolvedCount).toBe(1)

    // Second doc with same schema — onUnresolvedDoc should fire again
    // (internal get() from Interpret did NOT register LoroDoc for auto-resolve)
    exchangeA.get("doc-2", LoroDoc)
    await drain(40)
    expect(unresolvedCount).toBe(2)

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })

  it("fires for local replicate()", () => {
    const calls: Array<{ docId: string; mode: string; origin: string }> = []
    const exchange = createExchange({
      identity: { peerId: "alice" },
      replicas: [BoundReplica(loroReplicaFactory, "causal")],
      onDocCreated: (docId, _peer, mode, origin) => {
        calls.push({ docId, mode, origin })
      },
    })

    exchange.replicate("doc-1", loroReplicaFactory, "causal", "hash-1")

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      docId: "doc-1",
      mode: "replicate",
      origin: "local",
    })

    exchange.reset()
  })

  it("fires for remote Replicate via relay", async () => {
    const bridge = new Bridge()
    const calls: Array<{
      docId: string
      peerId: string
      mode: string
      origin: string
    }> = []

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
      schemas: [LoroDoc],
    })

    const relay = createExchange({
      identity: { peerId: "relay" },
      transports: [createBridgeTransport({ transportType: "relay", bridge })],
      replicas: [BoundReplica(loroReplicaFactory, "causal")],
      onUnresolvedDoc: () => Replicate(),
      onDocCreated: (docId, peer, mode, origin) => {
        calls.push({ docId, peerId: peer.peerId, mode, origin })
      },
    })

    exchangeA.get("shared", LoroDoc)
    await drain(40)

    const remote = calls.filter(c => c.origin === "remote")
    expect(remote).toHaveLength(1)
    expect(remote[0]).toMatchObject({
      docId: "shared",
      peerId: "alice",
      mode: "replicate",
      origin: "remote",
    })

    await exchangeA.shutdown()
    await relay.shutdown()
  })
})

// ---------------------------------------------------------------------------
// waitForSync — semantics: receiver-side primitive
// ---------------------------------------------------------------------------

describe("waitForSync semantics", () => {
  it("receiver-side waitForSync resolves after originator's data arrives", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [
        createBridgeTransport({ transportType: "alice", bridge }),
      ],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge }),
      ],
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
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [
        createBridgeTransport({ transportType: "alice", bridge }),
      ],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge }),
      ],
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
    const bridgeAH = new Bridge()
    const bridgeHB = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [
        createBridgeTransport({ transportType: "alice", bridge: bridgeAH }),
      ],
      schemas: [LoroDoc],
    })

    const exchangeHub = createExchange({
      identity: { peerId: "hub" },
      transports: [
        createBridgeTransport({ transportType: "hub-a", bridge: bridgeAH }),
        createBridgeTransport({ transportType: "hub-b", bridge: bridgeHB }),
      ],
      schemas: [LoroDoc],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge: bridgeHB }),
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
