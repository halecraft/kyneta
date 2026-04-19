// migration — schema migration primitives, identity derivation, and chain algebra.
//
// This module is the algebraic core of the migration system. It contains:
//
// 1. Types: NodeIdentity, IdentityOrigin, IdentityManifest, MigrationTier,
//    MigrationPrimitive, DroppedPrimitive, MigrationStep, EpochStep,
//    MigrationChainEntry, MigrationChain, SchemaBinding, TransformProof.
//
// 2. Migration namespace: constructor functions for all 14 primitives.
//    T2 primitives return a Droppable<P> requiring .drop() before use.
//
// 3. Pure functions: deriveTier, deriveIdentity, deriveManifest,
//    deriveSchemaBinding.
//
// No substrate changes. No wire changes. Pure schema-level algebra.

import { fnv1a128 } from "./hash.js"
import {
  KIND,
  type ProductSchema,
  type Schema as SchemaNode,
} from "./schema.js"

// ---------------------------------------------------------------------------
// MigratedSchema — type-level marker for schemas with migration chains
// ---------------------------------------------------------------------------

/**
 * A ProductSchema that carries a `[MIGRATION_CHAIN]` symbol.
 *
 * Structurally identical to `ProductSchema` — all existing code that
 * accepts `ProductSchema` continues to work. The migration chain is
 * invisible to `canonicalizeSchema`, `advanceSchema`, `Object.keys`,
 * and `JSON.stringify`.
 *
 * The type parameter `S` anchors the structural shape so that
 * `.migrated()` and `.epoch()` preserve the original schema type.
 */
export type MigratedSchema<S extends ProductSchema = ProductSchema> = S & {
  readonly [MIGRATION_CHAIN]: MigrationChain
}

// ---------------------------------------------------------------------------
// MIGRATION_CHAIN — symbol for attaching chain metadata to ProductSchema
// ---------------------------------------------------------------------------

/**
 * Symbol-keyed slot for the migration chain on a ProductSchema.
 *
 * Invisible to `canonicalizeSchema` (which switches on `[KIND]`),
 * invisible to `JSON.stringify`, invisible to `Object.keys`.
 * Only code that knows the symbol can read it.
 */
export const MIGRATION_CHAIN = Symbol("kyneta:migrationChain")

// ---------------------------------------------------------------------------
// NodeIdentity — opaque 128-bit identity hash
// ---------------------------------------------------------------------------

/**
 * Opaque 128-bit node identity, hex-encoded.
 *
 * Two nodes with the same identity refer to the same logical entity
 * across schema versions. Identity is derived deterministically from
 * the node's origin path and generation number.
 */
export type NodeIdentity = string & { readonly __brand: "NodeIdentity" }

// ---------------------------------------------------------------------------
// IdentityOrigin — birth record for a single node
// ---------------------------------------------------------------------------

/**
 * Origin record for a single node — enough to derive its identity.
 *
 * `originPath` is the canonical schema path at which the node was
 * first introduced (or last reintroduced after destruction).
 * `generation` is 1-based and increments on destroy+recreate at
 * the same path.
 */
export type IdentityOrigin = {
  readonly originPath: string
  readonly generation: number
}

// ---------------------------------------------------------------------------
// IdentityManifest — flat map from current paths to origins
// ---------------------------------------------------------------------------

/**
 * The identity manifest — a flat map from current schema paths to
 * their origin records. This is the collapsed output of replaying
 * a migration chain, and the input to `deriveSchemaBinding`.
 */
export type IdentityManifest = Readonly<Record<string, IdentityOrigin>>

// ---------------------------------------------------------------------------
// SchemaBinding — forward + inverse identity maps
// ---------------------------------------------------------------------------

/**
 * A schema binding maps between schema paths and node identities.
 *
 * - `forward`: schema path → NodeIdentity (used by substrates to
 *   key containers by identity instead of field name).
 * - `inverse`: NodeIdentity → schema path (used by event bridges
 *   to reverse-map identity keys back to schema paths).
 *
 * Computed at bind() time from the identity manifest.
 */
export type SchemaBinding = {
  readonly forward: ReadonlyMap<string, NodeIdentity>
  readonly inverse: ReadonlyMap<NodeIdentity, string>
}

// ---------------------------------------------------------------------------
// MigrationTier — tier classification
// ---------------------------------------------------------------------------

/**
 * Tier classification for a migration primitive or composite step.
 *
 * T0: Additive — no coordination needed.
 * T1a: Identity-preserving rename — no coordination needed.
 * T2: Lossy projection — requires .drop() acknowledgment.
 * T3: Epoch boundary — requires fromEntirety + canReset governance.
 */
export type MigrationTier = "T0" | "T1a" | "T2" | "T3"

// ---------------------------------------------------------------------------
// Tier ordering — for max(tier) composition
// ---------------------------------------------------------------------------

const TIER_ORDER: Record<MigrationTier, number> = {
  T0: 0,
  T1a: 1,
  T2: 2,
  T3: 3,
}

