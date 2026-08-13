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
//
// SyncMode is a structured record decomposing sync semantics into
// three orthogonal axes (writerModel, delivery, durability). Each
// BindingTarget has a fixed SyncMode. The exchange dispatches on
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
  computeSupportedHashes,
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
import { isOpaqueBoundary, KIND } from "./schema.js"
import type {
  ReadCapability,
  ReplicaFactory,
  ReplicaType,
  SubstrateFactory,
  SyncMode,
  Version,
} from "./substrate.js"
import {
  computeSchemaHash,
  SYNC_AUTHORITATIVE,
  SYNC_EPHEMERAL,
} from "./substrate.js"
import {
  ephemeralReplicaFactory,
  ephemeralSubstrateFactory,
} from "./substrates/ephemeral.js"
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
 * on every new LoroDoc.
 *
 * The `binding` keys CRDT containers by identity rather than by field name.
 * Both sides go through it — `materializeValue` when writing (`containerKey`)
 * and `foldPath` when reading (`binding.forward.get`) — so a whole-struct write
 * cannot land under a key the reader will not look up.
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
 * 3. **syncMode** — how does the exchange sync it?
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

  /**
   * The binary format this binding's substrate produces and consumes.
   *
   * A property of the *binding* — this schema, on this substrate family,
   * under this sync mode — not of any substrate instance built from it, which
   * is why it does not vary with `peerId`. Its absence used to force callers
   * to build a whole substrate factory just to read it, and left
   * `BoundSchema` unable to answer a question its sibling `BoundReplica`
   * could answer from a field.
   */
  readonly replicaType: ReplicaType

  readonly syncMode: SyncMode
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
   * Contains the current schema's hash plus every hash reachable
   * backwards through every `MigrationChain` in the schema tree (root
   * chain and any nested-product chains, recursively). The set is the
   * cartesian product over independent chains. Per-chain halt: first
   * T2 step (lossy), T3 epoch (hard break), un-invertible primitive,
   * or `chain.base` prune horizon.
   *
   * Semantically aligned with the theory's `nativeSupports` — these
   * are the hashes at which this peer can op-stream sync. See
   * `computeSupportedHashes` in `migration.ts`.
   */
  readonly supportedHashes: ReadonlySet<string>
}

// ---------------------------------------------------------------------------
// BoundReplica — replication binding (factory + sync protocol)
// ---------------------------------------------------------------------------

/**
 * The replication binding: the pair of `ReplicaFactory` and `SyncMode`
 * that fully determines headless replication behavior.
 *
 * A `BoundReplica` captures everything the exchange needs to create and
 * sync a bare replica without schema interpretation.
 */
export interface BoundReplica {
  readonly factory: ReplicaFactory
  readonly syncMode: SyncMode
}

/**
 * Construct a `BoundReplica` from a `ReplicaFactory` and `SyncMode`.
 *
 * TypeScript dual-namespace pattern: `BoundReplica` is both a type and a
 * same-named constructor function.
 */
