// plain — the plain JS object substrate.
//
// The plain substrate wraps a passive `Record<string, unknown>` and
// delegates mutations to `applyChangeToStore`. It is the degenerate
// case of the Substrate abstraction — no CRDT runtime, no native
// oplog, just a plain JS object.
//
// `createPlainSubstrate(store)` returns a full `Substrate<PlainFrontier>`
// with version tracking via a shadow buffer in `prepare`/`onFlush`,
// plus `frontier`, `exportSnapshot`, `exportSince`, `importDelta`.
// `plainContext(store)` is a shorthand that returns just the
// `WritableContext` — convenient for tests that don't need the
// substrate reference.
//
// `PlainFrontier` wraps a monotonic integer — the external version
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
import { applyChangeToStore, type Store } from "../store.js"
import type {
  Frontier,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
} from "../substrate.js"
import { Zero } from "../zero.js"

// ---------------------------------------------------------------------------
// PlainFrontier — monotonic integer version marker
// ---------------------------------------------------------------------------

/**
 * A frontier wrapping a monotonic integer.
 *
 * Plain substrates have a total order — `compare()` returns "behind",
 * "equal", or "ahead" but never "concurrent".
 */
export class PlainFrontier implements Frontier {
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

  compare(other: Frontier): "behind" | "equal" | "ahead" | "concurrent" {
    if (!(other instanceof PlainFrontier)) {
      throw new Error(
        "PlainFrontier can only be compared with another PlainFrontier",
      )
    }
    const otherValue = other.#value
    if (this.#value < otherValue) return "behind"
    if (this.#value > otherValue) return "ahead"
    return "equal"
  }
}

// ---------------------------------------------------------------------------
// createPlainSubstrate — full Substrate<PlainFrontier> from a bare store
// ---------------------------------------------------------------------------

/**
 * Creates a full `Substrate<PlainFrontier>` wrapping a plain JS object
 * store, with version tracking, export/import, and the shadow buffer
 * for op logging.
 *
 * This is the low-level entry point when you already have a store.
 * For schema-aware construction (with `Zero.structural` / `Zero.overlay`),
 * use `plainSubstrateFactory.create(schema, seed?)` instead.
 */
export function createPlainSubstrate(store: Store): Substrate<PlainFrontier> {
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

  const substrate: Substrate<PlainFrontier> = {
    store,

    prepare(path: Path, change: ChangeBase): void {
      applyChangeToStore(store, path, change)
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

    frontier(): PlainFrontier {
      return new PlainFrontier(version)
    },

    exportSnapshot(): SubstratePayload {
      return { encoding: "json", data: JSON.stringify(store) }
    },

    exportSince(since: PlainFrontier): SubstratePayload | null {
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
export function plainContext(store: Store): WritableContext {
  return createPlainSubstrate(store).context()
}

// ---------------------------------------------------------------------------
// PlainSubstrateFactory — construction from schema or snapshot
// ---------------------------------------------------------------------------

/**
 * Factory for constructing plain JS object substrates.
 *
 * - `create(schema, seed?)` — fresh substrate from a schema + optional seed.
 * - `fromSnapshot(payload, schema)` — reconstruct from a snapshot payload.
 * - `parseFrontier(serialized)` — deserialize a PlainFrontier.
 */
export const plainSubstrateFactory: SubstrateFactory<PlainFrontier> = {
  create(
    schema: SchemaNode,
    seed: Record<string, unknown> = {},
  ): Substrate<PlainFrontier> {
    const defaults = Zero.structural(schema) as Record<string, unknown>
    const initial = Zero.overlay(seed, defaults, schema) as Record<
      string,
      unknown
    >
    const store = { ...initial } as Store
    return createPlainSubstrate(store)
  },

  fromSnapshot(
    payload: SubstratePayload,
    schema: SchemaNode,
  ): Substrate<PlainFrontier> {
    if (payload.encoding !== "json" || typeof payload.data !== "string") {
      throw new Error(
        "PlainSubstrateFactory.fromSnapshot only supports JSON-encoded payloads",
      )
    }
    const snapshotState = JSON.parse(payload.data) as Record<string, unknown>
    // Use the snapshot state as the seed — Zero.overlay will fill any
    // gaps from structural defaults (forward compatibility).
    return plainSubstrateFactory.create(schema, snapshotState)
  },

  parseFrontier(serialized: string): PlainFrontier {
    if (serialized === "") {
      throw new Error(`Invalid PlainFrontier value: (empty string)`)
    }
    const n = Number(serialized)
    if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
      throw new Error(`Invalid PlainFrontier value: ${serialized}`)
    }
    return new PlainFrontier(n)
  },
}
