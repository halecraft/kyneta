// plain — the plain JS object substrate.
//
// The plain substrate wraps a passive `Record<string, unknown>` and
// delegates mutations to `applyChangeToStore`. It is the degenerate
// case of the Substrate abstraction — no CRDT runtime, no native
// oplog, just a plain JS object.
//
// `createPlainSubstrate(store)` returns a full `Substrate<PlainVersion>`
// with version tracking via a shadow buffer in `prepare`/`onFlush`,
// plus `version`, `exportSnapshot`, `exportSince`, `importDelta`.
// `plainContext(store)` is a shorthand that returns just the
// `WritableContext` — convenient for tests that don't need the
// substrate reference.
//
// `PlainVersion` wraps a monotonic integer — the external version
// marker for plain substrates. Plain substrates have a total order
// (no concurrency), so `compare()` never returns "concurrent".
//
// `plainSubstrateFactory` is the canonical factory for constructing
// plain substrates from schemas or snapshot payloads. It delegates
// to `createPlainSubstrate` internally.
//
// Context: jj:wmyomqzw (Phase 0), jj:wqoqzzpp (Phase 2)

import type { ChangeBase } from "../change.js"
import type { Op } from "../changefeed.js"
import type { Path } from "../interpret.js"
import type { WritableContext } from "../interpreters/writable.js"
import { buildWritableContext, executeBatch } from "../interpreters/writable.js"
import type { Schema as SchemaNode } from "../schema.js"
import { applyChangeToStore, plainStoreReader, type Store } from "../store.js"
import type {
  Substrate,
  SubstrateFactory,
  SubstratePayload,
  Version,
} from "../substrate.js"
import { Zero } from "../zero.js"

// ---------------------------------------------------------------------------
// PlainVersion — monotonic integer version marker
// ---------------------------------------------------------------------------

/**
 * A version marker wrapping a monotonic integer.
 *
 * Plain substrates have a total order — `compare()` returns "behind",
 * "equal", or "ahead" but never "concurrent".
 */
export class PlainVersion implements Version {
  readonly #value: number

  constructor(value: number) {
    this.#value = value
  }

  /** The raw version integer. */
  get value(): number {
    return this.#value
  }

