// facade/batch — mutation protocol: batching, change capture, and declarative application.
//
// Two functions that form a symmetric pair:
//
// - `batch(ref, fn)` → `Op[]`
//   Imperative: run a mutation function inside one atomic commit (a
//   transaction in the algebraic sense), returning the captured changes
//   without re-returning the ref.
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
 * (`batch`, `applyChanges`, and future variants).
 */
export interface CommitOptions {
  /**
   * App-level provenance label attached to the emitted `Changeset`.
   *
   * Subscribers receive this as `changeset.origin` — useful for
   * categorizing batches (`"sync"`, `"undo"`, `"migration"`, etc.).
   * The schema layer and the exchange never branch on its value.
   * For kyneta-internal echo suppression use {@link CommitOptions.source}.
   *
   * @example
   * applyChanges(doc, ops, { origin: "sync" })
   */
  origin?: string
  /**
   * Identity-typed echo-suppression token. Propagates to
   * `Changeset.source`. Compared with `===` by subscribers that issued
   * the change.
   *
   * @example
   * const mySource = Symbol("my-binding")
   * batch(ref, fn, { source: mySource })
   * cf.subscribe(cs => { if (cs.source === mySource) return; / apply / })
   */
  source?: unknown
}

// ---------------------------------------------------------------------------
// batch — imperative mutation → Op[]
// ---------------------------------------------------------------------------

/**
 * Group a sequence of mutations into one atomic commit and return the
 * captured forward changes as `Op[]`.
 *
 * This is the batching primitive: every helper call inside `fn` collapses
 * into a single commit and one `Changeset` per affected subscriber.
 * A *single* mutation needs no `batch()` — a bare helper call auto-commits.
 * Reach for `batch()` to group ≥2 writes (atomically), to capture the
 * returned `Op[]`, or to attach `origin`/`source` provenance.
 *
 * Semantics:
 * - **Read-your-writes inside the block.** σ advances eagerly on every
 *   helper call, so subsequent reads see prior writes:
 *   `d.todos.push("a"); d.todos.push("b")` appends in order.
 * - **One Changeset per outermost block, per affected subscriber.** A
 *   subscriber sees everything the block wrote inside its own subtree, in one
 *   changeset, whether that touched one path or twenty. Deeper subscribers are
 *   called before shallower ones.
 * - **Ops arrive in dispatch order.** A subscriber's `changes` are the `Op[]`
 *   this function returns, filtered to its subtree and rebased to relative
 *   paths — so relaying them onward through `applyChanges` reproduces the
 *   writes exactly.
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
 * const ops = batch(doc, d => {
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
export function batch<D extends object>(
  ref: D,
  fn: (draft: D) => void,
  options?: CommitOptions,
): Op[] {
  if (!hasTransact(ref)) {
    throw new Error(
      "batch() requires a ref with [TRANSACT]. " +
        "Use a ref produced by interpret() with withWritable.",
    )
  }
  const ctx: WritableContext = ref[TRANSACT]
  const opts = options
    ? { origin: options.origin, source: options.source }
    : undefined
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
 * This is the declarative dual of `batch`:
 *
 * ```ts
 * // Capture changes on docA
 * const ops = batch(docA, d => { d.title.insert(0, "Hi") })
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
  const ctx: WritableContext = ref[TRANSACT]

  // Empty ops → no-op. No prepare, no flush, no notification.
  if (ops.length === 0) return ops

  // User-facing entry: never set `replay`. Origin propagates as a label;
  // source propagates as an identity-typed echo token.
  executeBatch(
    ctx,
    ops,
    options ? { origin: options.origin, source: options.source } : undefined,
  )
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
