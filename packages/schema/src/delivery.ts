// delivery — one sealed batch, turned into the changesets its subscribers
// receive.
//
// `planDelivery` is the functional core: it walks the batch's entries once
// and decides, per subscriber-trie node, what each channel receives.
// `deliverNotifications` is the shell: it builds the changesets and calls the
// callbacks. The writable context runs both for every batch it delivers.

import type { BatchMetadata } from "@kyneta/changefeed"
import type { ChangeBase } from "./change.js"
import type { Changeset, Op } from "./changefeed.js"
import type {
  SubscriberNode,
  SubscriberTrie,
} from "./interpreters/subscriber-trie.js"
import type { TraceEntry } from "./interpreters/writable.js"
import { RawPath } from "./path.js"
import type { BatchOptions } from "./substrate.js"
import { planSubtreeEffect, projectChange } from "./subtree-effect.js"

// ---------------------------------------------------------------------------
// Notification plan — Functional Core (pure, table-testable)
// ---------------------------------------------------------------------------

/**
 * What one sealed batch delivers, to whom, and in what order.
 *
 * Keyed by subscriber-trie node rather than by path key: a key joins segments
 * lossily, and a node is exactly one coordinate.
 *
 * The two channels group differently, and the reason is structural. A node's
 * own path is a single coordinate, so its own-path changes come from one
 * place. A node's *subtree* spans many paths, so a deep subscriber's changeset
 * gathers ops from all of them — which is exactly the merge this type exists
 * to express.
 */
export interface DeliveryPlan {
  /**
   * Own-path channel: node → the changes to that coordinate, in dispatch
   * order: changes made at it, and changes made above it projected onto it.
   * Insertion order is first-touch order, which is the order these callbacks
   * fire in.
   */
  readonly ownPath: ReadonlyMap<SubscriberNode, readonly ChangeBase[]>
  /**
   * Deep channel: node → every op in that node's subtree, already rebased to
   * its relative path, and the projections of ops above it at its relative
   * root, in dispatch order. Each path is the op's frozen one, rebased, so
   * it says where the op wrote when it was made.
   */
  readonly deep: ReadonlyMap<SubscriberNode, readonly Op[]>
  /** Deep subscriber nodes, deepest-first — the order those callbacks fire in. */
  readonly deepOrder: readonly SubscriberNode[]
}

/**
 * Plan one batch's delivery: walk the ops once and answer both channels.
 *
 * A change at P concerns the coordinates whose read it changes: P's
 * ancestors, P itself, and whatever below P it rewrote
 * (`planSubtreeEffect`). So each op is walked up the trie through P's
 * ancestor chain, where deep subscribers receive it rebased to their relative
 * path, and down through the rewritten scope, where every subscriber receives
 * `projectChange(change, relative)`, the change as seen from where it sits.
 * A write gives new objects in σ to the same scope, P, its ancestors and what
 * it rewrote, and to nothing else, so a subscriber hears a batch exactly when
 * its read gets a new identity in it.
 *
 * The single pass is not just an optimisation. The deep channel needs ops in
 * *dispatch* order, and any grouping step destroys that: if an ancestor write
 * lands between two writes to the same descendant, grouping by path floats the
 * ancestor past both of them, and replaying the result reaches a different
 * state than the writes produced.
 *
 * Each entry carries two paths. The walk follows `at`, the live path, because
 * subscribers are keyed by segment identity, and a list item's identity is
 * its address. What a subscriber receives is `op.path`, the path frozen when
 * the op was made, rebased by slicing at the subscriber's depth; the two
 * paths have the same length.
 *
 * @param pending - The sealed batch's entries, in dispatch order.
 * @param trie - The context's subscribers; only read.
 */