function maxTier(a: MigrationTier, b: MigrationTier): MigrationTier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b
}

// ---------------------------------------------------------------------------
// TransformProof — optional proof for promoting transform primitives
// ---------------------------------------------------------------------------

/**
 * Developer-provided proofs for a `transform` primitive.
 *
 * When all three are true on a plain-kind node, the transform promotes
 * to T1a. The system does not verify proofs — it trusts the developer.
 */
export type TransformProof = {
  readonly idempotent?: boolean
  readonly crdtHomomorphism?: boolean
  readonly bijective?: boolean
}

// ---------------------------------------------------------------------------
// MigrationPrimitive — a single migration operation
// ---------------------------------------------------------------------------

/**
 * A single migration primitive. The `kind` discriminant determines
 * the tier, identity delta, and preconditions.
 */
export type MigrationPrimitive =
  // T0: Additive
  | { readonly kind: "add"; readonly path: string }
  | { readonly kind: "addVariant"; readonly path: string; readonly tag: string }
  | {
      readonly kind: "widenConstraint"
      readonly path: string
      readonly values: readonly unknown[]
    }
  | { readonly kind: "addNullable"; readonly path: string }
  // T1a: Identity-preserving rename
  | { readonly kind: "rename"; readonly from: string; readonly to: string }
  | { readonly kind: "move"; readonly from: string; readonly to: string }
  | {
      readonly kind: "renameVariant"
      readonly path: string
      readonly from: string
      readonly to: string
    }
  | {
      readonly kind: "renameDiscriminant"
      readonly path: string
      readonly key: string
    }
  // T2: Lossy projection
  | {
      readonly kind: "remove"
      readonly path: string
      readonly schema: SchemaNode
    }
  | {
      readonly kind: "removeVariant"
      readonly path: string
      readonly tag: string
      readonly schema: SchemaNode
    }
  | {
      readonly kind: "narrowConstraint"
      readonly path: string
      readonly values: readonly unknown[]
    }
  | { readonly kind: "dropNullable"; readonly path: string }
  // T3: Epoch boundary
  | {
      readonly kind: "retype"
      readonly path: string
      readonly coerce?: (v: unknown) => unknown
    }
  | {
      readonly kind: "transform"
      readonly path: string
      readonly fn: (v: unknown) => unknown
      readonly inv?: (v: unknown) => unknown
      readonly proof?: TransformProof
    }

// ---------------------------------------------------------------------------
// T2 primitive kinds — the set requiring .drop() acknowledgment
// ---------------------------------------------------------------------------

/** The kind strings of T2 primitives. */
type T2Kind = "remove" | "removeVariant" | "narrowConstraint" | "dropNullable"

/** Extract the T2 subset of MigrationPrimitive. */
export type T2Primitive = Extract<MigrationPrimitive, { kind: T2Kind }>

/** Extract the non-T2 subset of MigrationPrimitive. */
export type NonT2Primitive = Exclude<MigrationPrimitive, { kind: T2Kind }>

// ---------------------------------------------------------------------------
// Droppable — T2 primitive requiring .drop() before use in .migrated()
// ---------------------------------------------------------------------------

/**
 * A T2 primitive that requires `.drop()` acknowledgment before it can
 * be passed to `.migrated()`. This enforces compile-time awareness of
 * data loss.
 */
export type Droppable<P extends T2Primitive = T2Primitive> = {
  readonly primitive: P
  /** Acknowledge the data loss and return a DroppedPrimitive. */
  drop(): DroppedPrimitive
}

// ---------------------------------------------------------------------------
// DroppedPrimitive — T2 primitive wrapped with .drop()
// ---------------------------------------------------------------------------

/**
 * T2 primitive wrapped with `.drop()`.
 * This is the only form in which T2 primitives are accepted by `.migrated()`.
 */
export type DroppedPrimitive = {
  readonly primitive: MigrationPrimitive
  readonly dropped: true
}

// ---------------------------------------------------------------------------
// MigrationInput — what .migrated() accepts
// ---------------------------------------------------------------------------

/**
 * The types accepted by `.migrated()`: non-T2 primitives directly,
 * or T2 primitives wrapped via `.drop()`.
 */
export type MigrationInput = NonT2Primitive | DroppedPrimitive

// ---------------------------------------------------------------------------
// MigrationStep — one .migrated() call
// ---------------------------------------------------------------------------

/**
 * A migration step — one `.migrated()` call. Contains one or more
 * primitives and the composite tier (max of component tiers).
 */
export type MigrationStep = {
  readonly kind: "migration"
  readonly primitives: readonly (MigrationPrimitive | DroppedPrimitive)[]
  readonly tier: MigrationTier
}

// ---------------------------------------------------------------------------
// EpochStep — one .epoch() call
// ---------------------------------------------------------------------------

