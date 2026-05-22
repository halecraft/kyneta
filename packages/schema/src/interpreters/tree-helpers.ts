// tree-helpers — `Schema.tree` ref installers.
//
// Tree node ids share the runtime-entry functorial role with map/set
// keys, so much of the read-layer plumbing could in principle reuse
// `keyed-helpers.ts`. In practice the layers diverge enough — topology
// must come from `Reader.forestTopology` (not `hasKey` / `keys`, which
// can't index by id over the flat shadow), and tombstoning dispatches
// on `TreeChange.instructions` (not `MapChange.set/delete`) — that
// tree-helpers is its own surface. What's genuinely shared with
// keyed-helpers is the install-pattern; the contents are tree-shaped.

import type { ChangeBase, TreeChange, TreeInstruction } from "../change.js"
import { treeChange } from "../change.js"
import type { ForestNode } from "../forest.js"
import { nestForest, subtreeIds } from "../forest.js"
import type { FlatTreeNode, Path } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import type { Address } from "../path.js"
import { hasTreeNodeAllocation, TREE_NODE_ALLOCATE } from "../substrate.js"
import { CALL } from "./bottom.js"
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
export function installTreeNavigation(
  result: any,
  ctx: RefContext,
  path: Path,
  node: (id: string) => unknown,
): void {
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
// installTreeReadable — `.roots` recursive projection, `()` snapshot,
// depth-first iteration
// ---------------------------------------------------------------------------

/**
 * Install `.roots`, callable snapshot `()`, and depth-first iteration.
 *
 * `.roots` builds a fresh recursive projection on every read; downstream
 * caching belongs in `with-caching` (the projection invalidates on any
 * tree-version bump). The snapshot matches `Plain<TreeSchema<I>>` so
 * `doc.tree()` and the wire format agree.
 */
export function installTreeReadable(
  result: any,
  ctx: RefContext,
  path: Path,
  node: (id: string) => unknown,
): void {
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

  // `()` returns the flat-forest plain shape (`Plain<TreeSchema<I>>`),
  // with each node's `data` forced to plain via its `[CALL]`. Forcing here
  // (instead of returning live refs) is what makes `ref()` a snapshot.
  result[CALL] = (): unknown => {
    const topology = ctx.reader.forestTopology(path)
    return topology.map(t => {
      const childRef = node(t.id)
      const data =
        childRef !== undefined &&
        typeof (childRef as { [CALL]?: () => unknown })[CALL] === "function"
          ? (childRef as { [CALL]: () => unknown })[CALL]()
          : childRef
      return {
        id: t.id,
        parent: t.parent,
        index: t.index,
        data,
      }
    })
  }
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
 * Caveat: dispatch buffers ops within a `change()` transaction, so a
 * `.delete(id)` for an id created earlier in the same transaction sees
 * the pre-transaction topology and produces an empty instruction list.
 * Split such cases across separate transactions.
 */
export function installTreeWriteOps(
  result: any,
  ctx: WritableContext,
  path: Path,
): void {
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
      // Initial data lands as a MapChange at the new node's data path —
      // separate dispatch keeps the create instruction shape stable.
      if (opts?.data && Object.keys(opts.data).length > 0) {
        ctx.dispatch(path.node(id), {
          type: "map",
          set: opts.data,
        } as ChangeBase)
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
// handleTreeAddressingChange — tombstone walker for TreeChange
// ---------------------------------------------------------------------------

/**
 * Mark tree-node addresses dead based on `TreeChange.instructions`.
 *
 * `delete` is the only instruction with tombstone consequences; `create`
 * has no prior refs, and `move` doesn't change identity. The flat-shadow
 * argument lets the caller (substrate-side prepare handler) pass the
 * pre-change topology — the post-change shadow no longer has the deleted
 * ids to enumerate.
 */
export function handleTreeAddressingChange(
  table: { byKey: Map<string, { address: Address; ref: unknown }> } | undefined,
  change: ChangeBase,
  flatShadow: readonly FlatTreeNode<unknown>[],
): void {
  if (!table || change.type !== "tree") return
  const treeChange = change as TreeChange
  for (const inst of treeChange.instructions) {
    if (inst.action === "delete") {
      for (const id of subtreeIds(flatShadow, inst.target)) {
        const entry = table.byKey.get(id)
        if (entry) entry.address.dead = true
      }
    }
  }
}
