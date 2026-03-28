// bind — BoundSchema, bind(), and convenience wrappers.
//
// A BoundSchema<S> is the static declaration of a document type:
// three explicit choices (schema, factory builder, merge strategy)
// captured at module scope. The exchange consumes BoundSchema at
// runtime via exchange.get(docId, boundSchema).
//
// The factory is always a builder function:
//   (context: { peerId: string }) => SubstrateFactory<V>
//
// This ensures each exchange gets a fresh factory instance with the
// correct peer identity. Factories that don't need peer identity
// (e.g. plain) simply ignore the context: () => plainSubstrateFactory.
//
// MergeStrategy is a string union declaring the sync algorithm the
// exchange runs on behalf of the substrate:
// - "causal": bidirectional exchange, concurrent versions possible (Loro)
// - "sequential": request/response, total order (Plain)
// - "lww": unidirectional broadcast, timestamp-based (Ephemeral)

import type { Schema as SchemaNode } from "./schema.js"
import type { SubstrateFactory, Version } from "./substrate.js"
import { plainSubstrateFactory } from "./substrates/plain.js"

// ---------------------------------------------------------------------------
// MergeStrategy — dispatch key for the sync algorithm
// ---------------------------------------------------------------------------

/**
 * Declares the sync algorithm the exchange runs for a substrate type.
 *
 * These are genuinely different protocols matched to the mathematical
 * properties of the substrate, not transport optimizations:
 *
 * - **"causal"**: Bidirectional exchange. `compare()` may return
 *   `"concurrent"`. Uses `exportSince()` for fine-grained deltas.
 *
 * - **"sequential"**: Request/response. Total order — `compare()` never
 *   returns `"concurrent"`. Uses `exportSince()` or `exportSnapshot()`.
 *
 * - **"lww"**: Unidirectional push/broadcast. Timestamp-based. Always
 *   uses `exportSnapshot()`. Receiver compares timestamps and discards
 *   stale arrivals.
 */
export type MergeStrategy = "causal" | "sequential" | "lww"

// ---------------------------------------------------------------------------
// FactoryBuilder — deferred factory construction with peer identity
// ---------------------------------------------------------------------------

/**
 * A function that produces a `SubstrateFactory` given an exchange context.
 *
 * The exchange calls this lazily on first use, passing its peer identity.
 * Each exchange instance gets a fresh factory. Factories that don't need
 * peer identity simply ignore the context: `() => plainSubstrateFactory`.
 *
 * For Loro substrates, the builder hashes the peerId to a deterministic
 * numeric Loro PeerID and returns a factory that calls `doc.setPeerId()`
 * on every new LoroDoc.
 */
export type FactoryBuilder<V extends Version = Version> = (context: {
  peerId: string
}) => SubstrateFactory<V>

// ---------------------------------------------------------------------------
// BoundSchema — schema + factory + strategy binding
// ---------------------------------------------------------------------------

/**
 * A BoundSchema captures the three choices that define a document type:
 *
 * 1. **schema** — what shape is the data?
 * 2. **factory** — how is the data stored and versioned?
 * 3. **strategy** — how does the exchange sync it?
 *
 * BoundSchemas are static declarations created at module scope via
 * `bind()`, `bindPlain()`, `bindLww()`, or `bindLoro()`. They are
 * consumed at runtime by `exchange.get(docId, boundSchema)`.
 *
 * A BoundSchema can safely be shared across multiple exchange instances.
 * Each exchange calls the factory builder independently, producing a
 * fresh factory per exchange.
 */
export interface BoundSchema<S extends SchemaNode = SchemaNode> {
  readonly _brand: "BoundSchema"
  readonly schema: S
  readonly factory: FactoryBuilder<any>
  readonly strategy: MergeStrategy
}

// ---------------------------------------------------------------------------
// bind() — the general primitive
// ---------------------------------------------------------------------------

/**
 * Create a BoundSchema from explicit schema, factory builder, and strategy.
 *
 * This is the general primitive. Most users should prefer the convenience
 * wrappers `bindPlain()`, `bindLww()`, or `bindLoro()`.
 *
 * @example
 * ```ts
 * const MyDoc = bind({
 *   schema: Schema.doc({ title: Schema.string() }),
 *   factory: (ctx) => createMyFactory(ctx.peerId),
 *   strategy: "causal",
 * })
 * ```
 */
export function bind<S extends SchemaNode>(config: {
  schema: S
  factory: FactoryBuilder<any>
  strategy: MergeStrategy
}): BoundSchema<S> {
  return {
    _brand: "BoundSchema",
    schema: config.schema,
    factory: config.factory,
    strategy: config.strategy,
  }
}

// ---------------------------------------------------------------------------
// isBoundSchema — type guard
// ---------------------------------------------------------------------------

/**
 * Type guard: returns `true` if the value is a `BoundSchema`.
 */
export function isBoundSchema(value: unknown): value is BoundSchema {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    "_brand" in value &&
    (value as any)._brand === "BoundSchema"
  )
}

// ---------------------------------------------------------------------------
// bindPlain — convenience for plain JS substrate + sequential strategy
// ---------------------------------------------------------------------------

/**
 * Bind a schema to the plain JS substrate with sequential sync strategy.
 *
 * The plain substrate wraps a `Record<string, unknown>` with monotonic
 * versioning. Sequential strategy uses request/response sync with a
 * total version order.
 *
 * @example
 * ```ts
 * const ConfigDoc = bindPlain(Schema.doc({ theme: Schema.string() }))
 * const config = exchange.get("config", ConfigDoc)
 * ```
 */
export function bindPlain<S extends SchemaNode>(schema: S): BoundSchema<S> {
  return bind({
    schema,
    factory: () => plainSubstrateFactory,
    strategy: "sequential",
  })
}

// ---------------------------------------------------------------------------
// bindLww — convenience for plain JS substrate + LWW broadcast strategy
// ---------------------------------------------------------------------------

/**
 * Bind a schema to the plain JS substrate with LWW broadcast strategy.
 *
 * Uses the plain substrate for state management, but the exchange syncs
 * it via last-writer-wins broadcast — pushing full snapshots on every
 * local change, with timestamp-based stale filtering at the receiver.
 *
 * Ideal for ephemeral/presence state.
 *
 * @example
 * ```ts
 * const PresenceDoc = bindLww(Schema.doc({
 *   cursor: Schema.struct({ x: Schema.number(), y: Schema.number() }),
 *   name: Schema.string(),
 * }))
 * const presence = exchange.get("presence", PresenceDoc)
 * ```
 */
export function bindLww<S extends SchemaNode>(schema: S): BoundSchema<S> {
  return bind({
    schema,
    factory: () => plainSubstrateFactory,
    strategy: "lww",
  })
}