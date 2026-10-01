// coordinate-trie — one coordinate per place a context has navigated to.
//
// A ref is a pointer to a coordinate, and everything kept per coordinate
// lives on one object: its address, which is its node here (`Coordinate`).
// It holds the address's liveness and death listeners, the schema the ref
// there was made with, the canonical ref and the count of refs anchored
// there. A coordinate's state lives and dies with it, so nothing keeps a
// parallel table in step with the trie.
//
// Children are keyed by coordinate: a field's or entry's key, a list item's
// current index, so a list's children are its address table, re-keyed as
// its items move (`advance`).
//
// Every lookup descends from the root, matching each address as the very
// object found, and nothing outside the trie links coordinates. So a
// coordinate that has been unlinked is unreachable: a stale path finds
// nothing rather than a stale address or ref.

import type { Instruction } from "./change.js"
import { advanceAddresses } from "./change.js"
import {
  type Address,
  AddressedPath,
  Coordinate,
  entryAddress,
  FieldAddress,
  fieldAddress,
  type IndexAddress,
  indexAddress,
  isAddress,
  type Path,
  rawOf,
  type Segment,
  setDead,
} from "./path.js"
import type { SubtreeEffect } from "./subtree-effect.js"

/**
 * The number of coordinates whose canonical ref (a list item's, record
 * entry's or tree node's) is alive in `ctx`'s trie.
 *
 * @internal Test-only. A kept ref has no public symptom, only memory, so
 * reading the structure is the only test that can hold.
 */
export function __countKeptRefs(ctx: {
  readonly trie: CoordinateTrie
}): number {
  let count = 0
  for (const [, node] of ctx.trie.below(ctx.trie.root)) {
    if (node.ref?.deref() !== undefined) count++
  }
  return count
}

/**
 * The number of coordinates in `ctx`'s trie, the root excluded.
 *
 * @internal Test-only, for the same reason as `__countKeptRefs`: a coordinate
 * nothing needs costs only memory.
 */
export function __countTrieNodes(ctx: {
  readonly trie: CoordinateTrie
}): number {
  return ctx.trie.below(ctx.trie.root).length
}

/** What keeps a coordinate in the trie, as the shell gathers it. */
export interface CoordinateNeeds {
  /** Live refs holding the coordinate: its anchor's (`Coordinate.refs`). */
  readonly refs: number
  /** Coordinates below it in the trie. */
  readonly children: number
  /** Listeners for its death, on its address. */
  readonly listeners: number
  /** Whether a subscriber sits at or below it (`SubscriberTrie.holdsAt`). */
  readonly subscribed: boolean
}

/**
 * Whether a coordinate must stay in the trie. A subscriber holds it because
 * a subscription is keyed by the coordinate's identity, a list item's address
 * id included: pruned, a later change would resolve to a new address and miss
 * the subscription.
 */
export function coordinateNeeded(needs: CoordinateNeeds): boolean {
  return (
    needs.refs > 0 ||
    needs.children > 0 ||
    needs.listeners > 0 ||
    needs.subscribed
  )
}

/** The trie's root: the document's coordinate, which is no segment. */
class RootCoordinate extends Coordinate {
  constructor() {
    super(false)
  }
}

/** One coordinate below a path, with the path that names it. */
export type RegisteredNode = readonly [path: AddressedPath, node: Address]

/**
 * The coordinates of one context, owned by its writable context (`ctx.trie`).
 *
 * Only a ref creates a coordinate: navigation (`AddressedPath.field`,
 * `.entry`, `.item`) asks the trie for addresses, and only ref construction
 * navigates. An op's path is located (`locate`), which creates nothing. A
 * coordinate leaves when nothing needs it any more (`prune`), or when it no
 * longer exists (`drop`).
 */
export class CoordinateTrie {
  private readonly rootNode = new RootCoordinate()

  /**
   * `subscribed(at)` says whether a subscriber sits at or below a
   * coordinate (`SubscriberTrie.holdsAt`), which keeps it from pruning.
   */
  constructor(
    private readonly subscribed: (at: AddressedPath) => boolean = () => false,
  ) {}