/**
 * An epoch boundary — one `.epoch()` call. Epoch entries reset all
 * identity tracking (fresh origin for all surviving nodes). T3 primitives
 * like `retype` and `transform` live here.
 */
export type EpochStep = {
  readonly kind: "epoch"
  readonly primitives: readonly MigrationPrimitive[]
}

// ---------------------------------------------------------------------------
// MigrationChainEntry — discriminated union of step types
// ---------------------------------------------------------------------------

/** A single entry in the migration chain. */
export type MigrationChainEntry = MigrationStep | EpochStep

// ---------------------------------------------------------------------------
// MigrationChain — the full chain attached to a schema
// ---------------------------------------------------------------------------

/**
 * The full migration chain attached to a schema via `[MIGRATION_CHAIN]`.
 *
 * `base` is a pre-computed identity manifest from a pruned history
 * (set by `.migrationBase()`). `entries` is the ordered list of
 * migration steps and epoch boundaries.
 */
export type MigrationChain = {
  readonly base: IdentityManifest | null
  readonly entries: readonly MigrationChainEntry[]
}

// ---------------------------------------------------------------------------
// isDropped — type guard
// ---------------------------------------------------------------------------

/** Type guard: is this input a DroppedPrimitive? */
function isDropped(input: MigrationInput): input is DroppedPrimitive {
  return "dropped" in input && (input as DroppedPrimitive).dropped === true
}

// ---------------------------------------------------------------------------
// unwrapPrimitive — extract the MigrationPrimitive from any input
// ---------------------------------------------------------------------------

/** Extract the underlying MigrationPrimitive from any input form. */
function unwrapPrimitive(
  input: MigrationPrimitive | DroppedPrimitive,
): MigrationPrimitive {
  if ("dropped" in input && (input as DroppedPrimitive).dropped === true) {
    return (input as DroppedPrimitive).primitive
  }
  return input as MigrationPrimitive
}

// =========================================================================
// Migration namespace — constructor functions for all 14 primitives
// =========================================================================

function createDroppable<P extends T2Primitive>(primitive: P): Droppable<P> {
  return {
    primitive,
    drop(): DroppedPrimitive {
      return { primitive, dropped: true }
    },
  }
}

/**
 * The `Migration` namespace provides constructor functions for all
 * migration primitives.
 *
 * T0/T1a/T3 primitives return `MigrationPrimitive` directly.
 * T2 primitives return `Droppable<P>` — call `.drop()` to acknowledge
 * data loss before passing to `.migrated()`.
 *
 * @example
 * ```ts
 * schema
 *   .migrated(Migration.add("newField"))
 *   .migrated(Migration.rename("old", "new"))
 *   .migrated(Migration.remove("obsolete", Schema.string()).drop())
 * ```
 */
export const Migration = {
  // -- T0: Additive -------------------------------------------------------

  add(path: string): MigrationPrimitive & { kind: "add" } {
    return { kind: "add", path }
  },

  addVariant(
    path: string,
    tag: string,
  ): MigrationPrimitive & { kind: "addVariant" } {
    return { kind: "addVariant", path, tag }
  },

  widenConstraint(
    path: string,
    values: readonly unknown[],
  ): MigrationPrimitive & { kind: "widenConstraint" } {
    return { kind: "widenConstraint", path, values }
  },

  addNullable(path: string): MigrationPrimitive & { kind: "addNullable" } {
    return { kind: "addNullable", path }
  },

  // -- T1a: Identity-preserving rename ------------------------------------

  rename(from: string, to: string): MigrationPrimitive & { kind: "rename" } {
    return { kind: "rename", from, to }
  },

  move(from: string, to: string): MigrationPrimitive & { kind: "move" } {
    return { kind: "move", from, to }
  },

  renameVariant(
    path: string,
    from: string,
    to: string,
  ): MigrationPrimitive & { kind: "renameVariant" } {
    return { kind: "renameVariant", path, from, to }
  },

  renameDiscriminant(
    path: string,
    key: string,
  ): MigrationPrimitive & { kind: "renameDiscriminant" } {
    return { kind: "renameDiscriminant", path, key }
  },

  // -- T2: Lossy projection -----------------------------------------------

  remove(
    path: string,
    schema: SchemaNode,
  ): Droppable<T2Primitive & { kind: "remove" }> {
    return createDroppable({ kind: "remove", path, schema })
  },

  removeVariant(
    path: string,
    tag: string,
    schema: SchemaNode,
  ): Droppable<T2Primitive & { kind: "removeVariant" }> {
    return createDroppable({ kind: "removeVariant", path, tag, schema })
  },

  narrowConstraint(
    path: string,
    values: readonly unknown[],
  ): Droppable<T2Primitive & { kind: "narrowConstraint" }> {
    return createDroppable({ kind: "narrowConstraint", path, values })
  },

  dropNullable(
    path: string,
  ): Droppable<T2Primitive & { kind: "dropNullable" }> {
    return createDroppable({ kind: "dropNullable", path })
  },

  // -- T3: Epoch boundary --------------------------------------------------

  retype(
    path: string,
    coerce?: (v: unknown) => unknown,
  ): MigrationPrimitive & { kind: "retype" } {
    return coerce !== undefined
      ? { kind: "retype", path, coerce }
      : { kind: "retype", path }
  },

  transform(
    path: string,
    fn: (v: unknown) => unknown,
    inv?: (v: unknown) => unknown,
    proof?: TransformProof,
  ): MigrationPrimitive & { kind: "transform" } {
    const result: any = { kind: "transform", path, fn }
    if (inv !== undefined) result.inv = inv
    if (proof !== undefined) result.proof = proof
    return result
  },
} as const

