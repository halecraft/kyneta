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
  FORWARD_OPS_MARKER,
  FORWARD_OPS_SINCE,
  hasTransact,
  REMOVE,
  TRANSACT,
} from "../interpreters/writable.js"

// ---------------------------------------------------------------------------
// CommitOptions
// ---------------------------------------------------------------------------

/**
 * Extensible metadata surface for all mutation entry points
 * (`change`, `applyChanges`, and future variants).
 */
export interface CommitOptions {
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
 * Run a mutation function inside the bracket primitive and return the
 * captured forward changes as `Op[]`.
 *
 * Semantics:
 * - **Read-your-writes inside the block.** σ advances eagerly on every
 *   helper call, so subsequent reads see prior writes:
 *   `d.todos.push("a"); d.todos.push("b")` appends in order.
 * - **One Changeset per outermost block** per affected subscriber path.
 *   Multi-helper blocks collapse into one batched Changeset.
 * - **Atomic abort via inverse compensation.** If `fn` throws, every
 *   change recorded in this block is undone inside the same commit by
 *   replaying inverses LIFO. External observers see one batched native
 *   event with net-zero delta and one Changeset with `aborted: true`.
 *   The rethrow propagates after compensation.
 *
 * Implementation: thin `runWriter`/`execWriter` wrapper around
 * `ctx.runBatch`. Snapshot the writer-log marker before `fn`, run `fn`,
 * slice the new entries off the end (forward only — inverse entries
 * from absorbed inner aborts are filtered out).
 *
 * ```ts
 * const ops = change(doc, d => {
 *   d.title.insert(0, "Hello")
 *   d.settings.darkMode.set(true)
 * })
 * // ops is Op[] — can be sent to another doc via applyChanges
 * ```
 *
 * @param ref - Any ref with a `[TRANSACT]` symbol (from `withWritable`).
 * @param fn - Mutation function receiving the draft proxy.
 * @param options - Optional metadata (e.g. `{ origin: "undo" }`).
 *
 * @throws If `ref` does not have a `[TRANSACT]` symbol.
 * @throws Whatever `fn` throws (after inverse compensation completes).
 */
export function change<D extends object>(
  ref: D,
  fn: (draft: D) => void,
  options?: CommitOptions,
): Op[] {
  if (!hasTransact(ref)) {
    throw new Error(
      "change() requires a ref with [TRANSACT]. " +
        "Use a ref produced by interpret() with withWritable.",
    )
  }
  const ctx: WritableContext = (ref as any)[TRANSACT]
  const opts = options ? { origin: options.origin } : undefined
  let captured: Op[] = []
  ctx.runBatch(() => {
    const marker = ctx[FORWARD_OPS_MARKER]()
    fn(ref)
    captured = ctx[FORWARD_OPS_SINCE](marker)
  }, opts)
  return captured
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
 * Routes through `executeBatch`, which opens its own `ctx.runBatch` for
 * non-replay ops — that wrapper owns the depth-0 flush, so the whole
 * batch delivers as one Changeset per affected subscriber. The prepare
 * pipeline handles cache invalidation (via `withCaching`) and
 * notification accumulation (via `withChangefeed`) automatically.
 *
 * @param ref - Any ref with a `[TRANSACT]` symbol (from `withWritable`).
 * @param ops - The changes to apply. May be empty (no-op).
 * @param options - Optional provenance metadata.
 * @returns The same `ops` array (pass-through for chaining).
 *
 * @throws If `ref` does not have a `[TRANSACT]` symbol.
 */
export function applyChanges(
  ref: object,
  ops: ReadonlyArray<Op>,
  options?: CommitOptions,
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

  // User-facing entry: never set `replay`. Origin propagates as a label.
  executeBatch(ctx, ops, options ? { origin: options.origin } : undefined)
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
