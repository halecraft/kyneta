// bind — BoundSchema, BindingTarget, and convenience wrappers.
//
// A BoundSchema<S> is the static declaration of a document type:
// three explicit choices (schema, factory builder, sync protocol)
// captured at module scope. The exchange consumes BoundSchema at
// runtime via exchange.get(docId, boundSchema).
//
// The factory is always a builder function:
//   (context: { peerId: string; binding: SchemaBinding }) => SubstrateFactory<V>
//
// This ensures each exchange gets a fresh factory instance with the
// correct peer identity and schema binding. Factories that don't need
// these simply ignore the context: () => plainSubstrateFactory.
// For LWW/ephemeral, the builder returns lwwSubstrateFactory (which wraps
// plain with TimestampVersion for cross-peer stale rejection).
//
// SyncProtocol is a structured record decomposing sync semantics into
// three orthogonal axes (writerModel, delivery, durability). Each
// BindingTarget has a fixed SyncProtocol. The exchange dispatches on
// individual fields, not a monolithic enum.
//
// Named binding targets follow the rename-over-configure ergonomic rule:
// `json` and `ephemeral` are separate targets, not `json("ephemeral")`.

import type {
  IdentityManifest,
  MigrationChain,
  SchemaBinding,
} from "./migration.js"
import {
  deriveManifest,
  deriveSchemaBinding,
  getMigrationChain,
  validateChain,
} from "./migration.js"
import type { NativeMap, PlainNativeMap, UnknownNativeMap } from "./native.js"
import type {
  ExtractLaws,
  ProductSchema,
  Schema as SchemaNode,
} from "./schema.js"
import { KIND } from "./schema.js"
import type {
  ReplicaFactory,
  SubstrateFactory,
  SyncProtocol,
  Version,
} from "./substrate.js"
import {
  computeSchemaHash,
  SYNC_AUTHORITATIVE,
  SYNC_EPHEMERAL,
} from "./substrate.js"
import { lwwReplicaFactory, lwwSubstrateFactory } from "./substrates/lww.js"
import {
  plainReplicaFactory,
  plainSubstrateFactory,
} from "./substrates/plain.js"

// ---------------------------------------------------------------------------
// FactoryBuilder — deferred factory construction with peer identity
// ---------------------------------------------------------------------------

/**
 * A function that produces a `SubstrateFactory` given an exchange context.
 *
 * The exchange calls this lazily on first use, passing its peer identity
 * and the schema's identity binding. Each exchange instance gets a fresh
 * factory. Factories that don't need the context simply ignore it:
 * `() => plainSubstrateFactory`.
 *
 * For Loro substrates, the builder hashes the peerId to a deterministic
 * numeric Loro PeerID and returns a factory that calls `doc.setPeerId()`
 * on every new LoroDoc. The binding will be used in a later phase to
 * key CRDT containers by identity instead of field name.
 */
export type FactoryBuilder<V extends Version = Version> = (context: {
  peerId: string
  binding: SchemaBinding
}) => SubstrateFactory<V>

// ---------------------------------------------------------------------------
// BoundSchema — schema + factory + sync protocol binding
// ---------------------------------------------------------------------------

/**
 * A BoundSchema captures the three choices that define a document type:
 *
 * 1. **schema** — what shape is the data?
 * 2. **factory** — how is the data stored and versioned?
 * 3. **syncProtocol** — how does the exchange sync it?
 *
 * BoundSchemas are static declarations created at module scope via
 * the binding targets: `json.bind()`, `loro.bind()`, or `yjs.bind()`.
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
  readonly syncProtocol: SyncProtocol
  readonly schemaHash: string

  /**
   * Identity binding: maps schema paths to node identities and back.
   *
   * For schemas with no `.migrated()` calls, this is a trivial binding
   * where every path maps to `deriveIdentity(path, 1)`.
   *
   * Used by substrate factories (via FactoryBuilder context) to key
   * CRDT containers by identity instead of field name.
   */
  readonly identityBinding: SchemaBinding

  /**
   * The migration chain from the schema, if present.
   * Null for schemas with no `.migrated()` calls.
   */
  readonly migrationChain: MigrationChain | null

  /**
   * The set of schema hashes this peer supports for sync compatibility.
   *
   * Contains at minimum the current schema's hash. For schemas with
   * T0/T1a migration chains, includes hashes of all intermediate schema
   * versions reachable without epoch boundaries — enabling heterogeneous
   * peers to sync without coordination.
   */
  readonly supportedHashes: ReadonlySet<string>
}

