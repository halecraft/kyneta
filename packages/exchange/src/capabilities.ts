// capabilities — registry of supported replica types and schema bindings.
//
// The Capabilities registry is the exchange's knowledge base: it knows
// which ReplicaType + MergeStrategy pairs this participant supports,
// and which BoundSchemas map to which replicas. Conduit participants
// (relay servers, stores) register only replicas; application servers
// and clients additionally register schemas.
//
// The registry is keyed by `ReplicaKey` — a composite of replica name,
// major version, and merge strategy — giving O(1) lookup for both
// schema resolution and replica-type support checks.

import type {
  BoundSchema,
  FactoryBuilder,
  MergeStrategy,
} from "@kyneta/schema"
import {
  BoundReplica,
  lwwReplicaFactory,
  plainReplicaFactory,
  replicaTypesCompatible,
} from "@kyneta/schema"
import type {
  ReplicaFactory,
  ReplicaType,
  SubstrateFactory,
} from "@kyneta/schema"

// ---------------------------------------------------------------------------
// ReplicaKey — composite lookup key
// ---------------------------------------------------------------------------

/**
 * Composite key for the capabilities registry.
 *
 * Encodes `${replicaTypeName}:${replicaTypeMajor}:${mergeStrategy}` so
 * that a single `Map` lookup resolves both the replica factory and all
 * schemas bound to that replication tier.
 */
type ReplicaKey = string // `${name}:${major}:${strategy}`

/**
 * An entry in the capabilities registry: a replica binding and all
 * schemas registered against it, keyed by schema hash.
 */
type ReplicaEntry = {
  replica: BoundReplica
  schemas: Map<string /* schemaHash */, BoundSchema>
}

// ---------------------------------------------------------------------------
// replicaKey — deterministic key construction
// ---------------------------------------------------------------------------

/**
 * Compute the composite `ReplicaKey` from a `ReplicaType` and
 * `MergeStrategy`. Two entries share a key iff they are replication-
 * compatible (same name, same major) and use the same sync algorithm.
 */
function replicaKey(replicaType: ReplicaType, strategy: MergeStrategy): ReplicaKey {
  return `${replicaType[0]}:${replicaType[1]}:${strategy}`
}

// ---------------------------------------------------------------------------
// DEFAULT_REPLICAS — out-of-the-box replica bindings
// ---------------------------------------------------------------------------

/**
 * Default replica bindings shipped with the exchange.
 *
 * - **plain / sequential**: monotonic-version plain JS objects with
 *   request/response sync.
 * - **lww / lww**: timestamp-versioned plain JS objects with
 *   last-writer-wins broadcast (ephemeral/presence state).
 *
 * Consumers can extend this set by passing additional replicas to
 * `createCapabilities`.
 */
export const DEFAULT_REPLICAS: readonly BoundReplica[] = [
  BoundReplica(plainReplicaFactory, "sequential"),
  BoundReplica(lwwReplicaFactory, "lww"),
]

// ---------------------------------------------------------------------------
// Capabilities — public interface
// ---------------------------------------------------------------------------

/**
 * The exchange's capability registry.
 *
 * Tracks which replica types and schemas this participant supports,
 * providing O(1) lookup for schema resolution, replica resolution,
 * and replica-type support checks.
 */
export interface Capabilities {
  /**
   * Register a schema at runtime.
   *
   * Resolves the schema's `FactoryBuilder` to a `SubstrateFactory`,
   * derives the `BoundReplica`, and indexes the schema by hash under
   * the appropriate `ReplicaKey`.
   */
  registerSchema(
    bound: BoundSchema,
    resolveFactory: (builder: FactoryBuilder) => SubstrateFactory,
  ): void

  /**
   * Look up a `BoundSchema` by its hash within a specific replication tier.
   *
   * Returns `undefined` if the schema hash is unknown or the replica
   * key has no entry.
   */
  resolveSchema(
    schemaHash: string,
    replicaType: ReplicaType,
    mergeStrategy: MergeStrategy,
  ): BoundSchema | undefined

  /**
   * Look up the `BoundReplica` for a replication tier.
   *
   * Returns `undefined` if the replica type + strategy pair is not
   * registered.
   */
  resolveReplica(
    replicaType: ReplicaType,
    mergeStrategy: MergeStrategy,
  ): BoundReplica | undefined

  /**
   * Check whether this participant can handle the given `ReplicaType`
   * (any strategy). Uses compatible semantics: same name, same major.
   */
  supportsReplicaType(replicaType: ReplicaType): boolean