export function planDelivery(
  pending: readonly TraceEntry[],
  trie: SubscriberTrie,
): DeliveryPlan {
  const ownPath = new Map<SubscriberNode, ChangeBase[]>()
  const deep = new Map<SubscriberNode, Op[]>()
  // Depth per deep node, recorded on first sight for the ordering sort below.
  const depths = new Map<SubscriberNode, number>()

  const toOwn = (node: SubscriberNode, change: ChangeBase): void => {
    if (!node.own?.size) return
    const at = ownPath.get(node)
    if (at) at.push(change)
    else ownPath.set(node, [change])
  }
  const toDeep = (node: SubscriberNode, op: Op, depth: number): void => {
    if (!node.deep?.size) return
    const at = deep.get(node)
    if (at) at.push(op)
    else {
      deep.set(node, [op])
      depths.set(node, depth)
    }
  }

  for (const { op, at } of pending) {
    const { path, change } = op
    // Up: the ancestor chain, as far as the trie has it. `chain[i]` is the
    // node for the first `i` segments; the chain is built from segment
    // identities, never by cutting a key string, so it cannot invent a level.
    const chain = trie.chain(at)
    const target = chain.length === at.length + 1 ? chain.at(-1) : undefined
    if (target) toOwn(target, change)
    for (let i = chain.length - 1; i >= 0; i--) {
      const node = chain[i]
      // Rebase only where someone is listening. At `i === path.length` the
      // relative path is empty: the own-path case seen from the deep channel.
      if (node?.deep?.size) toDeep(node, { path: path.slice(i), change }, i)
    }

    // Down: the part of the tree the change rewrote.
    if (target === undefined) continue
    for (const [node, relative] of trie.scope(
      target,
      planSubtreeEffect(change),
    )) {
      const projected = projectChange(change, relative)
      toOwn(node, projected)
      toDeep(
        node,
        { path: RawPath.empty, change: projected },
        path.length + relative.length,
      )
    }
  }

  // Deepest-first. `sort` is stable, so nodes at equal depth keep first-touch
  // order.
  const deepOrder = [...deep.keys()].sort(
    (a, b) => (depths.get(b) ?? 0) - (depths.get(a) ?? 0),
  )

  return { ownPath, deep, deepOrder }
}

/**
 * The metadata a sealed batch puts on each `Changeset`. `replay` is true iff
 * no writer on this peer made the ops: false for an authored batch and for a
 * native local write the bridge announces, true for what a merge, reset or
 * tick brought in. Only an authored batch can be `aborted`. `source` comes
 * from an authored batch, or from a local announcement of a write a local
 * caller asked the substrate to make natively (a Loro undo).
 */
export function changesetMetadata(options: BatchOptions): BatchMetadata {
  switch (options.ingress) {
    case "author":
      return {
        origin: options.origin,
        replay: false,
        aborted: options.aborted,
        source: options.source,
      }
    case "announce":
      return {
        origin: options.origin,
        replay: !options.local,
        aborted: undefined,
        // A merge has no local caller, so only a local announcement carries
        // one's token.
        source: options.local ? options.source : undefined,
      }
  }
}

/**
 * Fire a plan's callbacks. Imperative Shell — all the deciding happened in
 * `planDelivery`; this only builds changesets and calls functions.
 *
 * **Ordering.** Every own-path callback fires first, in first-touch order, then
 * every deep callback, deepest-first. Planning before firing is what collapses
 * a subscriber's several changesets into one, and this ordering is the price
 * of that.
 *
 * One `Changeset` is built per node and shared by every callback registered
 * there.
 *
 * @param plan - From `planDelivery`.
 * @param options - The sealed batch's options; `changesetMetadata` turns
 *   them into the metadata every emitted `Changeset` carries.
 */
export function deliverNotifications(
  plan: DeliveryPlan,
  options: BatchOptions,
): void {
  const metadata = changesetMetadata(options)
  for (const [node, changes] of plan.ownPath) {
    if (!node.own?.size) continue
    const changeset: Changeset<ChangeBase> = { changes, ...metadata }
    // Snapshot before calling. A callback is free to unsubscribe — itself or
    // anyone else — and a `Set` being iterated live would then skip a
    // subscriber it had not reached yet, or visit one added mid-delivery.
    for (const callback of [...node.own]) callback(changeset)
  }

  for (const node of plan.deepOrder) {
    const changes = plan.deep.get(node)
    if (!node.deep?.size || !changes) continue
    const changeset: Changeset<Op> = { changes, ...metadata }
    // Snapshot for the same reason as the own-path loop above.
    for (const callback of [...node.deep]) callback(changeset)
  }
}

// ---------------------------------------------------------------------------
// Shape-grammar helpers — pure transforms over Changeset shape
// ---------------------------------------------------------------------------

/**
 * Lift a `Changeset<C>` to `Changeset<Op<C>>` by wrapping each change
 * with a constant path.
 *
 * Used where a leaf-shaped (own-path) changeset has to be delivered on the
 * deep channel: the populated feed's `subscribeDescendants`.
 *
 * Pure, table-testable. Exported for tests; not re-exported from index.
 */
export function liftToOps<C extends ChangeBase>(
  changeset: Changeset<C>,
  path: RawPath,
): Changeset<Op<C>> {
  return {
    changes: changeset.changes.map(change => ({ path, change })),
    origin: changeset.origin,
    replay: changeset.replay,
    aborted: changeset.aborted,
    source: changeset.source,
  }
}