  /** The empty path into this trie. */
  readonly root: AddressedPath = AddressedPath.empty(this)

  /** The coordinate at `path`, or `undefined` if any coordinate on the way
   *  is not in the trie. */
  node(path: AddressedPath): Coordinate | undefined {
    const { parent, last } = path
    if (parent === undefined || last === undefined) return this.rootNode
    const node = this.node(parent)
    return node === undefined ? undefined : childMatching(node, last)
  }

  /** The coordinates strictly below `path`, parents before children. */
  below(path: AddressedPath): RegisteredNode[] {
    const start = this.node(path)
    if (start === undefined) return []
    const out: [AddressedPath, Address][] = []
    collect(start, path, out)
    return out
  }

  /**
   * The coordinates a change with `effect` at `path` may have rewritten,
   * parents before children: everything below `path` for `"all"`, each named
   * child and everything below it for `{ keys }`, nothing for `"none"`.
   */
  within(path: AddressedPath, effect: SubtreeEffect): RegisteredNode[] {
    if (effect === "none") return []
    if (effect === "all") return this.below(path)
    const start = this.node(path)
    if (start === undefined) return []
    const out: [AddressedPath, Address][] = []
    for (const key of effect.keys) {
      const child = start.children.get(key)
      if (child === undefined) continue
      const childPath = path.child(child)
      out.push([childPath, child])
      collect(child, childPath, out)
    }
    return out
  }

  /**
   * `path` located in this trie: each segment the trie has, as its address
   * (a list item by its current index), and the rest as raw segments.
   * Creates nothing. A path addressed in another document's trie is located
   * by its coordinates, since its addresses say nothing about which
   * coordinates are alive here.
   */
  locate(path: Path): AddressedPath {
    if (path instanceof AddressedPath && path.trie === this) return path
    let located = this.root
    let node: Coordinate | undefined = this.rootNode
    for (const segment of path.segments) {
      const raw = rawOf(segment)
      const child: Address | undefined =
        node === undefined ? undefined : childMatching(node, raw)
      located = located.child(child ?? raw)
      node = child
    }
    return located
  }

  /**
   * Move the items of the list at `path` through a sequence change: re-key
   * those that remain by their new index, and kill those it deleted, with
   * everything below them.
   */
  advance(path: AddressedPath, instructions: readonly Instruction[]): void {
    const list = this.node(path)
    if (list === undefined || list.children.size === 0) return
    const items = [...list.children.values()] as IndexAddress[]
    const removed = new Set(advanceAddresses(items, instructions))
    list.relink(items.filter(item => !removed.has(item)))
    for (const item of removed) killSubtree(item)
  }

  /**
   * Unlink `path` and everything below it, first marking every address in
   * the subtree dead. Once unlinked a coordinate cannot be reached to be
   * told, and a held ref inside it must still report `deleted`.
   */
  drop(path: AddressedPath): void {
    const parent = path.parent
    if (parent === undefined) {
      throw new Error("The trie's root cannot be dropped.")
    }
    const node = this.node(path)
    const above = this.node(parent)
    if (!isAddress(node) || above === undefined) return
    killSubtree(node)
    above.unlink(node)
  }

  /** Kill and unlink every item of the list at `path`. */
  clearList(path: AddressedPath): void {
    const list = this.node(path)
    if (list === undefined) return
    for (const item of list.children.values()) killSubtree(item)
    list.relink([])
  }

  /**
   * Unlink what nothing needs (`coordinateNeeded`) once the anchor at `path`
   * has lost a ref: the field coordinates its refs held, children first,
   * then the anchor itself, then its parent, and so on up, so an emptied
   * branch goes. No address is marked dead: nothing holds it to be told.
   */
  prune(path: AddressedPath): void {
    const chain = this.chain(path)
    if (chain === undefined) return
    const anchor = chain[chain.length - 1]
    if (anchor === undefined || anchor.refs > 0) return
    this.pruneFields(anchor, path)
    let at = path
    for (let i = chain.length - 1; i > 0; i--) {
      const node = chain[i]
      const parent = chain[i - 1]
      if (!isAddress(node) || parent === undefined) return
      if (this.needed(node, at, heldRefs(chain, i))) return
      parent.unlink(node)
      at = at.slice(0, -1)
    }
  }

