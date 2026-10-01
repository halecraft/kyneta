// tree-helpers — `Schema.tree` ref installers.
//
// Tree node ids share the runtime-entry functorial role with map/set
// keys, so much of the read-layer plumbing could in principle reuse
// `keyed-helpers.ts`. In practice the layers diverge enough — topology
// must come from `Reader.forestTopology` (not `hasKey` / `keys`, which
// can't index by id over the flat shadow) — that tree-helpers is its own
// surface. What's genuinely shared with
// keyed-helpers is the install-pattern; the contents are tree-shaped.

import type { TreeInstruction } from "../change.js"
import { mapChange, own, treeChange, trustAsOwned } from "../change.js"
import { completeValue } from "../complete.js"
import { coordinatePath } from "../coordinate-trie.js"
import type { ForestNode } from "../forest.js"
import { nestForest, subtreeIds } from "../forest.js"
import { isPlainObject } from "../guards.js"
import type { FlatTreeNode, Path } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import type { Schema as SchemaNode } from "../schema.js"
import { hasTreeNodeAllocation, TREE_NODE_ALLOCATE } from "../substrate.js"
import type { WritableContext } from "./writable.js"

// ---------------------------------------------------------------------------
// installTreeNavigation — topology-aware analog of installKeyedNavigation
// ---------------------------------------------------------------------------

/**
 * Install `.node(id)`, `.has(id)`, `.ids()`, `.size`. Topology comes
 * from `ctx.reader.forestTopology(path)` — `plainReader.hasKey` over the
 * flat shadow returns numeric indices, not node ids, so trees need this
 * topology-aware path instead of `installKeyedNavigation`.
 */
export interface TreeNavigation {
  readonly node: (id: string) => unknown
  readonly has: (id: string) => boolean
  readonly ids: () => string[]
  readonly size: number
}

