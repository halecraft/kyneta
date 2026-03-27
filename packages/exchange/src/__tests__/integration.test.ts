// Integration tests — two-peer sync for all three merge strategies.
//
// These tests prove documents converge across two Exchange instances
// connected via BridgeAdapter, for each merge strategy:
// - Sequential (PlainSubstrate)
// - Causal (LoroSubstrate)
// - LWW (TimestampVersion + PlainSubstrate)
// - Heterogeneous (mixed substrates in one exchange)

import { describe, expect, it, afterEach } from "vitest"
import {
  Schema,
  LoroSchema,
  plainSubstrateFactory,
  change,
  buildWritableContext,
  type Substrate,
  type SubstratePayload,
  type Version,
  type WritableContext,
} from "@kyneta/schema"
import type { Schema as SchemaNode } from "@kyneta/schema"
import { loroSubstrateFactory } from "@kyneta/schema-loro"
import type { LoroVersion } from "@kyneta/schema-loro"
import { Exchange } from "../exchange.js"
import { sync } from "../sync.js"
import { Bridge, BridgeAdapter } from "../adapter/bridge-adapter.js"
import type { ExchangeSubstrateFactory, MergeStrategy } from "../factory.js"
import { TimestampVersion } from "../timestamp-version.js"

// ---------------------------------------------------------------------------
// Factory wrappers — wrap SubstrateFactory into ExchangeSubstrateFactory
// ---------------------------------------------------------------------------

function wrapPlainSequential(): ExchangeSubstrateFactory<any> {
  return {
    ...plainSubstrateFactory,
    mergeStrategy: { type: "sequential" } as MergeStrategy,
    _initialize(_ctx: { peerId: string }) {},
    create: plainSubstrateFactory.create.bind(plainSubstrateFactory),
    fromSnapshot: plainSubstrateFactory.fromSnapshot.bind(plainSubstrateFactory),
    parseVersion: plainSubstrateFactory.parseVersion.bind(plainSubstrateFactory),
  }
}

function wrapLoroFactory(): ExchangeSubstrateFactory<any> {
  return {
    ...loroSubstrateFactory,
    mergeStrategy: { type: "causal" } as MergeStrategy,
    _initialize(_ctx: { peerId: string }) {
      // In a real implementation, we'd hash peerId → numeric Loro PeerID
      // and call doc.setPeerId() in create(). For testing, we skip this.
    },
    create: loroSubstrateFactory.create.bind(loroSubstrateFactory),
    fromSnapshot: loroSubstrateFactory.fromSnapshot.bind(loroSubstrateFactory),
    parseVersion: loroSubstrateFactory.parseVersion.bind(loroSubstrateFactory),
  }
}

/**
 * LWW substrate factory — wraps a plain store with TimestampVersion.
 *
 * This is the ephemeral/presence substrate: full snapshot on every export,
 * timestamp-based version for LWW conflict resolution.
 */
