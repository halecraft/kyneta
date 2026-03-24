// facade/observe — observation protocol.
//
// Subscribe to changes at a ref (tree-level) or at a single node
// (node-level). Both functions discover capabilities via the
// `[CHANGEFEED]` symbol on refs.
//
// `subscribe` is the unmarked default — the thing a developer reaches
// for first — and it does the most useful thing (observe all descendant
// changes with relative paths). `subscribeNode` is the explicit opt-in
// for node-level observation. This follows the MobX/Valtio pattern
// (deep is the default) and the principle of least surprise.
//
// The protocol layer uses different vocabulary:
// `Changefeed.subscribe` (node-level) and `ComposedChangefeed.subscribeTree`
// (tree-level). The facade translates between developer-facing and
// protocol-level naming.

import type { Changeset, Op } from "../changefeed.js"
import {
  CHANGEFEED,
  hasChangefeed,
  hasComposedChangefeed,
} from "../changefeed.js"

// ---------------------------------------------------------------------------
// subscribe — observe changes at a ref and all descendants (deep default)
// ---------------------------------------------------------------------------

/**
 * Subscribe to changes at a ref and all its descendants.
 *
 * This is the primary observation function — the thing you reach for
 * first. It observes all changes anywhere in the subtree, with each
 * `Op` carrying a relative `path` from the subscription point to
 * where the change occurred.
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
 * @param callback - Called with a `Changeset<Op>` on each notification.
 * @returns An unsubscribe function.
 *
 * @throws If `ref` does not have a `[CHANGEFEED]` symbol.
 * @throws If `ref` is a leaf (use `subscribeNode` instead).
 */
export function subscribe(
  ref: unknown,
  callback: (changeset: Changeset<Op>) => void,
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
