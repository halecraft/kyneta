// lww — LWW substrate factory using TimestampVersion strategy.
//
// The LWW (last-writer-wins) substrate delegates all state management to
// the parameterized plain substrate constructors, passing
// `timestampVersionStrategy` instead of `plainVersionStrategy`. This
// replaces version tracking with wall-clock timestamps, enabling
// cross-peer stale rejection in the synchronizer: incoming offers with
// older timestamps are discarded.
//
// The factory is consumed by `bindEphemeral()` in `bind.ts`.
//
// Architecture: the plain substrate constructors (`createPlainSubstrate`,
// `createPlainReplica`) accept a `VersionStrategy<V>` that governs
// version construction and log-to-delta mapping. LWW passes
// `timestampVersionStrategy` — same state management, different version
// algebra. No decorator, no wrapper, no `context()` gotcha.

import type { PlainState } from "../reader.js"
import type { Schema as SchemaNode } from "../schema.js"
import type {
  Replica,
  ReplicaFactory,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
} from "../substrate.js"
import { BACKING_DOC } from "../substrate.js"
import { Zero } from "../zero.js"
import type { VersionStrategy } from "./plain.js"
import {
  buildPlainReplicaFromEntirety,
  buildPlainSubstrateFromEntirety,
  createPlainReplica,
  createPlainSubstrate,
} from "./plain.js"
import { TimestampVersion } from "./timestamp-version.js"

// ---------------------------------------------------------------------------
// timestampVersionStrategy — the TimestampVersion algebra
// ---------------------------------------------------------------------------

/**
 * Version strategy for LWW substrates: wall-clock timestamp, no log
 * index mapping.
 *
 * `current()` returns `TimestampVersion.now()` — the flush count is
 * ignored because LWW versions are wall-clock timestamps, not counters.
 *
 * `logOffset()` always returns `null` — a wall-clock timestamp has no
 * relationship to the op log array index. The core falls back to
 * `exportEntirety()` when `logOffset` returns `null`.
 */
const timestampVersionStrategy: VersionStrategy<TimestampVersion> = {
  zero: new TimestampVersion(0),
  current: flushCount =>
    flushCount === 0 ? new TimestampVersion(0) : TimestampVersion.now(),
  logOffset: _since => null,
}

// ---------------------------------------------------------------------------
// lwwReplicaFactory — ReplicaFactory<TimestampVersion>
// ---------------------------------------------------------------------------

/**
 * Schema-free replica factory for LWW substrates.
 *
 * Constructs headless `Replica<TimestampVersion>` instances using the
 * parameterized plain replica constructors with `timestampVersionStrategy`.
 * Used by conduit participants and as the `replica` accessor on
 * `lwwSubstrateFactory`.
 */
export const lwwReplicaFactory: ReplicaFactory<TimestampVersion> = {
  replicaType: ["plain", 1, 0] as const,

  createEmpty(): Replica<TimestampVersion> {
    return createPlainReplica({} as PlainState, timestampVersionStrategy)
  },

  fromEntirety(payload: SubstratePayload): Replica<TimestampVersion> {
    return buildPlainReplicaFromEntirety(payload, timestampVersionStrategy)
  },

  parseVersion(serialized: string): TimestampVersion {
    return TimestampVersion.parse(serialized)
  },
}

// ---------------------------------------------------------------------------
// lwwSubstrateFactory — SubstrateFactory<TimestampVersion>
// ---------------------------------------------------------------------------

/**
 * Factory for LWW (last-writer-wins) substrates.
 *
 * Uses the parameterized plain substrate constructors with
 * `timestampVersionStrategy` for cross-peer stale rejection.
 * Consumed by `bindEphemeral()`.
 *
 * Supports two-phase construction:
 * - `createReplica()` → bare replica (empty doc, timestamp strategy)
 * - `upgrade(replica, schema)` → full substrate (conditional defaults)
 *
 * Convenience:
 * - `create(schema)` — composes `upgrade(createReplica(), schema)`
 * - `fromEntirety(payload, schema)` — reconstruct from entirety
 * - `parseVersion(serialized)` — deserialize a `TimestampVersion`
 */
export const lwwSubstrateFactory: SubstrateFactory<TimestampVersion> = {
  replica: lwwReplicaFactory,

  createReplica(): Replica<TimestampVersion> {
    return createPlainReplica({} as PlainState, timestampVersionStrategy)
  },

  upgrade(
    replica: Replica<TimestampVersion>,
    schema: SchemaNode,
  ): Substrate<TimestampVersion> {
    const doc = (replica as any)[BACKING_DOC] as PlainState
    // Apply Zero.structural defaults for keys not already present
    const defaults = Zero.structural(schema) as Record<string, unknown>
    for (const key of Object.keys(defaults)) {
      if (!(key in doc)) {
        ;(doc as Record<string, unknown>)[key] = defaults[key]
      }
    }
    return createPlainSubstrate(doc, timestampVersionStrategy)
  },

  create(schema: SchemaNode): Substrate<TimestampVersion> {
    return this.upgrade(this.createReplica(), schema)
  },

  fromEntirety(
    payload: SubstratePayload,
    schema: SchemaNode,
  ): Substrate<TimestampVersion> {
    return buildPlainSubstrateFromEntirety(
      payload,
      schema,
      timestampVersionStrategy,
    )
  },

  parseVersion(serialized: string): TimestampVersion {
    return TimestampVersion.parse(serialized)
  },
}