function createLwwFactory(): ExchangeSubstrateFactory<TimestampVersion> {
  return {
    mergeStrategy: { type: "lww" } as MergeStrategy,

    _initialize(_ctx: { peerId: string }) {},

    create(schema: SchemaNode, seed?: Record<string, unknown>): Substrate<TimestampVersion> {
      // Use the plain substrate internally for state management
      const inner = plainSubstrateFactory.create(schema, seed)

      // Track the latest version (updated on flush and import)
      let currentVersion = new TimestampVersion(0)

      // Cached WritableContext that uses the wrapper's prepare/onFlush
      let cachedCtx: WritableContext | undefined

      // The wrapper substrate — declared as `const` so context() can
      // close over it and pass it to buildWritableContext.
      const substrate: Substrate<TimestampVersion> = {
        store: inner.store,
        prepare(path, change) {
          inner.prepare(path, change)
        },
        onFlush(origin?: string) {
          inner.onFlush(origin)
          // Bump version on every local flush
          currentVersion = TimestampVersion.now()
        },
        context(): WritableContext {
          // Build a WritableContext that routes through the WRAPPER's
          // prepare/onFlush (not the inner plain substrate's). This
          // ensures version bumping happens on every change() call.
          if (!cachedCtx) {
            cachedCtx = buildWritableContext(substrate)
          }
          return cachedCtx
        },
        frontier(): TimestampVersion {
          return currentVersion
        },
        exportSnapshot(): SubstratePayload {
          return inner.exportSnapshot()
        },
        exportSince(_since: TimestampVersion): SubstratePayload | null {
          // LWW always exports full snapshot
          return inner.exportSnapshot()
        },
        importDelta(payload: SubstratePayload, origin?: string): void {
          // For LWW, "delta" is always a full snapshot → reconstruct store
          inner.importDelta(payload, origin)
          // Bump version after import
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
        prepare(path, change) {
          inner.prepare(path, change)
        },
        onFlush(origin?: string) {
          inner.onFlush(origin)
          currentVersion = TimestampVersion.now()
        },
        context(): WritableContext {
          if (!cachedCtx) {
            cachedCtx = buildWritableContext(substrate)
          }
          return cachedCtx
        },
        frontier: () => currentVersion,
        exportSnapshot: () => inner.exportSnapshot(),
        exportSince: () => inner.exportSnapshot(),
        importDelta: (p, o) => {
          inner.importDelta(p, o)
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

function createExchange(params: ConstructorParameters<typeof Exchange>[0]): Exchange {
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
// Sequential (PlainSubstrate) — two-peer sync
// ---------------------------------------------------------------------------

describe("Sequential sync (PlainSubstrate)", () => {
  const schema = Schema.doc({
    title: Schema.string(),
    count: Schema.number(),
  })

  it("peer A creates doc, peer B syncs and gets the same state", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      adapters: [new BridgeAdapter({ adapterType: "alice", bridge })],
      substrates: { plain: wrapPlainSequential() },
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      adapters: [new BridgeAdapter({ adapterType: "bob", bridge })],
      substrates: { plain: wrapPlainSequential() },
    })

    // Alice creates a doc with seed values
    const docA = exchangeA.get("doc-1", schema, {
      seed: { title: "Hello from Alice", count: 42 },
    })

    expect(docA.title()).toBe("Hello from Alice")
    expect(docA.count()).toBe(42)

    // Bob creates the same doc (empty initially)
    const docB = exchangeB.get("doc-1", schema)

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
      substrates: { plain: wrapPlainSequential() },
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      adapters: [new BridgeAdapter({ adapterType: "bob", bridge })],
      substrates: { plain: wrapPlainSequential() },
    })

    const docA = exchangeA.get("doc-1", schema, { seed: { title: "V1", count: 1 } })
    const docB = exchangeB.get("doc-1", schema)

    // Initial sync
    await drain()
    expect(docB.title()).toBe("V1")

    // Alice mutates
    change(docA, (d: any) => {
      d.title.set("V2")
      d.count.set(2)
    })

    // Notify synchronizer of local change
    exchangeA.synchronizer.notifyLocalChange("doc-1")

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
  const schema = LoroSchema.doc({
    title: LoroSchema.text(),
    items: Schema.list(Schema.struct({ name: Schema.string() })),
  })

  it("peer A creates doc with text, peer B syncs and gets the same state", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      adapters: [new BridgeAdapter({ adapterType: "alice", bridge })],
      substrates: { loro: wrapLoroFactory() },
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      adapters: [new BridgeAdapter({ adapterType: "bob", bridge })],
      substrates: { loro: wrapLoroFactory() },
    })

    // Alice creates a doc
    const docA = exchangeA.get("doc-1", schema)

    // Insert text
    change(docA, (d: any) => {
      d.title.insert(0, "Hello CRDT")
    })

    // Notify synchronizer
    exchangeA.synchronizer.notifyLocalChange("doc-1")

    // Bob creates the same doc
    const docB = exchangeB.get("doc-1", schema)

    await drain()

    // Bob should have Alice's text
    expect(docB.title()).toBe("Hello CRDT")
  })

  it("concurrent edits from both peers converge", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      adapters: [new BridgeAdapter({ adapterType: "alice", bridge })],
      substrates: { loro: wrapLoroFactory() },
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      adapters: [new BridgeAdapter({ adapterType: "bob", bridge })],
      substrates: { loro: wrapLoroFactory() },
    })

    // Both create the doc
    const docA = exchangeA.get("doc-1", schema)
    const docB = exchangeB.get("doc-1", schema)

    // Initial sync
    await drain()

    // Both insert concurrently
    change(docA, (d: any) => {
      d.title.insert(0, "Alice")
    })
    exchangeA.synchronizer.notifyLocalChange("doc-1")

    change(docB, (d: any) => {
      d.title.insert(0, "Bob")
    })
    exchangeB.synchronizer.notifyLocalChange("doc-1")

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
  const presenceSchema = Schema.doc({
    cursor: Schema.struct({
      x: Schema.number(),
      y: Schema.number(),
    }),
    name: Schema.string(),
  })

  it("peer A sets presence, peer B receives via broadcast", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      adapters: [new BridgeAdapter({ adapterType: "alice", bridge })],
      substrates: { lww: createLwwFactory() },
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      adapters: [new BridgeAdapter({ adapterType: "bob", bridge })],
      substrates: { lww: createLwwFactory() },
    })

    // Alice sets presence with seed and triggers a flush so the version bumps
    const presA = exchangeA.get("presence", presenceSchema)

    // Use change() to set values — this triggers prepare + flush, bumping the version
    change(presA, (d: any) => {
      d.cursor.x.set(100)
      d.cursor.y.set(200)
      d.name.set("Alice")
    })

    // Bob creates the same presence doc
    const presB = exchangeB.get("presence", presenceSchema)

    // Notify synchronizer of the local change (LWW broadcasts to all)
    exchangeA.synchronizer.notifyLocalChange("presence")

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
      substrates: { lww: createLwwFactory() },
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      adapters: [new BridgeAdapter({ adapterType: "bob", bridge })],
      substrates: { lww: createLwwFactory() },
    })

    const presA = exchangeA.get("presence", presenceSchema)
    const presB = exchangeB.get("presence", presenceSchema)

    // Set initial values via change() so version bumps
    change(presA, (d: any) => {
      d.cursor.x.set(0)
      d.cursor.y.set(0)
      d.name.set("Alice")
    })

    // Initial broadcast
    exchangeA.synchronizer.notifyLocalChange("presence")
    await drain()
    expect(presB.name()).toBe("Alice")

    // Alice moves cursor
    change(presA, (d: any) => {
      d.cursor.x.set(500)
      d.cursor.y.set(600)
    })
    exchangeA.synchronizer.notifyLocalChange("presence")

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

    const loroSchema = LoroSchema.doc({
      text: LoroSchema.text(),
    })

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      adapters: [new BridgeAdapter({ adapterType: "alice", bridge })],
      substrates: {
        plain: wrapPlainSequential(),
        loro: wrapLoroFactory(),
      },
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      adapters: [new BridgeAdapter({ adapterType: "bob", bridge })],
      substrates: {
        plain: wrapPlainSequential(),
        loro: wrapLoroFactory(),
      },
    })

    // Alice: plain config doc
    const configA = exchangeA.get("config", plainSchema, {
      substrate: "plain",
      seed: { config: "dark-mode" },
    })

    // Alice: loro collaborative doc
    const textA = exchangeA.get("collab", loroSchema, {
      substrate: "loro",
    })
    change(textA, (d: any) => {
      d.text.insert(0, "collaborative text")
    })
    exchangeA.synchronizer.notifyLocalChange("collab")

    // Bob: create both docs
    const configB = exchangeB.get("config", plainSchema, { substrate: "plain" })
    const textB = exchangeB.get("collab", loroSchema, { substrate: "loro" })

    await drain()

    // Both docs should sync
    expect(configB.config()).toBe("dark-mode")
    expect(textB.text()).toBe("collaborative text")
  })
})