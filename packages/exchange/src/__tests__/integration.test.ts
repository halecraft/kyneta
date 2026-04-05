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
  bindEphemeral,
  bindPlain,
  change,
  Interpret,
  lwwReplicaFactory,
  plainReplicaFactory,
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
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
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
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
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
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
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
// onDocDiscovered — dynamic document creation
// ---------------------------------------------------------------------------

describe("onDocDiscovered (dynamic document creation)", () => {
  it("peer A creates doc, peer B materializes it via onDocDiscovered", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onDocDiscovered: docId => {
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

    // Drain — present → request-doc-creation → callback → doc-ensure → present → interest → offer
    await drain(40)

    // Bob should now have the doc with Alice's content
    expect(exchangeB.has("dynamic-doc")).toBe(true)
    const docB = exchangeB.get("dynamic-doc", SequentialDoc)
    expect(docB.title()).toBe("created by alice")
    expect(docB.count()).toBe(7)
  })

  it("onDocDiscovered returning undefined does not create the doc", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onDocDiscovered: () => undefined,
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
      onDocDiscovered: docId => {
        if (docId === "presence") return Interpret(PresenceDoc)
        return undefined
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
// Route + onDocDiscovered interaction
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

describe("route + onDocDiscovered interaction", () => {
  it("route denying a peer prevents onDocDiscovered from firing", async () => {
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
      onDocDiscovered: docId => {
        discoveredCallCount++
        if (docId === "blocked-doc") return Interpret(SequentialDoc)
        return undefined
      },
    })

    // Alice creates the doc
    exchangeA.get("blocked-doc", SequentialDoc)

    await drain(40)

    // Bob's onDocDiscovered should never have fired (route blocked it)
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
    })

    // Relay — headless replication, no schema knowledge
    const relay = createExchange({
      identity: { peerId: "relay" },
      transports: [
        createBridgeTransport({ transportType: "relay-a", bridge: bridgeAR }),
        createBridgeTransport({ transportType: "relay-b", bridge: bridgeRB }),
      ],
      onDocDiscovered: (_docId, _peer, _rt, _ms, schemaHash) =>
        Replicate(loroReplicaFactory, "causal", schemaHash),
    })

    // Peer B — full interpreter
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge: bridgeRB }),
      ],
      onDocDiscovered: docId => {
        if (docId === "shared") return Interpret(LoroDoc)
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
      onDocDiscovered: (_docId, _peer, _rt, _ms, schemaHash) =>
        Replicate(plainReplicaFactory, "sequential", schemaHash),
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge: bridgeRB }),
      ],
      onDocDiscovered: docId => {
        if (docId === "config") return Interpret(SequentialDoc)
        return undefined
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
      onDocDiscovered: (_docId, _peer, _rt, _ms, schemaHash) =>
        Replicate(lwwReplicaFactory, "lww", schemaHash),
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge: bridgeRB }),
      ],
      onDocDiscovered: docId => {
        if (docId === "presence") return Interpret(PresenceDoc)
        return undefined
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

  it("onDocDiscovered returning Replicate() creates replicated doc from peer discovery", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    let discoveredDocId: string | undefined
    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onDocDiscovered: (docId, _peer, _rt, _ms, schemaHash) => {
        discoveredDocId = docId
        return Replicate(loroReplicaFactory, "causal", schemaHash)
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
    })

    const relay = createExchange({
      identity: { peerId: "relay" },
      transports: [
        createBridgeTransport({ transportType: "relay-a", bridge: bridgeAR }),
      ],
      onDocDiscovered: (_docId, _peer, _rt, _ms, schemaHash) =>
        Replicate(loroReplicaFactory, "causal", schemaHash),
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
      onDocDiscovered: docId => {
        if (docId === "shared") return Interpret(LoroDoc)
        return undefined
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
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onDocDiscovered: (docId, _peer, _rt, _ms, schemaHash) => {
        // Interpret some docs, replicate others
        if (docId === "app-doc") return Interpret(SequentialDoc)
        if (docId === "relay-doc")
          return Replicate(loroReplicaFactory, "causal", schemaHash)
        return undefined
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
