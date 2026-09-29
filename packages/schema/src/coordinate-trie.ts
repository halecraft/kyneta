// coordinate-trie — one node per coordinate a context has navigated to.
//
// A ref is a pointer to a coordinate, and every piece of per-coordinate state
// hangs off one node here: its address and the schema it was interpreted
// with (`withAddressing`), and its memoized carrier and cached read
// (`withCaching`). A coordinate's state lives and dies with its node, so no
// layer has to keep a parallel table in step with another.
//
// Children are keyed by segment identity (`Segment.identity`), so the trie
// enumerates a subtree exactly: a key that joins segments with a separator
// can be split wrongly, a trie cannot.
//
// Every lookup descends from the root, matching each segment's address by
// identity, and nothing outside the trie holds a node. So a node that has
// been unlinked is unreachable: a stale path finds nothing rather than a
// stale address, carrier or read.

import {
  type Address,
  AddressedPath,
  entryAddress,
  fieldAddress,
  indexAddress,
  type Path,
  resolveToAddressed,
  setDead,
} from "./path.js"
import type { Schema as SchemaNode } from "./schema.js"
import type { SubtreeEffect } from "./subtree-effect.js"

/**
 * `path` as a path into the context's trie.
 *
 * Every path an addressing stack derives is addressed. The exception is the
 * path of `interpret`'s entry call (the root, or a caller's raw path), which
 * is computed before the addressing layer's first case installs the addressed
 * root, and arrives raw; it is resolved against that root here.
 */
export function coordinatePath(ctx: object, path: Path): AddressedPath {
  if (path instanceof AddressedPath) return path
  const root = (ctx as { readonly rootPath?: Path }).rootPath
  if (root instanceof AddressedPath) return resolveToAddressed(path, root.trie)
  throw new Error(
    `A path in an addressing stack is not addressed: "${path.format()}". ` +
      "Compose withAddressing beneath this layer.",
  )
}

/** A list's live item addresses by current index, for `.at(i)`. */
export interface SequenceAddressTable {
  readonly byIndex: Map<number, Address>
}

/** The per-coordinate slots, each owned by one layer. */
export interface CoordinateNode {
  // withAddressing
  /** The coordinate's address. Absent only at the root. */
  readonly address?: Address
  /** The schema the interpreter saw here, a sum's own schema at a sum. Kept
   *  current by the fates walk (`planAddressFates`). */
  schema?: SchemaNode
  /** At a list: its live item addresses by index. */
  sequenceTable?: SequenceAddressTable
  // withCaching
  /** The memoized carrier for a list item, map entry or tree node. */
  ref?: unknown
  /** The cached frozen read. */
  read?: object
}

class TrieNode implements CoordinateNode {
  schema?: SchemaNode
  sequenceTable?: SequenceAddressTable
  ref?: unknown
  read?: object
  readonly children = new Map<string, TrieNode>()

  constructor(readonly address?: Address) {}
}

/** One coordinate below a path, with the path that names it. */
export type RegisteredNode = readonly [
  path: AddressedPath,
  node: CoordinateNode,
]

/**
 * The coordinates of one context. Created by `withAddressing`, reached
 * through the context's root path (`AddressedPath.trie`).
 */
export class CoordinateTrie {
  private readonly rootNode = new TrieNode()

  /** The empty path into this trie. */
  readonly root: AddressedPath = new AddressedPath([], this)

  /** The node at `path`, or `undefined` if any coordinate on the way is
   *  not in the trie. */
  node(path: Path): CoordinateNode | undefined {
    return this.find(path)
  }

  /** The nodes from the root down to `path`, inclusive, as far as they are
   *  in the trie. */
  *ancestors(path: Path): Iterable<CoordinateNode> {
    let node: TrieNode | undefined = this.rootNode
    yield node
    for (const segment of path.segments) {
      node = childMatching(node, segment)
      if (node === undefined) return
      yield node
    }
  }

  /** The nodes strictly below `path`, parents before children. */
  below(path: AddressedPath): RegisteredNode[] {
    const start = this.find(path)
    if (start === undefined) return []
    const out: [AddressedPath, CoordinateNode][] = []
    collect(start, path, out)
    return out
  }