// ---------------------------------------------------------------------------
// BoundReplica — replication binding (factory + sync protocol)
// ---------------------------------------------------------------------------

/**
 * The replication binding: the pair of `ReplicaFactory` and `SyncProtocol`
 * that fully determines headless replication behavior.
 *
 * A `BoundReplica` captures everything the exchange needs to create and
 * sync a bare replica without schema interpretation.
 */
export interface BoundReplica {
  readonly factory: ReplicaFactory
  readonly syncProtocol: SyncProtocol
}

/**
 * Construct a `BoundReplica` from a `ReplicaFactory` and `SyncProtocol`.
 *
 * TypeScript dual-namespace pattern: `BoundReplica` is both a type and a
 * same-named constructor function.
 */
export function BoundReplica(
  factory: ReplicaFactory,
  syncProtocol: SyncProtocol,
): BoundReplica {
  return { factory, syncProtocol }
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
 * concrete `ReplicaFactory` and `SyncProtocol` from its capabilities
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
 * Create a BoundSchema from explicit schema, factory builder, and sync protocol.
 *
 * This is the general primitive. Most users should prefer the binding
 * targets: `json.bind()`, `loro.bind()`, or `yjs.bind()`.
 *
 * @example
 * ```ts
 * const MyDoc = bind({
 *   schema: Schema.struct({ title: Schema.string() }),
 *   factory: (ctx) => createMyFactory(ctx.peerId),
 *   syncProtocol: SYNC_COLLABORATIVE,
 * })
 * ```
 */
export function bind<S extends SchemaNode>(config: {
  schema: S
  factory: FactoryBuilder<any>
  syncProtocol: SyncProtocol
}): BoundSchema<S> {
  const schemaHash = computeSchemaHash(config.schema)

  // Derive identity binding from the migration chain (if present).
  const chain = getMigrationChain(config.schema)
  let identityBinding: SchemaBinding
  let manifest: IdentityManifest | undefined

  if (chain && config.schema[KIND] === "product") {
    manifest = deriveManifest(config.schema as unknown as ProductSchema, chain)
    identityBinding = deriveSchemaBinding(
      config.schema as unknown as ProductSchema,
      manifest,
    )
  } else if (config.schema[KIND] === "product") {
    // No migration chain — derive trivial binding from the schema.
    identityBinding = deriveSchemaBinding(
      config.schema as unknown as ProductSchema,
      {}, // empty manifest → trivial origins
    )
  } else {
    // Non-product schema — empty binding.
    identityBinding = {
      forward: new Map(),
      inverse: new Map(),
    }
  }

  // Development-only chain validation — O(migrations × nodes).
  // Validates path consistency, detects collisions and missing references.
  if ((globalThis as any).process?.env?.NODE_ENV !== "production" && chain) {
    const result = validateChain(config.schema as unknown as ProductSchema)
    if (!result.valid) {
      throw new Error(
        `Migration chain validation failed:\n${result.errors.join("\n")}`,
      )
    }
  }

  // Compute supported hashes. The current hash is always supported.
  // Additional hashes from T0/T1a migration history are computed by
  // walking the chain — deferred to Phase 4 implementation.
  const supportedHashes: Set<string> = new Set([schemaHash])

  return {
    _brand: "BoundSchema",
    schema: config.schema,
    factory: config.factory,
    syncProtocol: config.syncProtocol,
    schemaHash,
    identityBinding,
    migrationChain: chain,
    supportedHashes,
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
// RestrictLaws — compile-time bind() guard
// ---------------------------------------------------------------------------

/**
 * Type-level guard for bind(). Resolves to S when all composition laws
 * in S are within AllowedLaws, never otherwise.
 *
 * Uses Exclude to check if any accumulated laws fall outside AllowedLaws.
 * When AllowedLaws = string, every law is allowed (unconstrained).
 */
export type RestrictLaws<S, AllowedLaws extends string> = [
  Exclude<ExtractLaws<S>, AllowedLaws>,
] extends [never]
  ? S
  : never

// ---------------------------------------------------------------------------
// BindingTarget — substrate-first API
// ---------------------------------------------------------------------------

/**
 * A named binding target: a fixed (substrate, sync-protocol, supported-laws) bundle.
 *
 * Follows the rename-over-configure ergonomic rule: like `HashMap` vs `TreeMap`,
 * not `Map({ ordering: "hash" })`.
 */
export interface BindingTarget<
  AllowedLaws extends string = string,
  N extends NativeMap = UnknownNativeMap,
> {
  bind<P extends ProductSchema>(
    schema: RestrictLaws<P, AllowedLaws>,
  ): BoundSchema<P, N>
  replica(): BoundReplica
  readonly syncProtocol: SyncProtocol
}

// ---------------------------------------------------------------------------
// createBindingTarget — pure factory for building target objects
// ---------------------------------------------------------------------------

/**
 * Create a `BindingTarget` from a fixed factory configuration.
 * Used by custom substrate authors to build third-party binding targets.
 */
export function createBindingTarget<
  AllowedLaws extends string = string,
  N extends NativeMap = UnknownNativeMap,
>(config: {
  factory: FactoryBuilder<any>
  replicaFactory: ReplicaFactory
  syncProtocol: SyncProtocol
}): BindingTarget<AllowedLaws, N> {
  return {
    bind<P extends ProductSchema>(schema: P): BoundSchema<P, N> {
      return bind({
        schema,
        factory: config.factory,
        syncProtocol: config.syncProtocol,
      }) as BoundSchema<P, N>
    },
    replica(): BoundReplica {
      return BoundReplica(config.replicaFactory, config.syncProtocol)
    },
    syncProtocol: config.syncProtocol,
  }
}

// ---------------------------------------------------------------------------
// json — the authoritative plain JSON binding target
// ---------------------------------------------------------------------------

/**
 * The authoritative plain JSON binding target.
 *
 * `json.bind(schema)` — authoritative sync, serialized writes.
 * `json.replica()` — authoritative replication.
 *
 * Supports ALL composition laws — serialized writes mean no concurrent
 * operations to resolve, so every law is trivially satisfied.
 */
export const json: BindingTarget<string, PlainNativeMap> = createBindingTarget<
  string,
  PlainNativeMap
>({
  factory: () => plainSubstrateFactory,
  replicaFactory: plainReplicaFactory,
  syncProtocol: SYNC_AUTHORITATIVE,
})

// ---------------------------------------------------------------------------
// ephemeral — the LWW broadcast binding target
// ---------------------------------------------------------------------------

/** The LWW-family composition laws — supported by the ephemeral target. */
export type EphemeralLaws = "lww" | "lww-per-key" | "lww-tag-replaced"

/**
 * The ephemeral broadcast binding target.
 *
 * `ephemeral.bind(schema)` — LWW broadcast, snapshot-only delivery, transient.
 * `ephemeral.replica()` — ephemeral replication.
 *
 * Only supports LWW-family composition laws. Schemas requiring additive,
 * positional-OT, or other non-LWW laws are rejected at compile time.
 */
export const ephemeral: BindingTarget<EphemeralLaws, PlainNativeMap> =
  createBindingTarget<EphemeralLaws, PlainNativeMap>({
    factory: () => lwwSubstrateFactory,
    replicaFactory: lwwReplicaFactory,
    syncProtocol: SYNC_EPHEMERAL,
  })
