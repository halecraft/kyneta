// subscriber-trie — where a context's changefeed subscribers and population
// state live, one node per coordinate that has either.
//
// Keyed by segment identity (`Segment.identity`: a list item's id, a field's
// or entry's key), so a subscription follows a list item across inserts, two
// coordinates whose joined `path.key` strings collide are two nodes,
// and a subtree can be enumerated exactly. That enumeration is what delivery
// needs: a change reaches the subscribers on its path's ancestor chain and
// the subscribers inside the part of the tree it rewrote.
//
// It is not the `CoordinateTrie`. A subscription belongs to its subscriber,
// not to the coordinate it names: a subscriber at a list item or tree node a
// change kills must still hear that change, and the coordinate trie unlinks
// such coordinates when `prepare` settles the change, before delivery.

import type { ChangeBase } from "./change.js"
import type { Changeset, Op } from "./changefeed.js"
import type { Path, Segment } from "./path.js"
import type { SubtreeEffect } from "./subtree-effect.js"

/** An own-path subscriber: the node's own changes, without paths. */
export type OwnCallback = (changeset: Changeset<ChangeBase>) => void

/** A deep subscriber: an `Op` per change at or below it, relative to it. */
export type DeepCallback = (changeset: Changeset<Op>) => void

/** One coordinate's subscribers and population state. */
export interface SubscriberNode {
  /** The segment naming this node under its parent; absent at the root. */
  readonly segment: Segment | undefined
  readonly parent: SubscriberNode | undefined
  readonly children: Map<string | number, SubscriberNode>
  own: Set<OwnCallback> | undefined
  deep: Set<DeepCallback> | undefined
  /** One-shot callbacks waiting for this coordinate to become populated. */
  populatedListeners: Set<() => void> | undefined
  /** An op landed at or below this coordinate. */
  populated: boolean
  /** An op here rewrote everything below it. */
  rewroteAll: boolean
  /** Keys of children an op here rewrote. */
  rewroteKeys: Set<string | number> | undefined
  /** Callbacks of every kind at or below this node, so walks skip the rest. */
  watchers: number
}

function createNode(
  segment: Segment | undefined,
  parent: SubscriberNode | undefined,
): SubscriberNode {
  return {
    segment,
    parent,
    children: new Map(),
    own: undefined,
    deep: undefined,
    populatedListeners: undefined,
    populated: false,
    rewroteAll: false,
    rewroteKeys: undefined,
    watchers: 0,
  }
}

/** A node reached below a change's path, and the segments from there to it. */
export type ScopedNode = readonly [
  node: SubscriberNode,
  relative: readonly Segment[],
]

export class SubscriberTrie {
  readonly root: SubscriberNode = createNode(undefined, undefined)

  /** The node at `path`, if it exists. */
  find(path: Path): SubscriberNode | undefined {
    let node: SubscriberNode | undefined = this.root
    for (const { identity } of path.segments) {
      node = node.children.get(identity)
      if (node === undefined) return undefined
    }
    return node
  }

  /** The node at `path`, created with its ancestors if missing. */
  ensure(path: Path): SubscriberNode {
    let node = this.root
    for (const segment of path.segments) {
      let child = node.children.get(segment.identity)
      if (child === undefined) {
        child = createNode(segment, node)
        node.children.set(segment.identity, child)
      }
      node = child
    }
    return node
  }

  /**
   * The existing nodes from the root along `path`, as far as they go:
   * `chain[i]` is the node for the first `i` segments.
   */
  chain(path: Path): SubscriberNode[] {
    const out: SubscriberNode[] = [this.root]
    let node: SubscriberNode | undefined = this.root
    for (const { identity } of path.segments) {
      node = node.children.get(identity)
      if (node === undefined) break
      out.push(node)
    }
    return out
  }

  /**
   * The watched nodes strictly below `node` that a change there with
   * `effect` may have rewritten, parents before children, each with its
   * segments relative to `node`. Subtrees nobody watches are skipped.
   */
  scope(node: SubscriberNode, effect: SubtreeEffect): ScopedNode[] {
    if (effect === "none") return []
    const out: [SubscriberNode, Segment[]][] = []
    const visit = (child: SubscriberNode, relative: Segment[]): void => {
      if (child.watchers === 0 || child.segment === undefined) return
      const here = [...relative, child.segment]
      out.push([child, here])
      for (const grandchild of child.children.values()) visit(grandchild, here)
    }
    if (effect === "all") {
      for (const child of node.children.values()) visit(child, [])
    } else {
      for (const key of effect.keys) {
        const child = node.children.get(key)
        if (child !== undefined) visit(child, [])
      }
    }
    return out
  }

  /** Register an own-path subscriber at `path`; returns its teardown. */
  listenOwn(path: Path, callback: OwnCallback): () => void {
    return this.register(path, node => (node.own ??= new Set()), callback)
  }

  /** Register a deep subscriber at `path`; returns its teardown. */
  listenDeep(path: Path, callback: DeepCallback): () => void {
    return this.register(path, node => (node.deep ??= new Set()), callback)
  }