// =========================================================================
// deriveTier — classify a single primitive
// =========================================================================

/**
 * Derive the tier of a single migration primitive.
 *
 * The tier is a static property of the primitive kind, with one
 * exception: `transform` defaults to T3 but can be promoted via proofs.
 *
 * The `_sourceSchema` and `_targetSchema` parameters are reserved for
 * future T1b dispatch (structural bijection on plain-kind nodes).
 * Currently unused.
 */
export function deriveTier(
  primitive: MigrationPrimitive,
  _sourceSchema?: SchemaNode,
  _targetSchema?: SchemaNode,
): MigrationTier {
  switch (primitive.kind) {
    // T0: Additive
    case "add":
    case "addVariant":
    case "widenConstraint":
    case "addNullable":
      return "T0"

    // T1a: Identity-preserving rename
    case "rename":
    case "move":
    case "renameVariant":
    case "renameDiscriminant":
      return "T1a"

    // T2: Lossy projection
    case "remove":
    case "removeVariant":
    case "narrowConstraint":
    case "dropNullable":
      return "T2"

    // T3: Epoch boundary
    case "retype":
      return "T3"

    case "transform": {
      // transform defaults to T3 but can be promoted via proofs.
      // With all three proofs, promotes to T1a (trusted, not verified).
      const p = primitive.proof
      if (p?.idempotent && p?.crdtHomomorphism && p?.bijective) {
        return "T1a"
      }
      return "T3"
    }
  }
}

// =========================================================================
// deriveStepTier — composite tier for a migration step
// =========================================================================

/**
 * Compute the composite tier for a list of primitives/dropped inputs.
 * The composite tier is the maximum of all component tiers.
 */
export function deriveStepTier(
  inputs: readonly (MigrationPrimitive | DroppedPrimitive)[],
): MigrationTier {
  let tier: MigrationTier = "T0"
  for (const input of inputs) {
    const prim =
      "dropped" in input && (input as DroppedPrimitive).dropped
        ? (input as DroppedPrimitive).primitive
        : (input as MigrationPrimitive)
    tier = maxTier(tier, deriveTier(prim))
  }
  return tier
}

// =========================================================================
// deriveIdentity — NodeIdentity from origin path + generation
// =========================================================================

/**
 * Derive a deterministic NodeIdentity from an origin path and generation.
 *
 * `fnv1a128(originPath + ":" + generation)` — stable across runs,
 * across machines, across time.
 */
export function deriveIdentity(
  originPath: string,
  generation: number,
): NodeIdentity {
  return fnv1a128(`${originPath}:${generation}`) as NodeIdentity
}

// =========================================================================
// deriveManifest — replay a migration chain to produce an identity manifest
// =========================================================================

/**
 * Collect all paths in a product schema (non-recursive — root fields only).
 *
 * Returns an array of field names from the product's `fields` record.
 * Nested products are leaf nodes at this level — their internal fields
 * are handled by `deriveSchemaBinding` when it walks the tree.
 */
function collectProductPaths(schema: ProductSchema): string[] {
  return Object.keys(schema.fields).sort()
}

/**
 * Derive the identity manifest by replaying a migration chain.
 *
 * The manifest maps each current schema path to its `IdentityOrigin`.
 * For schemas with no migration history, every path maps to
 * `{ originPath: path, generation: 1 }`.
 *
 * Algorithm:
 * 1. Start from the base manifest (if present) or a trivial manifest
 *    derived by reverse-engineering the schema before all migrations.
 * 2. Replay each chain entry in order:
 *    - MigrationStep: apply each primitive's identity delta.
 *    - EpochStep: reset all tracking — every surviving path gets a
 *      fresh origin `{ originPath: path, generation: 1 }`.
 *
 * The manifest tracks:
 * - `origins: Map<path, IdentityOrigin>` — current path → origin
 * - `generations: Map<originPath, maxGeneration>` — tracks destroy+recreate
 */