  serialize(): string {
    return String(this.#value)
  }

  compare(other: Version): "behind" | "equal" | "ahead" | "concurrent" {
    if (!(other instanceof PlainVersion)) {
      throw new Error(
        "PlainVersion can only be compared with another PlainVersion",
      )
    }
    const otherValue = other.#value
    if (this.#value < otherValue) return "behind"
    if (this.#value > otherValue) return "ahead"
    return "equal"
  }
}

// ---------------------------------------------------------------------------
// createPlainSubstrate — full Substrate<PlainVersion> from a bare store
// ---------------------------------------------------------------------------

/**
 * Creates a full `Substrate<PlainVersion>` wrapping a plain JS object
 * store, with version tracking, export/import, and the shadow buffer
 * for op logging.
 *
 * This is the low-level entry point when you already have a store.
 * For schema-aware construction (with `Zero.structural` / `Zero.overlay`),
 * use `plainSubstrateFactory.create(schema, seed?)` instead.
 */
export function createPlainSubstrate(storeObj: Store): Substrate<PlainVersion> {
  const reader = plainStoreReader(storeObj)

  // --- Closure-scoped state ---
  // Shadow buffer: accumulates {path, change} entries during prepare,
  // drained by onFlush into the version log. The changefeed layer
  // independently accumulates the same entries for notification
  // planning — both hold the same object references (not clones).
  const pendingOps: Op[] = []

  // Version log: log[i] = batch of Ops from version i → i+1.
  const log: Op[][] = []

  // Monotonic version counter, incremented on each flush cycle
  // that produced at least one Op.
  let version = 0

  // The WritableContext is built lazily and cached — the same context
  // is returned on every call to `context()`.
  let cachedCtx: WritableContext | undefined

  const substrate: Substrate<PlainVersion> = {
    store: reader,

    prepare(path: Path, change: ChangeBase): void {
      applyChangeToStore(storeObj, path, change)
      pendingOps.push({ path, change })
    },

    onFlush(_origin?: string): void {
      if (pendingOps.length > 0) {
        log.push([...pendingOps])
        pendingOps.length = 0
        version++
      }
    },

    context(): WritableContext {
      if (!cachedCtx) {
        cachedCtx = buildWritableContext(substrate)
      }
      return cachedCtx
    },

    version(): PlainVersion {
      return new PlainVersion(version)
    },

    exportSnapshot(): SubstratePayload {
      return { encoding: "json", data: JSON.stringify(storeObj) }
    },

    exportSince(since: PlainVersion): SubstratePayload | null {
      const sinceValue = since.value
      if (sinceValue > version) return null
      if (sinceValue === version) {
        return { encoding: "json", data: JSON.stringify([]) }
      }
      const ops = log.slice(sinceValue).flat()
      return { encoding: "json", data: JSON.stringify(ops) }
    },

    importDelta(payload: SubstratePayload, origin?: string): void {
      if (payload.encoding !== "json" || typeof payload.data !== "string") {
        throw new Error(
          "PlainSubstrate.importDelta only supports JSON-encoded payloads",
        )
      }
      const ops = JSON.parse(payload.data) as Op[]
      if (ops.length === 0) return

      // Apply through the prepare/flush pipeline so the changefeed
      // layer delivers notifications to subscribers.
      const ctx = substrate.context()
      executeBatch(ctx, ops, origin)
    },
  }

  return substrate
}

// ---------------------------------------------------------------------------
// plainContext — shorthand for tests
// ---------------------------------------------------------------------------

/**
 * Shorthand: wraps a plain store in a substrate and returns its
 * WritableContext.
 *
 * Useful in tests where you don't need the substrate reference:
 *
 * ```ts
 * const ctx = plainContext(store)
 * const doc = interpret(schema, ctx).with(readable).with(writable).done()
 * ```
 */
export function plainContext(storeObj: Store): WritableContext {
  return createPlainSubstrate(storeObj).context()
}

// ---------------------------------------------------------------------------
// PlainSubstrateFactory — construction from schema or snapshot
// ---------------------------------------------------------------------------

/**
 * Factory for constructing plain JS object substrates.
 *
 * - `create(schema)` — fresh substrate with Zero.structural defaults.
 * - `fromSnapshot(payload, schema)` — reconstruct from a snapshot payload
 *   via executeBatch (produces version > 0 with ops in the log).
 * - `parseVersion(serialized)` — deserialize a PlainVersion.
 */
export const plainSubstrateFactory: SubstrateFactory<PlainVersion> = {
  create(schema: SchemaNode): Substrate<PlainVersion> {
    const defaults = Zero.structural(schema) as Record<string, unknown>
    const storeObj = { ...defaults } as Store
    return createPlainSubstrate(storeObj)
  },

  fromSnapshot(
    payload: SubstratePayload,
    schema: SchemaNode,
  ): Substrate<PlainVersion> {
    if (payload.encoding !== "json" || typeof payload.data !== "string") {
      throw new Error(
        "PlainSubstrateFactory.fromSnapshot only supports JSON-encoded payloads",
      )
    }
    const snapshotState = JSON.parse(payload.data) as Record<string, unknown>

    // Create empty substrate, then apply snapshot state through the
    // prepare/flush pipeline. This produces version > 0 with ops in
    // the log, so version comparison works correctly for sequential sync.
    const substrate = plainSubstrateFactory.create(schema)
    const ops: Array<{
      path: Array<{ type: "key"; key: string }>
      change: { type: "replace"; value: unknown }
    }> = []
    for (const [key, value] of Object.entries(snapshotState)) {
      ops.push({
        path: [{ type: "key" as const, key }],
        change: { type: "replace" as const, value },
      })
    }
    if (ops.length > 0) {
      executeBatch(substrate.context(), ops)
    }
    return substrate
  },

  parseVersion(serialized: string): PlainVersion {
    if (serialized === "") {
      throw new Error(`Invalid PlainVersion value: (empty string)`)
    }
    const n = Number(serialized)
    if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
      throw new Error(`Invalid PlainVersion value: ${serialized}`)
    }
    return new PlainVersion(n)
  },
}
