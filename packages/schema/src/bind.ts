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
// For LWW/ephemeral, the builder returns lwwSubstrateFactory (which wraps
// plain with TimestampVersion for cross-peer stale rejection).
//
// MergeStrategy is a string union declaring the sync algorithm the
// exchange runs on behalf of the substrate:
// - "collaborative": bidirectional exchange, concurrent versions possible (Loro)
// - "authoritative": request/response, total order (Plain)
// - "ephemeral": unidirectional broadcast, timestamp-based (Ephemeral)

import type { NativeMap, PlainNativeMap, UnknownNativeMap } from "./native.js"
import type {
  ExtractCaps,
  ProductSchema,
  Schema as SchemaNode,
} from "./schema.js"
import type {
  MergeStrategy,
  ReplicaFactory,
  SubstrateFactory,
  Version,
} from "./substrate.js"
import { computeSchemaHash } from "./substrate.js"
import { lwwReplicaFactory, lwwSubstrateFactory } from "./substrates/lww.js"
import {
  plainReplicaFactory,
  plainSubstrateFactory,
} from "./substrates/plain.js"

// Re-export MergeStrategy so existing imports from "./bind.js" keep working.
export type { MergeStrategy } from "./substrate.js"

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
 * the substrate namespaces: `json.bind()`, `loro.bind()`, or `yjs.bind()`.
 * They are consumed at runtime by `exchange.get(docId, boundSchema)`.
 *
 * A BoundSchema can safely be shared across multiple exchange instances.
 * Each exchange calls the factory builder independently, producing a
 * fresh factory per exchange.
 */
export interface BoundSchema<
  S extends SchemaNode = SchemaNode,
  N extends NativeMap = UnknownNativeMap,
> {
  readonly _brand: "BoundSchema"
  /** @internal Phantom field anchoring the NativeMap type parameter. */
  readonly _nativeMap?: N
  readonly schema: S
  readonly factory: FactoryBuilder<any>
  readonly strategy: MergeStrategy
  readonly schemaHash: string
}

// ---------------------------------------------------------------------------
// BoundReplica — replication binding (factory + strategy)
// ---------------------------------------------------------------------------

/**
 * The replication binding: the pair of `ReplicaFactory` and `MergeStrategy`
 * that fully determines headless replication behavior.
 *
 * A `BoundReplica` captures everything the exchange needs to create and
 * sync a bare replica without schema interpretation.
 */
export interface BoundReplica {
  readonly factory: ReplicaFactory
  readonly strategy: MergeStrategy
}

/**
 * Construct a `BoundReplica` from a `ReplicaFactory` and `MergeStrategy`.
 *
 * TypeScript dual-namespace pattern: `BoundReplica` is both a type and a
 * same-named constructor function.
 */
export function BoundReplica(
  factory: ReplicaFactory,
  strategy: MergeStrategy,
): BoundReplica {
  return { factory, strategy }
}

// ---------------------------------------------------------------------------
// Disposition types — Interpret / Replicate
// ---------------------------------------------------------------------------

/**
 * Disposition: full interpretation.
 *
 * The document is backed by a `Substrate` with a full interpreter stack:
 * readable store, writable context, changefeed, `Ref<S>`. This is the
 * default for client apps and application servers that read and write
 * document state.
 *
 * Created via `exchange.get(docId, bound)` or returned from
 * `onDocDiscovered` to auto-create an interpreted document.
 */
export type Interpret = {
  readonly kind: "interpret"
  readonly bound: BoundSchema
}

/**
 * Disposition: headless replication.
 *
 * The document is backed by a bare `Replica<V>` — version tracking,
 * export/import, per-peer delta computation — but no schema-driven
 * interpretation, no `Ref`, no changefeed. This is the correct tier
 * for conduit participants: relay servers, stores, routing
 * servers, audit logs.
 *
 * The caller declares intent to replicate; the Exchange resolves the
 * concrete `ReplicaFactory` and `MergeStrategy` from its capabilities
 * registry.
 */
export type Replicate = { readonly kind: "replicate" }

/**
 * Disposition: explicit rejection.
 *
 * Returned from `onDocDiscovered` to indicate that the exchange should
 * not track or replicate the discovered document at all.
 */
export type Reject = { readonly kind: "reject" }

/**
 * Disposition: deferral.
 *
 * Track the document for routing purposes but do not interpret or
 * replicate it yet. The document can be promoted to a full disposition
 * later.
 */
export type Defer = { readonly kind: "defer" }

// ---------------------------------------------------------------------------
// Disposition constructors — dual-namespace pattern
// ---------------------------------------------------------------------------

/**
 * Construct an `Interpret` disposition from a `BoundSchema`.
 *
 * TypeScript dual-namespace pattern: `Interpret` is both a type and a
 * same-named constructor function. Call-site reads naturally:
 *
 * ```ts
 * onDocDiscovered: (docId) => Interpret(PlayerDoc)
 * ```
 */
export function Interpret(bound: BoundSchema): Interpret {
  return { kind: "interpret", bound }
}

/**
 * Construct a `Replicate` disposition.
 *
 * The Exchange resolves the factory from its capabilities registry —
 * the caller just declares intent.
 *
 * TypeScript dual-namespace pattern: `Replicate` is both a type and a
 * same-named constructor function. Call-site reads naturally:
 *
 * ```ts
 * onDocDiscovered: (docId) => Replicate()
 * ```
 */
export function Replicate(): Replicate {
  return { kind: "replicate" }
}

/**
 * Construct a `Reject` disposition.
 *
 * TypeScript dual-namespace pattern: `Reject` is both a type and a
 * same-named constructor function.
 */
export function Reject(): Reject {
  return { kind: "reject" }
}