export function deriveManifest(
  schema: ProductSchema,
  chain: MigrationChain,
): IdentityManifest {
  const currentPaths = collectProductPaths(schema)

  // If no chain entries and no base, produce the trivial manifest.
  if (chain.entries.length === 0 && chain.base === null) {
    const manifest: Record<string, IdentityOrigin> = {}
    for (const path of currentPaths) {
      manifest[path] = { originPath: path, generation: 1 }
    }
    return manifest
  }

  // Start from base manifest or compute the pre-migration path set.
  // The origins map tracks: currentPath → { originPath, generation }
  const origins = new Map<string, IdentityOrigin>()

  // Track the maximum generation seen for each originPath, so that
  // destroy+recreate at the same path increments the generation.
  const generations = new Map<string, number>()

  if (chain.base !== null) {
    // Seed from the pruned base manifest.
    for (const [path, origin] of Object.entries(chain.base)) {
      origins.set(path, origin)
      const existing = generations.get(origin.originPath) ?? 0
      generations.set(origin.originPath, Math.max(existing, origin.generation))
    }
  } else {
    // No base — reconstruct the pre-migration path set by undoing
    // all chain entries in reverse to find what paths existed before
    // the first migration. This is a reverse walk: renames undo,
    // adds undo (remove), removes undo (add).
    const preMigrationPaths = new Set(currentPaths)
    for (let i = chain.entries.length - 1; i >= 0; i--) {
      const entry = chain.entries[i]
      if (!entry) continue
      if (entry.kind === "epoch") {
        // Epoch resets everything — paths before the epoch are
        // unknowable from the chain alone. The pre-epoch state
        // is determined by the epoch's primitives (if any) applied
        // to the post-epoch paths.
        // For epoch entries, we stop reverse-walking — everything
        // before the epoch is a fresh start.
        break
      }
      const primitives = entry.primitives.map(unwrapPrimitive)
      // Undo in reverse order within the step
      for (let j = primitives.length - 1; j >= 0; j--) {
        const prim = primitives[j]
        if (!prim) continue
        switch (prim.kind) {
          case "add":
            preMigrationPaths.delete(prim.path)
            break
          case "remove":
            preMigrationPaths.add(prim.path)
            break
          case "rename":
            preMigrationPaths.delete(prim.to)
            preMigrationPaths.add(prim.from)
            break
          case "move":
            preMigrationPaths.delete(prim.to)
            preMigrationPaths.add(prim.from)
            break
          // Variant-level and constraint primitives don't affect
          // root product paths.
          default:
            break
        }
      }
    }

    // Seed origins from pre-migration paths
    for (const path of preMigrationPaths) {
      origins.set(path, { originPath: path, generation: 1 })
      generations.set(path, 1)
    }
  }

  // Forward replay: apply each entry in order.
  for (const entry of chain.entries) {
    if (entry.kind === "epoch") {
      // Epoch resets all identity tracking. Every path that survives
      // the epoch gets a fresh origin. Paths destroyed by epoch
      // primitives are removed.
      //
      // First, apply epoch primitives (retype, transform, etc.)
      // These may destroy+recreate paths.
      for (const prim of entry.primitives) {
        applyPrimitiveDelta(prim, origins, generations)
      }

      // Then reset: every surviving path gets a fresh origin.
      const surviving = new Map(origins)
      origins.clear()
      for (const [path] of surviving) {
        const gen = (generations.get(path) ?? 0) + 1
        generations.set(path, gen)
        origins.set(path, { originPath: path, generation: gen })
      }
      continue
    }

    // MigrationStep: apply each primitive's identity delta.
    for (const input of entry.primitives) {
      const prim = unwrapPrimitive(input)
      applyPrimitiveDelta(prim, origins, generations)
    }
  }

  // Build the final manifest from the origins map, filtered to
  // only include paths that exist in the current schema.
  const manifest: Record<string, IdentityOrigin> = {}
  for (const path of currentPaths) {
    const origin = origins.get(path)
    if (origin) {
      manifest[path] = origin
    } else {
      // Path exists in current schema but has no origin from the chain.
      // This can happen for paths added after the last chain entry.
      // Assign a trivial origin.
      manifest[path] = { originPath: path, generation: 1 }
    }
  }
  return manifest
}

// ---------------------------------------------------------------------------
// applyPrimitiveDelta — mutate the origins map for a single primitive
// ---------------------------------------------------------------------------