  // -------------------------------------------------------------------------
  // Addresses: the only way a coordinate comes into being
  // -------------------------------------------------------------------------

  /** The address of declared field `key` below `parent`. */
  fieldAddress(parent: AddressedPath, key: string): Address {
    return this.keyedAddress(parent, key, "field", dead =>
      fieldAddress(key, dead),
    )
  }

  /** The address of runtime key `key` (map entry, set member, tree node id)
   *  below `parent`. */
  entryAddress(parent: AddressedPath, key: string): Address {
    return this.keyedAddress(parent, key, "entry", dead =>
      entryAddress(key, dead),
    )
  }

  /** The address of the item at `index` in the list at `parent`. */
  itemAddress(parent: AddressedPath, index: number): Address {
    const node = this.node(parent)
    // A path whose coordinate has left the trie names nothing: its children
    // are as dead as it is, and must not bring a coordinate back.
    if (node === undefined) return indexAddress(index, true)
    const existing = node.children.get(index)
    if (existing !== undefined) return existing
    const address = indexAddress(index)
    node.link(address)
    return address
  }

  private keyedAddress(
    parent: AddressedPath,
    key: string,
    role: "field" | "entry",
    make: (dead: boolean) => Address,
  ): Address {
    const node = this.node(parent)
    if (node === undefined) return make(true)
    const existing = node.children.get(key)
    if (existing?.role === role) return existing
    if (existing !== undefined) {
      // The same key in the other role: the coordinate changed kind under a
      // sum, and what was there is gone.
      killSubtree(existing)
      node.unlink(existing)
    }
    const address = make(false)
    node.link(address)
    return address
  }

  /** Unlink the unneeded field coordinates below an anchor no ref holds. */
  private pruneFields(node: Coordinate, at: AddressedPath): void {
    for (const child of [...node.children.values()]) {
      if (!(child instanceof FieldAddress)) continue
      const childPath = at.child(child)
      this.pruneFields(child, childPath)
      if (!this.needed(child, childPath, 0)) node.unlink(child)
    }
  }

  private needed(node: Address, at: AddressedPath, refs: number): boolean {
    return coordinateNeeded({
      refs,
      children: node.children.size,
      listeners: node.listeners?.size ?? 0,
      subscribed: this.subscribed(at),
    })
  }

  /** The coordinates from the root to `path`, or `undefined` if one is
   *  missing. */
  private chain(path: AddressedPath): Coordinate[] | undefined {
    const { parent, last } = path
    if (parent === undefined || last === undefined) return [this.rootNode]
    const above = this.chain(parent)
    const node =
      above === undefined
        ? undefined
        : childMatching(above[above.length - 1] ?? this.rootNode, last)
    if (above === undefined || node === undefined) return undefined
    above.push(node)
    return above
  }
}

/**
 * The child of `node` at `segment`'s coordinate. An address must be that very
 * object: a path holding an address that has since been replaced names a
 * coordinate the trie no longer has. A raw segment matches by role, so a raw
 * index names the item now at that index.
 */
function childMatching(
  node: Coordinate,
  segment: Segment,
): Address | undefined {
  const child = node.children.get(segment.coord())
  if (child === undefined) return undefined
  if (isAddress(segment)) return child === segment ? child : undefined
  return child.role === segment.role ? child : undefined
}

/** The live refs holding `chain[i]`: those anchored at the nearest
 *  coordinate at or above it that is no field. */
function heldRefs(chain: readonly Coordinate[], i: number): number {
  let j = i
  while (chain[j] instanceof FieldAddress) j--
  return chain[j]?.refs ?? 0
}

function collect(
  node: Coordinate,
  at: AddressedPath,
  out: [AddressedPath, Address][],
): void {
  for (const child of node.children.values()) {
    const childPath = at.child(child)
    out.push([childPath, child])
    collect(child, childPath, out)
  }
}

/** Mark every address in `node`'s subtree dead, parents first. */
function killSubtree(node: Address): void {
  setDead(node, true)
  for (const child of node.children.values()) killSubtree(child)
}
