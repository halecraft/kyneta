// lww — LWW substrate factory wrapping PlainSubstrate with TimestampVersion.
//
// The LWW (last-writer-wins) substrate delegates all state management to
// a PlainSubstrate but replaces version tracking with wall-clock timestamps.
// This enables cross-peer stale rejection in the synchronizer: incoming
// offers with older timestamps are discarded.
//
// The factory is consumed by `bindEphemeral()` in `bind.ts`.
//
// Architecture: decorator pattern — `wrapWithTimestamp` takes any
// `Substrate<PlainVersion>` and returns a `Substrate<TimestampVersion>`
// that delegates all operations to the inner substrate while maintaining
// its own timestamp-based version.

import type { ChangeBase } from "../change.js"
import type { Path } from "../interpret.js"
import type { WritableContext } from "../interpreters/writable.js"
import { buildWritableContext } from "../interpreters/writable.js"
import type { Schema as SchemaNode } from "../schema.js"
import type { PlainState } from "../reader.js"
import type {
  Replica,
  ReplicaFactory,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
} from "../substrate.js"
import type { PlainVersion } from "./plain.js"
import {
  createPlainReplica,
  plainReplicaFactory,
  plainSubstrateFactory,
} from "./plain.js"
import { TimestampVersion } from "./timestamp-version.js"

// ---------------------------------------------------------------------------
// wrapWithTimestamp — decorator: PlainSubstrate → LWW Substrate
// ---------------------------------------------------------------------------

/**
 * Wrap a plain substrate with timestamp-based versioning for LWW semantics.
 *
 * The wrapper delegates all state operations (store, prepare, export, import)
 * to the inner plain substrate. It overrides version tracking to use
 * `TimestampVersion` (wall clock) instead of `PlainVersion` (monotonic counter).
 *
 * **Critical: `context()` gotcha.** The wrapper builds its `WritableContext`
 * from the *wrapper* substrate object, not the inner one. This ensures
 * `onFlush()` on the wrapper (which bumps the timestamp) is called during
 * `change()`. If `context()` delegated to `inner.context()`, only the
 * inner plain substrate's `onFlush` would run and the timestamp would
 * never advance. See exchange TECHNICAL.md §8 for details.
 */
function wrapWithTimestamp(
  inner: Substrate<PlainVersion>,
  initialVersion: TimestampVersion,
): Substrate<TimestampVersion> {
  let currentVersion = initialVersion
  let cachedCtx: WritableContext | undefined

  const substrate: Substrate<TimestampVersion> = {
    reader: inner.reader,

    prepare(path: Path, change: ChangeBase): void {
      inner.prepare(path, change)
    },

    onFlush(origin?: string): void {
      inner.onFlush(origin)
      currentVersion = TimestampVersion.now()
    },

    // CRITICAL: build from `substrate` (the wrapper), not `inner`.
    // See docstring above for why this matters.
    context(): WritableContext {
      if (!cachedCtx) {
        cachedCtx = buildWritableContext(substrate)
      }
      return cachedCtx
    },

    version(): TimestampVersion {
      return currentVersion
    },

    exportEntirety(): SubstratePayload {
      return inner.exportEntirety()
    },

    // LWW never uses deltas — the synchronizer never provides
    // `sinceVersion` for LWW docs, so `exportSince` is never called
    // in practice. Delegate to exportEntirety for defensive correctness
    // rather than returning null.
    exportSince(_since: TimestampVersion): SubstratePayload | null {
      return inner.exportEntirety()
    },

    merge(payload: SubstratePayload, origin?: string): void {
      inner.merge(payload, origin)
      currentVersion = TimestampVersion.now()
    },
  }

  return substrate
}

// ---------------------------------------------------------------------------
// wrapReplicaWithTimestamp — decorator: PlainReplica → LWW Replica
// ---------------------------------------------------------------------------

/**
 * Wrap a plain replica with timestamp-based versioning for LWW semantics.
 *
 * The headless counterpart of `wrapWithTimestamp` — wraps a
 * `Replica<PlainVersion>` as `Replica<TimestampVersion>` without
 * requiring schema interpretation, changefeed, or WritableContext.
 */
function wrapReplicaWithTimestamp(
  inner: Replica<PlainVersion>,
  initialVersion: TimestampVersion,
): Replica<TimestampVersion> {
  let currentVersion = initialVersion

  return {
    version(): TimestampVersion {
      return currentVersion
    },

    exportEntirety(): SubstratePayload {
      return inner.exportEntirety()
    },

    exportSince(_since: TimestampVersion): SubstratePayload | null {
      return inner.exportEntirety()
    },

    merge(payload: SubstratePayload, origin?: string): void {
      inner.merge(payload, origin)
      currentVersion = TimestampVersion.now()
    },
  }
}

// ---------------------------------------------------------------------------
// lwwReplicaFactory — ReplicaFactory<TimestampVersion>
// ---------------------------------------------------------------------------

/**
 * Schema-free replica factory for LWW substrates.
 *
 * Wraps `plainReplicaFactory` with `TimestampVersion` for cross-peer
 * stale rejection. Constructs headless `Replica<TimestampVersion>`
 * instances without requiring a schema.
 */
export const lwwReplicaFactory: ReplicaFactory<TimestampVersion> = {
  replicaType: ["plain", 1, 0] as const,

  createEmpty(): Replica<TimestampVersion> {
    const inner = plainReplicaFactory.createEmpty()
    return wrapReplicaWithTimestamp(inner, new TimestampVersion(0))
  },

  fromEntirety(payload: SubstratePayload): Replica<TimestampVersion> {
    const inner = plainReplicaFactory.fromEntirety(payload)
    return wrapReplicaWithTimestamp(inner, TimestampVersion.now())
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
 * Wraps `plainSubstrateFactory` with `TimestampVersion` for cross-peer
 * stale rejection. Used by `bindEphemeral()`.
 *
 * - `create(schema)` — fresh substrate, initial version timestamp 0
 * - `fromEntirety(payload, schema)` — reconstructed from entirety,
 *   initial version `TimestampVersion.now()`
 * - `parseVersion(serialized)` — deserialize a `TimestampVersion`
 */
export const lwwSubstrateFactory: SubstrateFactory<TimestampVersion> = {
  replica: lwwReplicaFactory,

  create(schema: SchemaNode): Substrate<TimestampVersion> {
    const inner = plainSubstrateFactory.create(schema)
    return wrapWithTimestamp(inner, new TimestampVersion(0))
  },

  fromEntirety(
    payload: SubstratePayload,
    schema: SchemaNode,
  ): Substrate<TimestampVersion> {
    const inner = plainSubstrateFactory.fromEntirety(payload, schema)
    return wrapWithTimestamp(inner, TimestampVersion.now())
  },

  parseVersion(serialized: string): TimestampVersion {
    return TimestampVersion.parse(serialized)
  },
}