function applyPrimitiveDelta(
  prim: MigrationPrimitive,
  origins: Map<string, IdentityOrigin>,
  generations: Map<string, number>,
): void {
  switch (prim.kind) {
    case "add": {
      // Creates a new identity at path.
      const gen = (generations.get(prim.path) ?? 0) + 1
      generations.set(prim.path, gen)
      origins.set(prim.path, { originPath: prim.path, generation: gen })
      break
    }

    case "remove": {
      // Destroys the identity at path.
      origins.delete(prim.path)
      break
    }

    case "rename": {
      // Preserves identity: move origin from `from` to `to`.
      const origin = origins.get(prim.from)
      if (origin) {
        origins.delete(prim.from)
        origins.set(prim.to, origin)
      }
      break
    }

    case "move": {
      // Same as rename — preserves identity at a new path.
      const origin = origins.get(prim.from)
      if (origin) {
        origins.delete(prim.from)
        origins.set(prim.to, origin)
      }
      break
    }

    case "retype": {
      // Destroys old identity, creates new at same path.
      origins.delete(prim.path)
      const gen = (generations.get(prim.path) ?? 0) + 1
      generations.set(prim.path, gen)
      origins.set(prim.path, { originPath: prim.path, generation: gen })
      break
    }

    case "transform": {
      // Default T3 behavior: destroy + recreate (like retype).
      // Promoted transforms (with full proofs) preserve identity,
      // but since we don't verify proofs we treat them uniformly:
      // if the tier is T1a (all proofs), preserve; otherwise destroy+create.
      const tier = deriveTier(prim)
      if (tier === "T1a") {
        // Identity-preserving — no delta
        break
      }
      // T3: destroy + recreate
      origins.delete(prim.path)
      const gen = (generations.get(prim.path) ?? 0) + 1
      generations.set(prim.path, gen)
      origins.set(prim.path, { originPath: prim.path, generation: gen })
      break
    }

    // Variant-level and constraint primitives don't affect product-level
    // identity (they modify the type at a path, not the path itself).
    case "addVariant":
    case "removeVariant":
    case "widenConstraint":
    case "narrowConstraint":
    case "addNullable":
    case "dropNullable":
    case "renameVariant":
    case "renameDiscriminant":
      // No identity delta at the product-path level.
      break
  }
}

// =========================================================================
// deriveSchemaBinding — recursive binding from schema + manifest
// =========================================================================

/**
 * Derive a SchemaBinding from a product schema and its identity manifest.
 *
 * Walks the schema tree recursively. For each product field at the
 * current level, computes the NodeIdentity from the manifest's origin.
 * Nested ProductSchema children with their own `[MIGRATION_CHAIN]` are
 * handled by first deriving the nested manifest (with paths prefixed by
 * the nesting position), then recursing.
 *
 * @param schema - The root (or nested) ProductSchema
 * @param manifest - The identity manifest for this schema level
 * @param prefix - The path prefix for nested schemas (empty for root)
 */
export function deriveSchemaBinding(
  schema: ProductSchema,
  manifest: IdentityManifest,
  prefix = "",
): SchemaBinding {
  const forward = new Map<string, NodeIdentity>()
  const inverse = new Map<NodeIdentity, string>()

  deriveBindingRecursive(schema, manifest, prefix, forward, inverse)

  return { forward, inverse }
}

function deriveBindingRecursive(
  schema: ProductSchema,
  manifest: IdentityManifest,
  prefix: string,
  forward: Map<string, NodeIdentity>,
  inverse: Map<NodeIdentity, string>,
): void {
  for (const [fieldName, fieldSchema] of Object.entries(schema.fields)) {
    const absolutePath = prefix ? `${prefix}.${fieldName}` : fieldName
    const origin = manifest[absolutePath]

    if (origin) {
      const identity = deriveIdentity(origin.originPath, origin.generation)
      forward.set(absolutePath, identity)
      inverse.set(identity, absolutePath)
    } else {
      // No origin in manifest — use trivial identity.
      const identity = deriveIdentity(absolutePath, 1)
      forward.set(absolutePath, identity)
      inverse.set(identity, absolutePath)
    }

    // Recurse into nested product schemas.
    const node = fieldSchema as SchemaNode
    if (node[KIND] === "product") {
      const nestedSchema = node as ProductSchema
      const nestedChain = (nestedSchema as any)[MIGRATION_CHAIN] as
        | MigrationChain
        | undefined

      if (nestedChain) {
        // Nested schema has its own migration chain. Derive its manifest
        // with the nesting prefix, then recurse.
        const nestedManifest = deriveNestedManifest(
          nestedSchema,
          nestedChain,
          absolutePath,
        )
        deriveBindingRecursive(
          nestedSchema,
          nestedManifest,
          absolutePath,
          forward,
          inverse,
        )
      } else {
        // No nested chain — recurse with the parent manifest
        // (which already contains absolute-path entries).
        deriveBindingRecursive(
          nestedSchema,
          manifest,
          absolutePath,
          forward,
          inverse,
        )
      }
    }
  }
}

/**
 * Derive a manifest for a nested schema by prefixing all paths.
 *
 * The nested chain's primitives use relative paths (e.g. "zip").
 * We derive the manifest in relative space, then prefix every entry
 * with the nesting path to produce absolute-path origins.
 */
function deriveNestedManifest(
  nestedSchema: ProductSchema,
  nestedChain: MigrationChain,
  nestingPrefix: string,
): IdentityManifest {
  // Derive manifest in relative (nested) space.
  const relativeManifest = deriveManifest(nestedSchema, nestedChain)

  // Prefix all paths to produce absolute origins.
  const absoluteManifest: Record<string, IdentityOrigin> = {}
  for (const [relativePath, origin] of Object.entries(relativeManifest)) {
    const absolutePath = `${nestingPrefix}.${relativePath}`
    // The originPath also needs to be absolute for identity derivation
    // to produce unique hashes across different nesting positions.
    const absoluteOriginPath = `${nestingPrefix}.${origin.originPath}`
    absoluteManifest[absolutePath] = {
      originPath: absoluteOriginPath,
      generation: origin.generation,
    }
  }
  return absoluteManifest
}

