// Integration tests — two-peer sync for all three merge strategies.
//
// These tests prove documents converge across two Exchange instances
// connected via BridgeAdapter, for each merge strategy:
// - Sequential (PlainSubstrate via bindPlain)
// - Causal (LoroSubstrate via bindLoro)
// - LWW (TimestampVersion via bind + custom factory)
// - Heterogeneous (mixed substrates in one exchange)

import { describe, expect, it, afterEach } from "vitest"
import {
  Schema,
  LoroSchema,
  plainSubstrateFactory,
  change,
  bind,
  bindPlain,
  buildWritableContext,
  type BoundSchema,
  type Substrate,
  type SubstratePayload,
  type WritableContext,
} from "@kyneta/schema"
import type { Schema as SchemaNode } from "@kyneta/schema"
import { bindLoro } from "@kyneta/schema-loro"
import { Exchange } from "../exchange.js"
import { sync } from "../sync.js"
import { Bridge, BridgeAdapter } from "../adapter/bridge-adapter.js"
import { TimestampVersion } from "../timestamp-version.js"

// ---------------------------------------------------------------------------
// LWW factory builder — wraps plain store with TimestampVersion
// ---------------------------------------------------------------------------

function lwwFactoryBuilder(_ctx: { peerId: string }) {
  return {
    create(schema: SchemaNode, seed?: Record<string, unknown>): Substrate<TimestampVersion> {
      const inner = plainSubstrateFactory.create(schema, seed)
      let currentVersion = new TimestampVersion(0)
      let cachedCtx: WritableContext | undefined

      const substrate: Substrate<TimestampVersion> = {
        store: inner.store,
        prepare(path: any, change: any) { inner.prepare(path, change) },
        onFlush(origin?: string) {
          inner.onFlush(origin)
          currentVersion = TimestampVersion.now()
        },
        context(): WritableContext {
          if (!cachedCtx) cachedCtx = buildWritableContext(substrate)
          return cachedCtx
        },
        version: () => currentVersion,
        exportSnapshot: () => inner.exportSnapshot(),
        exportSince: () => inner.exportSnapshot(),
        importDelta(payload: SubstratePayload, origin?: string) {
          inner.importDelta(payload, origin)
          currentVersion = TimestampVersion.now()
        },
      }
      return substrate
    },

    fromSnapshot(payload: SubstratePayload, schema: SchemaNode): Substrate<TimestampVersion> {
      const inner = plainSubstrateFactory.fromSnapshot(payload, schema)
      let currentVersion = TimestampVersion.now()
      let cachedCtx: WritableContext | undefined

      const substrate: Substrate<TimestampVersion> = {
        store: inner.store,
        prepare(path: any, change: any) { inner.prepare(path, change) },
        onFlush(origin?: string) {
          inner.onFlush(origin)
          currentVersion = TimestampVersion.now()
        },
        context(): WritableContext {
          if (!cachedCtx) cachedCtx = buildWritableContext(substrate)
          return cachedCtx
        },
        version: () => currentVersion,
        exportSnapshot: () => inner.exportSnapshot(),
        exportSince: () => inner.exportSnapshot(),
        importDelta(payload: SubstratePayload, origin?: string) {
          inner.importDelta(payload, origin)
          currentVersion = TimestampVersion.now()
        },
      }
      return substrate
    },

    parseVersion(serialized: string): TimestampVersion {
      return TimestampVersion.parse(serialized)
    },
  }
}

/**
 * Bind a schema with LWW merge strategy using a custom LWW factory.
 */
function bindLwwCustom<S extends SchemaNode>(schema: S): BoundSchema<S> {
  return bind({
    schema,
    factory: lwwFactoryBuilder,
    strategy: "lww",
  })
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Drain microtask queue — necessary for BridgeAdapter async delivery.
 * We do multiple rounds because messages trigger responses which trigger
 * more async deliveries.
 */
async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => queueMicrotask(r))
    // Also yield to promise queue
    await new Promise<void>((r) => setTimeout(r, 0))
  }
}

/** Active exchanges that need cleanup */
const activeExchanges: Exchange[] = []

function createExchange(params: ConstructorParameters<typeof Exchange>[0] = {}): Exchange {
  const ex = new Exchange(params)
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
  items: Schema.list(Schema.struct({ name: Schema.string() })),
})
const LoroDoc = bindLoro(loroSchema)

const presenceSchema = Schema.doc({
  cursor: Schema.struct({
    x: Schema.number(),
    y: Schema.number(),
  }),
  name: Schema.string(),
})
const PresenceDoc = bindLwwCustom(presenceSchema)

// ---------------------------------------------------------------------------
// Sequential (PlainSubstrate) — two-peer sync
// ---------------------------------------------------------------------------

describe("Sequential sync (PlainSubstrate)", () => {
  it("peer A creates doc, peer B syncs and gets the same state", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      adapters: [new BridgeAdapter({ adapterType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      adapters: [new BridgeAdapter({ adapterType: "bob", bridge })],
    })

    // Alice creates a doc with seed values
    const docA = exchangeA.get("doc-1", SequentialDoc, {
      seed: { title: "Hello from Alice", count: 42 },
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
      adapters: [new BridgeAdapter({ adapterType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      adapters: [new BridgeAdapter({ adapterType: "bob", bridge })],
    })

    const docA = exchangeA.get("doc-1", SequentialDoc, { seed: { title: "V1", count: 1 } })
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
      adapters: [new BridgeAdapter({ adapterType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      adapters: [new BridgeAdapter({ adapterType: "bob", bridge })],
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
      adapters: [new BridgeAdapter({ adapterType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      adapters: [new BridgeAdapter({ adapterType: "bob", bridge })],
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
      adapters: [new BridgeAdapter({ adapterType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      adapters: [new BridgeAdapter({ adapterType: "bob", bridge })],
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
      adapters: [new BridgeAdapter({ adapterType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      adapters: [new BridgeAdapter({ adapterType: "bob", bridge })],
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
      adapters: [new BridgeAdapter({ adapterType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      adapters: [new BridgeAdapter({ adapterType: "bob", bridge })],
    })

    // Alice: plain config doc
    const configA = exchangeA.get("config", ConfigDoc, {
      seed: { config: "dark-mode" },
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