export function BoundReplica(
  factory: ReplicaFactory,
  syncMode: SyncMode,
): BoundReplica {
  return { factory, syncMode }
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
 * concrete `ReplicaFactory` and `SyncMode` from its capabilities
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
 *   syncMode: SYNC_COLLABORATIVE,
 * })
 * ```
 */
export function bind<S extends SchemaNode>(config: {
  schema: S
  factory: FactoryBuilder<any>
  syncMode: SyncMode
  /**
   * The binary format this schema's substrate produces and consumes.
   *
   * Supplied rather than derived because a `FactoryBuilder` needs a `peerId`
   * to run, and the format identifier does not depend on one — building a
   * whole substrate factory to read a static tuple off it would be the tail
   * wagging the dog. Every caller has it to hand: `createBindingTarget` reads
   * it off the `ReplicaFactory` it already holds.
   */
  replicaType: ReplicaType
}): BoundSchema<S> {
  const schemaHash = computeSchemaHash(config.schema)

  // Validate where `.decay()` may sit: never on a durable substrate (history
  // cannot be retroactively forgotten), and never below an opaque boundary
  // (everything inside a register shares one timestamp, so a field within it
  // has nothing of its own to age out). Runs before any other work so the
  // error fires loudly at module load.
  validateDecayConstraints(config.schema, config.syncMode)

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

  // Chain validation — O(migrations × nodes), runs unconditionally.
  // Validates path consistency, detects collisions and missing references.
  // bind() is module-scope-once, so always-validate has no hot-path cost
  // and prevents prod builds from silently accepting malformed chains.
  if (chain) {
    const result = validateChain(config.schema as unknown as ProductSchema)
    if (!result.valid) {
      throw new Error(
        `Migration chain validation failed:\n${result.errors.join("\n")}`,
      )
    }
  }

  // Compute supported hashes via the recursive tree walk. Covers the
  // root chain plus every nested-product chain; cartesian product
  // across independent chains. Per-chain halt at first T2 step, T3
  // epoch, un-invertible primitive, or chain.entries exhaustion. See
  // `computeSupportedHashes` for the full halt rule rationale.
  const supportedHashes =
    config.schema[KIND] === "product"
      ? computeSupportedHashes(config.schema as unknown as ProductSchema)
      : new Set<string>([schemaHash])

  return {
    _brand: "BoundSchema",
    schema: config.schema,
    factory: config.factory,
    replicaType: config.replicaType,
    syncMode: config.syncMode,
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
// metadataOf — a BoundSchema, viewed as a read capability
// ---------------------------------------------------------------------------

/**
 * What a peer holding this schema can read.
 *
 * A `BoundSchema` *is* a reader: it knows its own format, protocol and shape,
 * and it knows every ancestor shape its migration chains can still reach. So
 * this is a projection, not a computation — every field is already present.
 *
 * It returns a `ReadCapability` rather than a `DocMetadata`, and that is what
 * lets the comparison laws in `substrate.ts` distinguish a reader from a
 * document at the type level. The projection is total because
 * `BoundSchema.supportedHashes` is a required set, never an optional one:
 * unlike a peer's declaration arriving over the wire, a local schema's range
 * is always known.
 */
export function metadataOf(bound: BoundSchema): ReadCapability {
  return {
    replicaType: bound.replicaType,
    syncMode: bound.syncMode,
    schemaHash: bound.schemaHash,
    supportedHashes: [...bound.supportedHashes],
  }
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
 * A named binding target: a fixed (substrate, sync-mode, supported-laws) bundle.
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
  readonly syncMode: SyncMode
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
  syncMode: SyncMode
}): BindingTarget<AllowedLaws, N> {
  return {
    bind<P extends ProductSchema>(schema: P): BoundSchema<P, N> {
      return bind({
        schema,
        factory: config.factory,
        replicaType: config.replicaFactory.replicaType,
        syncMode: config.syncMode,
      }) as BoundSchema<P, N>
    },
    replica(): BoundReplica {
      return BoundReplica(config.replicaFactory, config.syncMode)
    },
    syncMode: config.syncMode,
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
  syncMode: SYNC_AUTHORITATIVE,
})

// ---------------------------------------------------------------------------
// ephemeral — the transient, field-level LWW binding target
// ---------------------------------------------------------------------------

/** The LWW-family composition laws — supported by the ephemeral target. */
export type EphemeralLaws = "lww" | "lww-per-key" | "lww-tag-replaced"

/**
 * The transient broadcast binding target — presence, cursors, live input.
 *
 * `ephemeral.bind(schema)` — field-level LWW, snapshot-only delivery, transient.
 * `ephemeral.replica()` — headless replication for relays.
 *
 * Only LWW-family composition laws bind here; anything carrying `additive`,
 * `positional-ot` or a tree law is rejected at compile time.
 *
 * "Ephemeral" names the property that distinguishes this target from every
 * other one: its data is never persisted, and `.decay()` can retire values on
 * a timer. Concurrent writes merge per field, so peers each writing their own
 * key in a shared roster never clobber one another — which is what makes it
 * usable for presence at all.
 */
export const ephemeral: BindingTarget<EphemeralLaws, PlainNativeMap> =
  createBindingTarget<EphemeralLaws, PlainNativeMap>({
    factory: () => ephemeralSubstrateFactory,
    replicaFactory: ephemeralReplicaFactory,
    syncMode: SYNC_EPHEMERAL,
  })

// ---------------------------------------------------------------------------
// validateDecayConstraints — where `.decay()` may legally sit
// ---------------------------------------------------------------------------

/**
 * The maximum schema-graph traversal depth. Matches {@link MAX_CANON_DEPTH}:
 * the grammar guarantees finite acyclic schemas, so this is only ever hit
 * by adversarial `as any`-crafted cyclic graphs.
 */
const MAX_VALIDATE_DEPTH = 1000

/**
 * Recursively walk a schema graph, rejecting `.decay()` where it cannot work.
 *
 * Two rules, both about `.decay()`, checked in this order because they are not
 * peers — the second is a refinement of the first.
 *
 * **1. Not on a durable or collaborative substrate.** `.decay()` is a
 * projection-only property of the local shadow — it cannot retroactively
 * forget durable history. Allowing it on a persistent substrate would be a
 * math-vs-projection contradiction: the history log would still carry the
 * timed-out value, but the shadow would pretend it was gone. We surface the
 * contradiction loudly, at `bind()` time, rather than letting it manifest as a
 * silent divergence later.
 *
 * **2. Not below an opaque boundary.** Decay works per leaf tuple, by testing
 * one stored timestamp against `now`. A `sum` variant or a `.json()` blob is
 * stored as ONE tuple holding the whole value, so a field inside it has no
 * timestamp of its own and cannot age out independently. Left unchecked, such a
 * binding succeeds and the decay simply never fires.
 *
 * The order is what a caller sees. A schema can break both rules at once, and
 * they are independent — fixing either leaves the other — so leading with the
 * boundary rule would tell someone to move an annotation when their real
 * problem is that the substrate supports no decay at all.
 *
 * Visited-set is intentionally omitted: legitimate shared-node DAGs (a
 * `Schema.string()` reused across many fields) would false-positive.
 * A depth cap converts cycles into a clear error instead.
 */
export function validateDecayConstraints(
  schema: SchemaNode,
  syncMode: SyncMode,
): void {
  const isEphemeral = syncMode.durability === "transient"
  walk(schema, 0, false)

  /**
   * `belowBoundary` is true once the walk has descended *through* a sum or
   * `.json()` node. It is raised for a node's children rather than for the node
   * itself, which is what keeps `.decay()` legal ON a boundary — the register
   * is one tuple with one timestamp, so the whole variant decaying together is
   * coherent — while rejecting it anywhere underneath.
   */
  function walk(node: SchemaNode, depth: number, belowBoundary: boolean): void {
    if (depth > MAX_VALIDATE_DEPTH) {
      throw new Error(
        `validateDecayConstraints: schema nesting exceeds limit (${MAX_VALIDATE_DEPTH}) — cycle or pathological depth`,
      )
    }

    if ((node as { decayMs?: number }).decayMs !== undefined) {
      if (!isEphemeral) {
        throw new Error(
          "Durable and collaborative substrates do not support .decay(). " +
            "Time-decay is ephemeral-only: the local shadow reverts to its " +
            "structural zero after `decayMs`, but durable history cannot be " +
            "retroactively forgotten. Bind this schema via `ephemeral` " +
            "instead.",
        )
      }
      if (belowBoundary) {
        throw new Error(
          ".decay() cannot be set inside a sum variant or a .json() blob. " +
            "The whole value is stored as one register with a single " +
            "timestamp, so a field inside it has nothing of its own to age " +
            "out. Move .decay() onto the sum or .json() node itself if the " +
            "whole value should decay together.",
        )
      }
    }

    // Raised for the children, not for this node — see `belowBoundary` above.
    const childrenAreBelowBoundary = belowBoundary || isOpaqueBoundary(node)

    switch (node[KIND]) {
      case "product": {
        const fields = (node as { fields: Record<string, SchemaNode> }).fields
        for (const key of Object.keys(fields)) {
          walk(fields[key] as SchemaNode, depth + 1, childrenAreBelowBoundary)
        }
        return
      }
      case "sequence":
      case "map":
      case "set":
      case "tree":
      case "movable":
        walk(
          (node as { item: SchemaNode }).item,
          depth + 1,
          childrenAreBelowBoundary,
        )
        return
      case "sum": {
        const variants = (node as { variants: readonly SchemaNode[] }).variants
        for (const variant of variants) {
          walk(variant, depth + 1, childrenAreBelowBoundary)
        }
        return
      }
      case "richtext":
        // marks are a fixed vocabulary, not a schema tree.
        return
      default:
        // scalar, text, counter — leaves. No children to walk.
        return
    }
  }
}