/**
 * Construct a `Defer` disposition.
 *
 * TypeScript dual-namespace pattern: `Defer` is both a type and a
 * same-named constructor function.
 */
export function Defer(): Defer {
  return { kind: "defer" }
}

// ---------------------------------------------------------------------------
// bind() — the general primitive
// ---------------------------------------------------------------------------

/**
 * Create a BoundSchema from explicit schema, factory builder, and strategy.
 *
 * This is the general primitive. Most users should prefer the substrate
 * namespaces: `json.bind()`, `loro.bind()`, or `yjs.bind()`.
 *
 * @example
 * ```ts
 * const MyDoc = bind({
 *   schema: Schema.struct({ title: Schema.string() }),
 *   factory: (ctx) => createMyFactory(ctx.peerId),
 *   strategy: "collaborative",
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
    schemaHash: computeSchemaHash(config.schema),
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
// RestrictCaps — compile-time bind() guard
// ---------------------------------------------------------------------------

/**
 * Type-level guard for bind(). Resolves to S when all capability tags
 * in S are within AllowedCaps, never otherwise.
 *
 * Uses Exclude to check if any accumulated caps fall outside AllowedCaps.
 * When AllowedCaps = string, every cap is allowed (unconstrained).
 */
export type RestrictCaps<S, AllowedCaps extends string> = [
  Exclude<ExtractCaps<S>, AllowedCaps>,
] extends [never]
  ? S
  : never

// ---------------------------------------------------------------------------
// Strategy type aliases — constrain namespace overrides
// ---------------------------------------------------------------------------

/** Strategies available for the plain JSON substrate. */
export type JsonStrategy = "authoritative" | "ephemeral"

/** Strategies available for CRDT substrates (Loro, Yjs). */
export type CrdtStrategy = "collaborative" | "ephemeral"

// ---------------------------------------------------------------------------
// SubstrateNamespace — substrate-first API
// ---------------------------------------------------------------------------

/**
 * A substrate namespace groups `bind()` and `replica()` under a single
 * substrate identity. The strategy is a type-constrained optional
 * parameter with a sane default. Invalid (substrate, strategy)
 * combinations are compile errors.
 *
 * @example
 * ```ts
 * json.bind(schema)               // authoritative (default)
 * json.bind(schema, "ephemeral")  // ephemeral
 * json.replica()                  // authoritative (default)
 * loro.bind(schema)               // collaborative (default)
 * loro.replica("ephemeral")       // ephemeral
 * ```
 */
export interface SubstrateNamespace<
  S extends MergeStrategy,
  AllowedCaps extends string = string,
  N extends NativeMap = UnknownNativeMap,
> {
  bind<P extends ProductSchema>(
    schema: RestrictCaps<P, AllowedCaps>,
    strategy?: S,
  ): BoundSchema<P, N>
  replica(strategy?: S): BoundReplica
}

// ---------------------------------------------------------------------------
// createSubstrateNamespace — pure factory for building namespace objects
// ---------------------------------------------------------------------------

/**
 * Create a `SubstrateNamespace` from a strategy → factory mapping.
 *
 * This is a pure function (Functional Core) that constructs the namespace
 * object. The dispatch from strategy → factory is driven by the
 * `strategies` map. Custom substrate authors can use this to build their
 * own namespaces.
 *
 * @example
 * ```ts
 * const json = createSubstrateNamespace({
 *   strategies: {
 *     authoritative: { factory: () => plainSubstrateFactory, replicaFactory: plainReplicaFactory },
 *     ephemeral: { factory: () => lwwSubstrateFactory, replicaFactory: lwwReplicaFactory },
 *   },
 *   defaultStrategy: "authoritative",
 * })
 * ```
 */
export function createSubstrateNamespace<
  S extends MergeStrategy,
  AllowedCaps extends string = string,
  N extends NativeMap = UnknownNativeMap,
>(config: {
  strategies: {
    [K in S]: {
      factory: FactoryBuilder<any>
      replicaFactory: ReplicaFactory
    }
  }
  defaultStrategy: S
}): SubstrateNamespace<S, AllowedCaps, N> {
  return {
    bind<P extends ProductSchema>(schema: P, strategy?: S): BoundSchema<P, N> {
      const s = strategy ?? config.defaultStrategy
      return bind({
        schema,
        factory: config.strategies[s].factory,
        strategy: s,
      }) as BoundSchema<P, N>
    },
    replica(strategy?: S): BoundReplica {
      const s = strategy ?? config.defaultStrategy
      return BoundReplica(config.strategies[s].replicaFactory, s)
    },
  }
}

// ---------------------------------------------------------------------------
// json — the plain JSON substrate namespace
// ---------------------------------------------------------------------------

/**
 * The plain JSON substrate namespace.
 *
 * - `json.bind(schema)` — authoritative sync (default)
 * - `json.bind(schema, "ephemeral")` — ephemeral/presence broadcast
 * - `json.replica()` — authoritative replication (default)
 * - `json.replica("ephemeral")` — ephemeral replication
 *
 * Strategy is constrained to `JsonStrategy` (`"authoritative" | "ephemeral"`).
 * Passing `"collaborative"` is a compile error — plain substrates cannot
 * return `"concurrent"` from `compare()`.
 */
export const json: SubstrateNamespace<JsonStrategy, string, PlainNativeMap> =
  createSubstrateNamespace<JsonStrategy, string, PlainNativeMap>({
    strategies: {
      authoritative: {
        factory: () => plainSubstrateFactory,
        replicaFactory: plainReplicaFactory,
      },
      ephemeral: {
        factory: () => lwwSubstrateFactory,
        replicaFactory: lwwReplicaFactory,
      },
    },
    defaultStrategy: "authoritative",
  })