// =========================================================================
// migrationMethods — mixin for ProductSchema
// =========================================================================

/**
 * Create the migration methods mixin for a ProductSchema.
 *
 * These methods are mixed into every ProductSchema via Object.assign
 * in the product() constructor. They return new schema values with
 * updated [MIGRATION_CHAIN] metadata — the source schema is never mutated.
 */
export const migrationMethods = {
  /**
   * Append a migration step to this schema's chain.
   *
   * Accepts one or more MigrationInput values (non-T2 primitives directly,
   * or T2 primitives wrapped via .drop()). Returns a new schema with
   * the step appended.
   */
  migrated(this: ProductSchema, ...inputs: MigrationInput[]): ProductSchema {
    if (inputs.length === 0) {
      throw new Error("migrated() requires at least one migration primitive")
    }

    const existingChain = getChain(this)
    const primitives: (MigrationPrimitive | DroppedPrimitive)[] = inputs.map(
      input => {
        if (isDropped(input)) return input
        return input as MigrationPrimitive
      },
    )

    const tier = deriveStepTier(primitives)
    const step: MigrationStep = { kind: "migration", primitives, tier }

    const newChain: MigrationChain = {
      base: existingChain.base,
      entries: [...existingChain.entries, step],
    }

    return cloneWithChain(this, newChain)
  },

  /**
   * Append an epoch boundary to this schema's chain.
   *
   * Accepts zero or more MigrationPrimitive values (T3 primitives like
   * retype, transform, or none for a bare epoch reset).
   */
  epoch(
    this: ProductSchema,
    ...primitives: MigrationPrimitive[]
  ): ProductSchema {
    const existingChain = getChain(this)
    const step: EpochStep = { kind: "epoch", primitives }

    const newChain: MigrationChain = {
      base: existingChain.base,
      entries: [...existingChain.entries, step],
    }

    return cloneWithChain(this, newChain)
  },

  /**
   * Set the base identity manifest for this schema's chain.
   *
   * Must be called before any .migrated() or .epoch() — enforced at
   * runtime. The base manifest captures the pruned identity state from
   * a previous migration history.
   */
  migrationBase(
    this: ProductSchema,
    manifest: IdentityManifest,
  ): ProductSchema {
    const existingChain = getChain(this)
    if (existingChain.entries.length > 0) {
      throw new Error(
        "migrationBase() must be called before any migrated() or epoch() calls. " +
          `This schema already has ${existingChain.entries.length} chain entries.`,
      )
    }
    if (existingChain.base !== null) {
      throw new Error("migrationBase() has already been called on this schema.")
    }

    const newChain: MigrationChain = {
      base: manifest,
      entries: [],
    }

    return cloneWithChain(this, newChain)
  },
}

// ---------------------------------------------------------------------------
// Internal helpers for migration methods
// ---------------------------------------------------------------------------

/** Get the existing chain from a schema, or create an empty one. */
function getChain(schema: ProductSchema): MigrationChain {
  const chain = (schema as any)[MIGRATION_CHAIN] as MigrationChain | undefined
  return chain ?? { base: null, entries: [] }
}