export function installTreeNavigation<T extends object>(
  result: T,
  ctx: RefContext,
  path: Path,
  node: (id: string) => unknown,
): asserts result is T & TreeNavigation {
  Object.defineProperty(result, "node", {
    value: (id: string): unknown => {
      const topology = ctx.reader.forestTopology(path)
      if (!topology.some(n => n.id === id)) return undefined
      return node(id)
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "has", {
    value: (id: string): boolean => {
      const topology = ctx.reader.forestTopology(path)
      return topology.some(n => n.id === id)
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "ids", {
    value: (): string[] => {
      const topology = ctx.reader.forestTopology(path)
      return topology.map(n => n.id)
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "size", {
    get(): number {
      return ctx.reader.forestTopology(path).length
    },
    enumerable: false,
    configurable: true,
  })
}

// ---------------------------------------------------------------------------
// installTreeReadable — `.roots` recursive projection, depth-first iteration
// ---------------------------------------------------------------------------

/**
 * Install `.roots` and depth-first iteration. Both nest the topology, with
 * each node's `data` its ref, and build a fresh projection on every read.
 * The tree's value, `()`, is the flat forest σ holds (`withReadable`).
 */
export interface TreeReadable {
  readonly roots: readonly ForestNode<unknown>[]
  readonly [Symbol.iterator]: () => IterableIterator<ForestNode<unknown>>
}

export function installTreeReadable<T extends object>(
  result: T,
  ctx: RefContext,
  path: Path,
  node: (id: string) => unknown,
): asserts result is T & TreeReadable {
  // Each ForestNode's `data` is the per-node ref (from the `node` closure),
  // not the per-node plain value — `.roots[i].data.label()` keeps working
  // because `data` is a live ref carrying its own [CALL] surface.
  function buildRoots(): readonly ForestNode<unknown>[] {
    const topology = ctx.reader.forestTopology(path)
    const flat: FlatTreeNode<unknown>[] = topology.map(t => ({
      id: t.id,
      parent: t.parent,
      index: t.index,
      data: node(t.id),
    }))
    return nestForest(flat)
  }

  Object.defineProperty(result, "roots", {
    get(): readonly ForestNode<unknown>[] {
      return buildRoots()
    },
    enumerable: false,
    configurable: true,
  })

  // Depth-first parent-then-children iteration over the projection.
  Object.defineProperty(result, Symbol.iterator, {
    value: function* (): IterableIterator<ForestNode<unknown>> {
      function* walk(
        nodes: readonly ForestNode<unknown>[],
      ): IterableIterator<ForestNode<unknown>> {
        for (const n of nodes) {
          yield n
          yield* walk(n.children)
        }
      }
      yield* walk(buildRoots())
    },
    enumerable: false,
    configurable: true,
  })
}

// ---------------------------------------------------------------------------
// installTreeWriteOps — `.create / .delete / .move` on a writable tree ref
// ---------------------------------------------------------------------------

/**
 * Install `.create`, `.delete`, `.move`. `.create` is the only one that
 * needs a substrate effect — id allocation, via the `[TREE_NODE_ALLOCATE]`
 * capability — because peers need a globally-agreed id from the start
 * (Loro derives it from peer-id + Lamport; the plain substrate counts).
 * `.delete` and `.move` are pure recording into the dispatch queue;
 * concurrent-move correctness is the substrate's responsibility.
 *
 * Caveat: dispatch buffers ops within a `batch()` transaction, so a
 * `.delete(id)` for an id created earlier in the same transaction sees
 * the pre-transaction topology and produces an empty instruction list.
 * Split such cases across separate transactions.
 */
export interface TreeWriteOps {
  /**
   * Create a node and write its data: `opts.data` completed by the tree's
   * item schema, so a field it omits, or every field when it is absent, is
   * written as its zero.
   */
  readonly create: (opts?: {
    parent?: string | null
    index?: number
    data?: Record<string, unknown>
  }) => string
  readonly delete: (id: string) => void
  readonly move: (
    id: string,
    opts: { parent: string | null; index: number },
  ) => void
}

export function installTreeWriteOps<T extends object>(
  result: T,
  ctx: WritableContext,
  path: Path,
  item: SchemaNode,
): asserts result is T & TreeWriteOps {
  function readTopology() {
    return ctx.reader.forestTopology(path)
  }

  Object.defineProperty(result, "create", {
    value: (opts?: {
      parent?: string | null
      index?: number
      data?: Record<string, unknown>
    }): string => {
      if (!hasTreeNodeAllocation(ctx)) {
        throw new Error(
          "WritableTreeRef.create: substrate does not implement TREE_NODE_ALLOCATE",
        )
      }
      const parent = opts?.parent ?? null
      // Default index = append under the parent. Compute siblings BEFORE
      // allocation so the substrate (e.g. Loro) can position the new
      // node at the right index in a single native call instead of
      // create-then-move.
      const siblings = readTopology().filter(n => n.parent === parent)
      const index = opts?.index ?? siblings.length
      const id = ctx[TREE_NODE_ALLOCATE](path, parent, index)
      const instructions: TreeInstruction[] = [
        { action: "create", target: id, parent, index },
      ]
      ctx.dispatch(path, treeChange(instructions))
      // The data lands as a map change at the new node's data path, separate
      // from the create instruction. A map change on a struct writes only the
      // fields it names, so the data is completed here rather than by the
      // context: every field is named.
      const data = completeValue(item, own(opts?.data ?? {}))
      if (isPlainObject(data)) {
        // `own` copied the caller's data, and completion adds only zeros
        // built for this call.
        ctx.dispatch(path.node(id), mapChange(trustAsOwned(data)))
      }
      return id
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "delete", {
    value: (id: string): void => {
      const topology = readTopology()
      const flat = topology.map(n => ({
        id: n.id,
        parent: n.parent,
        index: n.index,
        data: undefined,
      })) as readonly FlatTreeNode<unknown>[]
      const ids = subtreeIds(flat, id)
      if (ids.length === 0) return
      // Post-order: descendants before the target so an incrementally-
      // applying peer never observes a node pointing at a not-yet-deleted
      // child.
      const ordered = [...ids].reverse()
      const instructions: TreeInstruction[] = ordered.map(target => ({
        action: "delete",
        target,
      }))
      ctx.dispatch(path, treeChange(instructions))
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "move", {
    value: (
      id: string,
      opts: { parent: string | null; index: number },
    ): void => {
      const instructions: TreeInstruction[] = [
        {
          action: "move",
          target: id,
          parent: opts.parent,
          index: opts.index,
        },
      ]
      ctx.dispatch(path, treeChange(instructions))
    },
    enumerable: false,
    configurable: true,
  })
}

// ---------------------------------------------------------------------------
// cachedTreeNodes — one carrier per node, kept on its coordinate
// ---------------------------------------------------------------------------

/**
 * The per-node closures a tree's layers build on, memoized: `node(id)`
 * returns the carrier kept on the node's coordinate, making it the first time,
 * and `nodes()` lists every node through it. Every surface below — `.node`,
 * `.roots`, iteration, the snapshot — then hands out one carrier per node for
 * as long as the node exists.
 */
export function cachedTreeNodes<A>(
  ctx: RefContext,
  path: Path,
  node: (id: string) => A,
): {
  readonly node: (id: string) => A
  readonly nodes: () => readonly FlatTreeNode<A>[]
} {
  const tree = coordinatePath(ctx, path)
  const cached = (id: string): A =>
    (tree.trie.node(tree.node(id))?.ref as A | undefined) ?? node(id)
  return {
    node: cached,
    nodes: () =>
      ctx.reader.forestTopology(tree).map(t => ({
        id: t.id,
        parent: t.parent,
        index: t.index,
        data: cached(t.id),
      })),
  }
}
