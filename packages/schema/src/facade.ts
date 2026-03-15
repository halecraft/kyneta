// facade — library-level change capture, declarative application, and observation.
//
// This module provides the three legs of the change protocol:
//
// - `change(ref, fn)` → `PendingChange[]`
//   Imperative: run a mutation function inside a transaction, return
//   the captured changes without re-returning the ref.
//
// - `applyChanges(ref, ops, options?)` → `PendingChange[]`
//   Declarative: apply a list of changes via `executeBatch`, triggering
//   the full prepare pipeline (cache invalidation + store mutation +
//   notification accumulation) and flush (batched Changeset delivery).
//
// - `subscribe(ref, cb)` → `() => void`
//   Observe: subscribe to changes at a ref and all descendants.
//   Only works on composite refs (products, sequences, maps).
//   Callback receives `Changeset<TreeEvent>`.
//
// - `subscribeNode(ref, cb)` → `() => void`
//   Observe: subscribe to changes at a ref's own path only. Returns an
//   unsubscribe function. Callback receives `Changeset`.
//
// `change` and `applyChanges` discover the `WritableContext` via
// `[TRANSACT]`. `subscribe` and `subscribeNode` discover the
// changefeed via `[CHANGEFEED]`. All four functions follow the same
// pattern: symbol discovery, error guard, delegation.
//
// Naming rationale: `subscribe` is the unmarked default — the thing a
// developer reaches for first — and it does the most useful thing
// (observe all descendant changes with relative paths). `subscribeNode`
// is the explicit opt-in for node-level observation. This follows the
// MobX/Valtio pattern (deep is the default) and the principle of least
// surprise. The protocol layer uses different vocabulary:
// `Changefeed.subscribe` (node-level) and `ComposedChangefeed.subscribeTree`
// (tree-level). The facade translates between developer-facing and
// protocol-level naming.
//
// See .plans/apply-changes.md §Phase 5, .plans/subscribe-facade.md.

import type { PendingChange, WritableContext } from "./interpreters/writable.js"
import { TRANSACT, hasTransact, executeBatch } from "./interpreters/writable.js"
import type { Changeset, TreeEvent } from "./changefeed.js"
import { CHANGEFEED, hasChangefeed, hasComposedChangefeed } from "./changefeed.js"

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
// change — imperative mutation → PendingChange[]
// ---------------------------------------------------------------------------

/**
 * Run a mutation function inside a transaction and return the captured
 * changes as `PendingChange[]`.
 *
 * This is the library-level version of the example facade's `change`.
 * The difference: the example returns the doc (for chaining); this
 * returns the ops (for round-tripping with `applyChanges`).
 *
 * ```ts
 * const ops = change(doc, d => {
 *   d.title.insert(0, "Hello")
 *   d.settings.darkMode.set(true)
 * })
 * // ops is PendingChange[] — can be sent to another doc via applyChanges
 * ```
 *
 * @throws If `ref` does not have a `[TRANSACT]` symbol.
 * @throws If a transaction is already active on this context.
 */
export function change<D extends object>(
  ref: D,
  fn: (draft: D) => void,
): PendingChange[] {
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
    ctx.abort()
    throw e
  }
}

// ---------------------------------------------------------------------------
// applyChanges — declarative PendingChange[] → store + notify
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
  ops: ReadonlyArray<PendingChange>,
  options?: ApplyChangesOptions,
): ReadonlyArray<PendingChange> {
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
// subscribe — observe changes at a ref and all descendants (deep default)
// ---------------------------------------------------------------------------

/**
 * Subscribe to changes at a ref and all its descendants.
 *
 * This is the primary observation function — the thing you reach for
 * first. It observes all changes anywhere in the subtree, with each
 * `TreeEvent` carrying a relative `path` from the subscription point
 * to where the change occurred.
 *
 * Only works on composite refs (products, sequences, maps) — leaf
 * refs do not support tree-level observation. For leaf observation,
 * use `subscribeNode`.
 *
 * `subscribe` is a strict superset of `subscribeNode` — subscribers
 * also see own-path changes with `path: []`.
 *
 * ```ts
 * const unsub = subscribe(doc, (changeset) => {
 *   for (const event of changeset.changes) {
 *     console.log(event.path, event.change.type)
 *   }
 * })
 * ```
 *
 * @param ref - A composite ref with a `[CHANGEFEED]` symbol that
 *   includes `subscribeTree` (from `withChangefeed`).
 * @param callback - Called with a `Changeset<TreeEvent>` on each notification.
 * @returns An unsubscribe function.
 *
 * @throws If `ref` does not have a `[CHANGEFEED]` symbol.
 * @throws If `ref` is a leaf (use `subscribeNode` instead).
 */
export function subscribe(
  ref: unknown,
  callback: (changeset: Changeset<TreeEvent>) => void,
): () => void {
  if (!hasChangefeed(ref)) {
    throw new Error(
      "subscribe() requires a ref with [CHANGEFEED]. " +
      "Use a ref produced by interpret() with withChangefeed.",
    )
  }
  if (!hasComposedChangefeed(ref)) {
    throw new Error(
      "subscribe() requires a composite ref (product, sequence, or map). " +
      "Leaf refs only support subscribeNode(), not subscribe().",
    )
  }
  return ref[CHANGEFEED].subscribeTree(callback)
}

// ---------------------------------------------------------------------------
// subscribeNode — observe changes at a ref's own path only
// ---------------------------------------------------------------------------

/**
 * Subscribe to changes at a ref's own path only.
 *
 * For leaf refs (scalars, text, counters), fires on any mutation.
 * For composite refs (products, sequences, maps), fires only on
 * node-level changes (e.g. product `.set()`, sequence `.push()`),
 * NOT on child mutations — use `subscribe` for that.
 *
 * The callback receives a `Changeset` — the protocol's unit of
 * batch delivery. Auto-commit delivers a degenerate changeset of
 * one change; transactions and `applyChanges` deliver multi-change
 * batches with optional `origin` provenance.
 *
 * ```ts
 * const unsub = subscribeNode(doc.settings.darkMode, (changeset) => {
 *   console.log(changeset.changes, changeset.origin)
 * })
 * ```
 *
 * @param ref - Any ref with a `[CHANGEFEED]` symbol (from `withChangefeed`).
 * @param callback - Called with a `Changeset` on each notification.
 * @returns An unsubscribe function.
 *
 * @throws If `ref` does not have a `[CHANGEFEED]` symbol.
 */
export function subscribeNode(
  ref: unknown,
  callback: (changeset: Changeset) => void,
): () => void {
  if (!hasChangefeed(ref)) {
    throw new Error(
      "subscribeNode() requires a ref with [CHANGEFEED]. " +
      "Use a ref produced by interpret() with withChangefeed.",
    )
  }
  return ref[CHANGEFEED].subscribe(callback)
}