  /**
   * The nodes a change with `effect` at `path` may have rewritten, parents
   * before children: everything below `path` for `"all"`, each named child
   * and everything below it for `{ keys }`, nothing for `"none"`.
   */
  within(path: AddressedPath, effect: SubtreeEffect): RegisteredNode[] {
    if (effect === "none") return []
    if (effect === "all") return this.below(path)
    const start = this.find(path)
    if (start === undefined) return []
    const out: [AddressedPath, CoordinateNode][] = []
    for (const key of effect.keys) {
      const child = start.children.get(key)
      if (child?.address === undefined) continue
      const childPath = path.child(child.address)
      out.push([childPath, child])
      collect(child, childPath, out)
    }
    return out
  }

  /**
   * Unlink `path` and everything below it, first marking every address in
   * the subtree dead. Once unlinked a node cannot be reached to be told, and
   * a held ref inside it must still report `deleted`.
   */
  drop(path: Path): void {
    if (path.length === 0) throw new Error("The trie's root cannot be dropped.")
    const parent = this.find(path.slice(0, -1))
    const segment = path.segments[path.length - 1]
    if (parent === undefined || segment === undefined) return
    const node = childMatching(parent, segment)
    if (node === undefined) return
    killSubtree(node)
    parent.children.delete(segment.identity)
    const table = parent.sequenceTable
    if (table !== undefined && node.address?.kind === "index") {
      if (table.byIndex.get(node.address.index) === node.address) {
        table.byIndex.delete(node.address.index)
      }
    }
  }

  /** Unlink every list item below `path`'s list, marking each dead. */
  clearSequence(path: AddressedPath): void {
    const node = this.find(path)
    if (node?.sequenceTable === undefined) return
    for (const address of [...node.sequenceTable.byIndex.values()]) {
      this.drop(path.child(address))
    }
    node.sequenceTable = undefined
  }

  // -------------------------------------------------------------------------
  // Addresses: the only way a node comes into being
  // -------------------------------------------------------------------------

  /** The address of declared field `key` below `parent`. */
  fieldAddress(parent: Path, key: string): Address {
    return this.childAddress(parent, key, "field", dead =>
      fieldAddress(key, dead),
    )
  }

  /** The address of runtime key `key` (map entry, set member, tree node id)
   *  below `parent`. */
  entryAddress(parent: Path, key: string): Address {
    return this.childAddress(parent, key, "entry", dead =>
      entryAddress(key, dead),
    )
  }

  /** The address of the item at `index` in the list at `parent`. */
  itemAddress(parent: Path, index: number): Address {
    const node = this.find(parent)
    // A path whose coordinate has left the trie names nothing: its children
    // are as dead as it is, and must not bring a node back.
    if (node === undefined) return indexAddress(index, true)
    node.sequenceTable ??= { byIndex: new Map() }
    const existing = node.sequenceTable.byIndex.get(index)
    if (existing !== undefined) return existing
    const address = indexAddress(index)
    node.sequenceTable.byIndex.set(index, address)
    node.children.set(address.identity, new TrieNode(address))
    return address
  }

  private childAddress(
    parent: Path,
    key: string,
    role: "field" | "entry",
    make: (dead: boolean) => Address,
  ): Address {
    const node = this.find(parent)
    if (node === undefined) return make(true)
    const existing = node.children.get(key)
    if (existing?.address?.role === role) return existing.address
    if (existing !== undefined) {
      // The same key in the other role: the coordinate changed kind under a
      // sum, and what was there is gone.
      killSubtree(existing)
      node.children.delete(key)
    }
    const address = make(false)
    node.children.set(key, new TrieNode(address))
    return address
  }

  private find(path: Path): TrieNode | undefined {
    let node: TrieNode | undefined = this.rootNode
    for (const segment of path.segments) {
      node = childMatching(node, segment)
      if (node === undefined) return undefined
    }
    return node
  }
}

/**
 * The child of `node` at `segment`. For an addressed segment, the child's
 * address must be that very object: a path holding an address that has since
 * been replaced names a coordinate the trie no longer has.
 */
function childMatching(
  node: TrieNode,
  segment: Path["segments"][number],
): TrieNode | undefined {
  const child = node.children.get(segment.identity)
  if (child === undefined) return undefined
  if ("kind" in segment && child.address !== segment) return undefined
  return child
}

function collect(
  node: TrieNode,
  at: AddressedPath,
  out: [AddressedPath, CoordinateNode][],
): void {
  for (const child of node.children.values()) {
    if (child.address === undefined) continue
    const childPath = at.child(child.address)
    out.push([childPath, child])
    collect(child, childPath, out)
  }
}

/** Mark every address in `node`'s subtree dead, parents first. */
function killSubtree(node: TrieNode): void {
  if (node.address !== undefined) setDead(node.address, true)
  node.read = undefined
  for (const child of node.children.values()) killSubtree(child)
}