  /**
   * All registered `ReplicaKey` strings. Useful for diagnostics and
   * capability advertisement in the wire protocol.
   */
  readonly supportedReplicaKeys: readonly ReplicaKey[]
}

// ---------------------------------------------------------------------------
// replicaSupportKey — O(1) support-set key
// ---------------------------------------------------------------------------

/**
 * Compute the support-set key for a `ReplicaType`. Only name and major
 * matter for compatibility (minor is tolerated).
 */
function replicaSupportKey(rt: ReplicaType): string {
  return `${rt[0]}:${rt[1]}`
}

// ---------------------------------------------------------------------------
// createCapabilities — factory
// ---------------------------------------------------------------------------

/**
 * Create a `Capabilities` registry from an initial set of replicas and
 * schemas.
 *
 * @param params.schemas - Initial schemas to register.
 * @param params.replicas - Initial replica bindings (e.g. `DEFAULT_REPLICAS`).
 * @param params.resolveFactory - Resolves a `FactoryBuilder` to a concrete
 *   `SubstrateFactory`. Typically the exchange provides this, closing over
 *   its peer identity context.
 */
export function createCapabilities(params: {
  schemas: BoundSchema[]
  replicas: BoundReplica[]
  resolveFactory: (builder: FactoryBuilder) => SubstrateFactory
}): Capabilities {
  const registry = new Map<ReplicaKey, ReplicaEntry>()
  const supportSet = new Set<string>()

  // -- helpers --------------------------------------------------------------

  function ensureEntry(key: ReplicaKey, br: BoundReplica): ReplicaEntry {
    let entry = registry.get(key)
    if (!entry) {
      entry = { replica: br, schemas: new Map() }
      registry.set(key, entry)
      supportSet.add(replicaSupportKey(br.factory.replicaType))
    }
    return entry
  }

  function addSchema(
    bound: BoundSchema,
    resolve: (builder: FactoryBuilder) => SubstrateFactory,
  ): void {
    const substrateFactory = resolve(bound.factory)
    const replicaFactory: ReplicaFactory = substrateFactory.replica
    const br = BoundReplica(replicaFactory, bound.strategy)
    const key = replicaKey(replicaFactory.replicaType, bound.strategy)

    const existing = registry.get(key)
    if (existing) {
      // Warn on factory collision: same key but different minor version
      // implies a potentially surprising mismatch.
      const existingRt = existing.replica.factory.replicaType
      const incomingRt = replicaFactory.replicaType
      if (
        existingRt[0] === incomingRt[0] &&
        existingRt[1] === incomingRt[1] &&
        existingRt[2] !== incomingRt[2]
      ) {
        console.warn(
          `[capabilities] ReplicaFactory minor version mismatch for key "${key}": ` +
            `existing minor=${existingRt[2]}, incoming minor=${incomingRt[2]}. ` +
            `Using the first-registered factory.`,
        )
      }
    }

    const entry = ensureEntry(key, br)
    entry.schemas.set(bound.schemaHash, bound)
  }

  // -- initial registration -------------------------------------------------

  for (const br of params.replicas) {
    const key = replicaKey(br.factory.replicaType, br.strategy)
    ensureEntry(key, br)
  }

  for (const bound of params.schemas) {
    addSchema(bound, params.resolveFactory)
  }

  // -- public interface -----------------------------------------------------

  return {
    registerSchema(
      bound: BoundSchema,
      resolveFactory: (builder: FactoryBuilder) => SubstrateFactory,
    ): void {
      addSchema(bound, resolveFactory)
    },

    resolveSchema(
      schemaHash: string,
      replicaType: ReplicaType,
      mergeStrategy: MergeStrategy,
    ): BoundSchema | undefined {
      const key = replicaKey(replicaType, mergeStrategy)
      return registry.get(key)?.schemas.get(schemaHash)
    },

    resolveReplica(
      replicaType: ReplicaType,
      mergeStrategy: MergeStrategy,
    ): BoundReplica | undefined {
      const key = replicaKey(replicaType, mergeStrategy)
      return registry.get(key)?.replica
    },

    supportsReplicaType(replicaType: ReplicaType): boolean {
      return supportSet.has(replicaSupportKey(replicaType))
    },

    get supportedReplicaKeys(): readonly ReplicaKey[] {
      return Array.from(registry.keys())
    },
  }
}