// facade/change — mutation protocol: change capture and declarative application.
//
// Two functions that form a symmetric pair:
//
// - `change(ref, fn)` → `Op[]`
//   Imperative: run a mutation function inside a transaction, return
//   the captured changes without re-returning the ref.
//
// - `applyChanges(ref, ops, options?)` → `Op[]`
//   Declarative: apply a list of changes via `executeBatch`, triggering
//   the full prepare pipeline (cache invalidation + store mutation +
//   notification accumulation) and flush (batched Changeset delivery).
//
// Both discover the `WritableContext` via `[TRANSACT]` — symbol
// discovery, error guard, delegation.

import type { Op } from "../changefeed.js"
import type { HasRemove, WritableContext } from "../interpreters/writable.js"
import {
  executeBatch,
  hasTransact,
  REMOVE,
  TRANSACT,
} from "../interpreters/writable.js"

// ---------------------------------------------------------------------------
// ApplyChangesOptions
// ---------------------------------------------------------------------------

/**
 * Options for `applyChanges`.
 */
export interface ApplyChangesOptions {
  /**
   * Provenance tag attached to the emitted `Changeset`.
   *
   * Subscribers receive this as `changeset.origin` — useful for
   * distinguishing local vs. sync vs. undo changes.
   *
   * @example
   * applyChanges(doc, ops, { origin: "sync" })
   */
  origin?: string
}

// ---------------------------------------------------------------------------
// change — imperative mutation → Op[]
// ---------------------------------------------------------------------------

/**
 * Run a mutation function inside a transaction and return the captured
 * changes as `Op[]`.
 *
 * ```ts
 * const ops = change(doc, d => {
 *   d.title.insert(0, "Hello")
 *   d.settings.darkMode.set(true)
 * })
 * // ops is Op[] — can be sent to another doc via applyChanges
 * ```
 *
 * @throws If `ref` does not have a `[TRANSACT]` symbol.
 * @throws If a transaction is already active on this context.
 */
export function change<D extends object>(ref: D, fn: (draft: D) => void): Op[] {
  if (!hasTransact(ref)) {
    throw new Error(
      "change() requires a ref with [TRANSACT]. " +
        "Use a ref produced by interpret() with withWritable.",
    )
  }
  const ctx: WritableContext = (ref as any)[TRANSACT]
  ctx.beginTransaction()
  try {
    fn(ref)
    return ctx.commit()
  } catch (e) {
    if (ctx.inTransaction) ctx.abort()
    throw e
  }
}

// ---------------------------------------------------------------------------
// applyChanges — declarative Op[] → store + notify
// ---------------------------------------------------------------------------

/**
 * Apply a list of changes to a ref's store, triggering the full
 * prepare pipeline (cache invalidation → store mutation → notification
 * accumulation) followed by a single flush (batched Changeset delivery
 * to subscribers).
 *
 * This is the declarative dual of `change`:
 *
 * ```ts
 * // Capture changes on docA
 * const ops = change(docA, d => { d.title.insert(0, "Hi") })
 *
 * // Apply to docB (same schema, different store)
 * applyChanges(docB, ops, { origin: "sync" })
 * ```
 *
 * Uses `executeBatch` under the hood — which calls `ctx.prepare` N
 * times (one per change) then `ctx.flush` once. The prepare pipeline
 * handles cache invalidation (via `withCaching`) and notification
 * accumulation (via `withChangefeed`) automatically.
 *
 * **Invariant:** Must not be called during an active transaction on
 * the same context. `executeBatch` throws if `ctx.inTransaction` is
 * true — commit or abort the transaction first.
 *
 * @param ref - Any ref with a `[TRANSACT]` symbol (from `withWritable`).
 * @param ops - The changes to apply. May be empty (no-op).
 * @param options - Optional provenance metadata.
 * @returns The same `ops` array (pass-through for chaining).
 *
 * @throws If `ref` does not have a `[TRANSACT]` symbol.
 * @throws If called during an active transaction.
 */
export function applyChanges(
  ref: object,
  ops: ReadonlyArray<Op>,
  options?: ApplyChangesOptions,
): ReadonlyArray<Op> {
  if (!hasTransact(ref)) {
    throw new Error(
      "applyChanges() requires a ref with [TRANSACT]. " +
        "Use a ref produced by interpret() with withWritable.",
    )
  }
  const ctx: WritableContext = (ref as any)[TRANSACT]

  // Empty ops → no-op. No prepare, no flush, no notification.
  if (ops.length === 0) return ops

  executeBatch(ctx, ops, options?.origin)
  return ops
}

// ---------------------------------------------------------------------------
// remove — structural self-removal from parent container
// ---------------------------------------------------------------------------

/**
 * Remove a ref from its parent container.
 *
 * The ref must be a child of a sequence, map, or set — i.e. obtained
 * via `.at()` on a container ref. Dispatches the appropriate change
 * (sequence delete or map key delete) at the parent path.
 *
 * This is the facade for `ref[REMOVE]()`. Equivalent to calling
 * `ref[REMOVE]()` directly, but reads more naturally in application code.
 *
 * ```ts
 * function TaskCard({ task }: { task: Ref<TaskSchema> }) {
 *   return <button onClick={() => remove(task)}>Remove</button>
 * }
 * ```
 *
 * @throws If `ref` does not have a `[REMOVE]` symbol (e.g. product field, top-level doc).
 */
export function remove(ref: HasRemove): void {
  ref[REMOVE]()
}
