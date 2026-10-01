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
//   Declarative: apply a list of changes inside one `runBatch`, triggering
//   the full prepare pipeline (address fates + store mutation +
//   notification accumulation) and flush (batched Changeset delivery).
//
// Both discover the `WritableContext` via `[TRANSACT]` — symbol
// discovery, error guard, delegation.

import { mapPayload, own } from "../change.js"
import type { Op } from "../changefeed.js"
import type { HasRemove } from "../ref/address.js"
import { REMOVE } from "../ref/address.js"
import { hasTransact, TRANSACT } from "../ref/write.js"
import type { CommitOptions } from "../substrate.js"
import type { WritableContext } from "../writable-context.js"

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
 *   paths, so relaying them onward through `applyChanges` reproduces the
 *   writes exactly. When an inner `batch()` threw and this one caught it,
 *   the changeset also carries the inner writes and their compensations,
 *   which this function does not return; both replay to the same state.
 * - **Ops are values.** Each op's path is the coordinate it wrote when it
 *   was made, so a held op replays there after the document moves on.
 * - **Atomic abort via inverse compensation.** If `fn` throws, every
 *   change recorded in this block is undone inside the same commit by
 *   replaying inverses LIFO. External observers see one batched native
 *   event with net-zero delta and one Changeset with `aborted: true`.
 *   The rethrow propagates after compensation.
 *
 * Implementation: a thin wrapper around `ctx.runBatch`, which returns the
 * ops its frame recorded and that survived (`frame-stack.ts`).
 *
 * ```ts
 * const ops = batch(doc, d => {
 *   d.title.insert(0, "Hello")
 *   d.settings.darkMode.set(true)
 * })
 * // ops is Op[] — can be sent to another doc via applyChanges
 * ```
 *
 * @param ref - A document ref, or any ref below one (each carries `[TRANSACT]`).
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
      "batch() requires a document ref, or a ref below one (a ref with [TRANSACT]).",
    )
  }
  const ctx: WritableContext = ref[TRANSACT]
  const opts: CommitOptions = {
    origin: options?.origin,
    source: options?.source,
  }
  return ctx.runBatch(() => fn(ref), opts)
}

// ---------------------------------------------------------------------------
// applyChanges — declarative Op[] → store + notify
// ---------------------------------------------------------------------------

/**
 * Apply a list of changes to a ref's store, triggering the full
 * prepare pipeline (address fates → store mutation → notification
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
 * Opens one `ctx.runBatch` around the list. That wrapper owns the depth-0
 * flush, so the whole list delivers as one Changeset per affected
 * subscriber; nested inside a `batch()` block, it joins the outer one.
 *
 * The ops stay the caller's. The store freezes what it takes in place and
 * shares it, so each payload is owned on the way in (`own`): one already
 * deeply frozen, such as a payload a subscriber received, is shared, and
 * anything else is copied. The caller's objects are never frozen.
 *
 * @param ref - A document ref, or any ref below one (each carries `[TRANSACT]`).
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
      "applyChanges() requires a document ref, or a ref below one (a ref with [TRANSACT]).",
    )
  }
  const ctx: WritableContext = ref[TRANSACT]

  // Empty ops → no-op. No prepare, no flush, no notification.
  if (ops.length === 0) return ops

  // Inside the frame, `dispatch` prepares each op as an authored write; the
  // frame owns the flush, so the whole list delivers as one Changeset.
  ctx.runBatch(
    () => {
      for (const { path, change } of ops) {
        ctx.dispatch(
          path,
          mapPayload(change, value => own(value)),
        )
      }
    },
    { origin: options?.origin, source: options?.source },
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
