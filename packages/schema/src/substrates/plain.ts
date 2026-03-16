// plain — the degenerate substrate for plain JS object stores.
//
// The plain substrate wraps a passive `Record<string, unknown>` and
// delegates `prepare` to `applyChangeToStore`. `onFlush` is a no-op
// in Phase 0; Phase 2 fills it in with version tracking and log
// accumulation.
//
// `createPlainSubstrate(store)` returns a `SubstratePrepare` with a
// `context()` method that builds the `WritableContext` (transaction
// shell) around the substrate's prepare/onFlush.
//
// `plainContext(store)` is a shorthand for tests that just need a
// `WritableContext` without holding onto the substrate reference.
//
// Context: jj:wmyomqzw

import { type Store, applyChangeToStore } from "../store.js"
import type { Path } from "../interpret.js"
import type { ChangeBase } from "../change.js"
import type { SubstratePrepare } from "../substrate.js"
import type { WritableContext } from "../interpreters/writable.js"
import { buildWritableContext } from "../interpreters/writable.js"

// ---------------------------------------------------------------------------
// createPlainSubstrate — closure factory for plain JS object stores
// ---------------------------------------------------------------------------

/**
 * Creates a plain JS object substrate — the degenerate case where the
 * store is a passive Record<string, unknown>.
 *
 * `prepare` delegates to `applyChangeToStore`. `onFlush` is a no-op
 * (Phase 2 fills it in with version tracking and log accumulation).
 *
 * Returns a SubstratePrepare with a `context()` method that builds
 * the WritableContext (transaction shell) around the substrate's
 * prepare/onFlush.
 */
export function createPlainSubstrate(store: Store): SubstratePrepare & {
  context(): WritableContext
} {
  return {
    store,
    prepare(path: Path, change: ChangeBase): void {
      applyChangeToStore(store, path, change)
    },
    onFlush(_origin?: string): void {
      // No-op in Phase 0. Phase 2 adds version tracking here.
    },
    context() {
      return buildWritableContext(this)
    },
  }
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