/** Clone a ProductSchema with a new migration chain. Immutable. */
function cloneWithChain(
  schema: ProductSchema,
  chain: MigrationChain,
): ProductSchema {
  const clone = Object.assign({}, schema)
  // Copy existing methods (migrated, epoch, migrationBase) to the clone
  // so chaining continues to work.
  Object.assign(clone, migrationMethods)
  Object.defineProperty(clone, MIGRATION_CHAIN, {
    value: chain,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return clone
}

// =========================================================================
// Convenience: read chain from a schema
// =========================================================================

/**
 * Read the migration chain from a schema, if present.
 * Returns null if the schema has no migration history.
 */
export function getMigrationChain(schema: SchemaNode): MigrationChain | null {
  if (schema[KIND] !== "product") return null
  return ((schema as any)[MIGRATION_CHAIN] as MigrationChain) ?? null
}

// =========================================================================
// snapshotManifest — collapse a full chain into an identity manifest
// =========================================================================

/**
 * Replay the full migration chain on a schema and return the collapsed
 * identity manifest. This is the core of the pruning operation.
 *
 * Usage: developer runs `snapshotManifest(schema)`, then replaces
 * the `.migrated()` chain with `.migrationBase(manifest)`.
 */
export function snapshotManifest(schema: ProductSchema): IdentityManifest {
  const chain = getMigrationChain(schema as any)
  if (!chain) {
    // No chain — return trivial manifest
    const manifest: Record<string, IdentityOrigin> = {}
    for (const key of Object.keys(schema.fields).sort()) {
      manifest[key] = { originPath: key, generation: 1 }
    }
    return manifest
  }
  return deriveManifest(schema, chain)
}

// =========================================================================
// validateChain — validate a migration chain for consistency
// =========================================================================

/**
 * Validate a migration chain for consistency.
 *
 * Replays the chain, verifying each step produces consistent intermediate
 * schemas. Detects:
 * - Path collisions: rename/move to a path that already exists
 * - Missing paths: rename/move/remove of a path that doesn't exist
 * - Multiple adds to the same path without an intervening remove
 *
 * Returns `{ valid: true }` on success, or `{ valid: false, errors: [...] }`
 * with descriptive error messages.
 */
export function validateChain(schema: ProductSchema): {
  valid: boolean
  errors: string[]
} {
  const chain = getMigrationChain(schema as any)
  if (!chain) return { valid: true, errors: [] }

  const errors: string[] = []

  // Compute current paths from schema
  const currentPaths = new Set(collectProductPaths(schema))

  // Reconstruct pre-migration paths by undoing chain (same logic as deriveManifest)
  const knownPaths = new Set<string>()

  // Start from current paths and undo the chain to find starting paths
  const startPaths = new Set(currentPaths)
  for (let i = chain.entries.length - 1; i >= 0; i--) {
    const entry = chain.entries[i]
    if (!entry) continue
    if (entry.kind === "epoch") break // epoch = fresh start

    const primitives = entry.primitives.map(unwrapPrimitive)

    for (let j = primitives.length - 1; j >= 0; j--) {
      const prim = primitives[j]
      if (!prim) continue
      switch (prim.kind) {
        case "add":
          startPaths.delete(prim.path)
          break
        case "remove":
          startPaths.add(prim.path)
          break
        case "rename":
          startPaths.delete(prim.to)
          startPaths.add(prim.from)
          break
        case "move":
          startPaths.delete(prim.to)
          startPaths.add(prim.from)
          break
        default:
          break
      }
    }
  }

  // Forward replay with validation
  for (const p of startPaths) knownPaths.add(p)

  // If there's a base manifest, use those paths instead
  if (chain.base) {
    knownPaths.clear()
    for (const p of Object.keys(chain.base)) knownPaths.add(p)
  }

  for (let i = 0; i < chain.entries.length; i++) {
    const entry = chain.entries[i]
    if (!entry) continue

    if (entry.kind === "epoch") {
      // Epoch entries: validate primitives then continue
      for (const prim of entry.primitives) {
        validatePrimitive(prim, knownPaths, errors, i)
      }
      continue
    }

    const primitives = entry.primitives.map(unwrapPrimitive)

    for (const prim of primitives) {
      validatePrimitive(prim, knownPaths, errors, i)
    }
  }

  return { valid: errors.length === 0, errors }
}

function validatePrimitive(
  prim: MigrationPrimitive,
  knownPaths: Set<string>,
  errors: string[],
  stepIndex: number,
): void {
  switch (prim.kind) {
    case "add":
      if (knownPaths.has(prim.path)) {
        errors.push(
          `Step ${stepIndex}: add("${prim.path}") — path already exists`,
        )
      } else {
        knownPaths.add(prim.path)
      }
      break
    case "remove":
      if (!knownPaths.has(prim.path)) {
        errors.push(
          `Step ${stepIndex}: remove("${prim.path}") — path does not exist`,
        )
      } else {
        knownPaths.delete(prim.path)
      }
      break
    case "rename":
      if (!knownPaths.has(prim.from)) {
        errors.push(
          `Step ${stepIndex}: rename("${prim.from}", "${prim.to}") — source path does not exist`,
        )
      }
      if (knownPaths.has(prim.to)) {
        errors.push(
          `Step ${stepIndex}: rename("${prim.from}", "${prim.to}") — target path already exists`,
        )
      }
      knownPaths.delete(prim.from)
      knownPaths.add(prim.to)
      break
    case "move":
      if (!knownPaths.has(prim.from)) {
        errors.push(
          `Step ${stepIndex}: move("${prim.from}", "${prim.to}") — source path does not exist`,
        )
      }
      if (knownPaths.has(prim.to)) {
        errors.push(
          `Step ${stepIndex}: move("${prim.from}", "${prim.to}") — target path already exists`,
        )
      }
      knownPaths.delete(prim.from)
      knownPaths.add(prim.to)
      break
    case "retype":
      if (!knownPaths.has(prim.path)) {
        errors.push(
          `Step ${stepIndex}: retype("${prim.path}") — path does not exist`,
        )
      }
      break
    case "transform":
      if (!knownPaths.has(prim.path)) {
        errors.push(
          `Step ${stepIndex}: transform("${prim.path}") — path does not exist`,
        )
      }
      break
    // Variant/constraint/nullable primitives don't affect product-level paths
    default:
      break
  }
}