  /**
   * Add `callback` to the set `setOf` picks at `path`, and hand back the
   * teardown that removes it. The teardown is idempotent, and one left over
   * from a pruned node finds its callback gone and does nothing.
   */
  private register<C>(
    path: Path,
    setOf: (node: SubscriberNode) => Set<C>,
    callback: C,
  ): () => void {
    const node = this.ensure(path)
    const set = setOf(node)
    if (set.has(callback)) return () => {}
    set.add(callback)
    adjustWatchers(node, 1)
    return () => {
      if (!set.delete(callback)) return
      adjustWatchers(node, -1)
      prune(node)
    }
  }

  /**
   * Register a one-shot population listener at `path`. It is removed when it
   * fires; the teardown removes it before then.
   */
  listenPopulated(path: Path, callback: () => void): () => void {
    return this.register(
      path,
      node => (node.populatedListeners ??= new Set()),
      callback,
    )
  }

  /**
   * Whether a subscriber of any kind (own, deep, or one waiting for
   * population) sits at or below `path`. A populated mark alone does not
   * count: it is answered for any coordinate, held or not.
   */
  holdsAt(path: Path): boolean {
    return (this.find(path)?.watchers ?? 0) > 0
  }

  /**
   * Whether `path` is populated: an op landed at or below it, or an op at an
   * ancestor rewrote a part of the tree containing it. A list's items are
   * populated exactly when the list is: an item exists only because an
   * insert carried its value, and a list starts empty.
   */
  isPopulated(path: Path): boolean {
    let node: SubscriberNode = this.root
    for (const segment of path.segments) {
      const key = segment.identity
      if (node.rewroteAll || node.rewroteKeys?.has(key)) return true
      if (segment.role === "index" && node.populated) return true
      const child = node.children.get(key)
      if (child === undefined) return false
      node = child
    }
    return node.populated
  }

  /**
   * Mark what a change at `path` populated: `path` and its ancestors, and
   * the part below it that `effect` names. Fires the population listeners of
   * every node that became populated.
   *
   * Creates only what the mark adds. The path stops before its first list
   * index, since a list's items are populated with it, so nothing is keyed
   * by an index (a raw index names another item after an insert). And a
   * mark an ancestor's rewrite already implies, or one that adds nothing to
   * a populated node, returns before creating a node.
   */
  markPopulated(path: Path, effect: SubtreeEffect): void {
    const index = path.segments.findIndex(s => s.role === "index")
    const at = index === -1 ? path : path.slice(0, index)
    const added = index === -1 ? effect : "none"
    if (this.implied(at, added)) return
    const node = this.ensure(at)
    for (let up: SubscriberNode | undefined = node; up; up = up.parent) {
      if (up.populated) break // ancestors of a populated node are populated
      populate(up)
    }
    if (added === "all") node.rewroteAll = true
    else if (added !== "none") {
      node.rewroteKeys ??= new Set()
      for (const key of added.keys) node.rewroteKeys.add(key)
    }
    for (const [below] of this.scope(node, added)) populate(below)
  }

  /** Whether marking `path` with `effect` would change nothing. */
  private implied(path: Path, effect: SubtreeEffect): boolean {
    let node: SubscriberNode = this.root
    for (const { identity } of path.segments) {
      if (node.rewroteAll || node.rewroteKeys?.has(identity)) return true
      const child = node.children.get(identity)
      if (child === undefined) return false
      node = child
    }
    if (!node.populated) return false
    if (effect === "none" || node.rewroteAll) return true
    if (effect === "all") return false
    return effect.keys.every(key => node.rewroteKeys?.has(key) === true)
  }
}

/**
 * Mark `node` populated and fire its population listeners, and those at and
 * below its list items, which became populated with it. Those are not
 * marked: a list's populated mark answers for them (`isPopulated`).
 */
function populate(node: SubscriberNode): void {
  if (!node.populated) {
    node.populated = true
    fire(node)
  }
  for (const child of node.children.values()) {
    if (child.segment?.role === "index" && child.watchers > 0) {
      fireBelow(child)
    }
  }
}

/** Fire the population listeners at and below `node`. */
function fireBelow(node: SubscriberNode): void {
  for (const child of node.children.values()) {
    if (child.watchers > 0) fireBelow(child)
  }
  fire(node)
}

/** Fire and remove the population listeners at `node`, and unlink it if
 *  that leaves it holding nothing. */
function fire(node: SubscriberNode): void {
  const listeners = node.populatedListeners
  if (listeners === undefined) return
  node.populatedListeners = undefined
  adjustWatchers(node, -listeners.size)
  for (const callback of listeners) callback()
  prune(node)
}

function adjustWatchers(node: SubscriberNode, by: number): void {
  for (let at: SubscriberNode | undefined = node; at; at = at.parent) {
    at.watchers += by
  }
}

/** Unlink `node`, and each ancestor after it, while it holds nothing. */
function prune(node: SubscriberNode): void {
  let at: SubscriberNode | undefined = node
  while (at?.parent !== undefined && isEmpty(at) && at.segment !== undefined) {
    at.parent.children.delete(at.segment.identity)
    at = at.parent
  }
}

/** Whether `node` holds nothing: a populated mark is something, since it
 *  answers `isPopulated` below it. */
function isEmpty(node: SubscriberNode): boolean {
  return (
    node.watchers === 0 &&
    node.children.size === 0 &&
    !node.populated &&
    !node.rewroteAll &&
    node.rewroteKeys === undefined &&
    !node.own?.size &&
    !node.deep?.size
  )
}
