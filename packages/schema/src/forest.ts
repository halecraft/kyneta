// forest — pure helpers for the flat ↔ recursive projection pair that
// underlies `Schema.tree`.
//
// `Schema.tree` is a forest (multiple `parent: null` roots are valid).
// User-facing API keeps the "tree" word; internal algebraic types use
// "forest" because that's what the structure actually is. The flat
// shape (`FlatTreeNode<A>`) stays in the tree cluster — it's what
// `TreeChange`, `stepTree`, and `LoroTree.toArray()` already use, and
// the design hinges on those four layers agreeing.
//
// `PlainFlatTreeNode<I>` and `Plain<TreeSchema<I>>` live in
// `plain-types.ts` to avoid an import cycle with `Plain`.

import type { FlatTreeNode } from "./interpret.js"
import type { FlatTreeNodeTopology } from "./reader.js"

/** Re-export — `FlatTreeNode<A>`'s home is `interpret.ts`. */
export type { FlatTreeNode } from "./interpret.js"

/**
 * Recursive projection of the flat-forest shape, built by `nestForest`.
 * Lives at the read layer only — `Plain<TreeSchema<I>>` and the algebra
 * arg stay flat to preserve the storage / change-vocab / shadow agreement.
 * Children are sorted by `index` within each parent group.
 */
export interface ForestNode<A> {
  readonly id: string
  readonly parent: string | null
  readonly data: A
  readonly children: readonly ForestNode<A>[]
}

/** Re-export — `FlatTreeNodeTopology`'s home is `reader.ts`. */
export type { FlatTreeNodeTopology }

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ForestValidationErrorKind =
  | "duplicate-id"
  | "missing-parent"
  | "cycle"
  | "negative-index"

export interface ForestValidationError {
  readonly kind: ForestValidationErrorKind
  readonly nodeId: string
  readonly message: string
}

/**
 * Check structural invariants on a flat forest. Empty array = valid.
 * Errors don't fail-fast — callers can surface all problems in one pass.
 */
export function validateForest<A>(
  flat: readonly FlatTreeNode<A>[],
): readonly ForestValidationError[] {
  const errors: ForestValidationError[] = []
  const byId = new Map<string, FlatTreeNode<A>>()

  // Pass 1: build id map; flag duplicates and negative indices.
  for (const node of flat) {
    if (byId.has(node.id)) {
      errors.push({
        kind: "duplicate-id",
        nodeId: node.id,
        message: `duplicate node id "${node.id}"`,
      })
    } else {
      byId.set(node.id, node)
    }
    if (node.index < 0) {
      errors.push({
        kind: "negative-index",
        nodeId: node.id,
        message: `node "${node.id}" has negative index ${node.index}`,
      })
    }
  }

  // Pass 2: check parent existence and cycles. A chain longer than
  // `flat.length + 1` must contain a cycle (pigeonhole on node ids).
  const maxDepth = flat.length + 1
  for (const node of flat) {
    if (node.parent === null) continue
    if (!byId.has(node.parent)) {
      errors.push({
        kind: "missing-parent",
        nodeId: node.id,
        message: `node "${node.id}" has parent "${node.parent}" which does not exist`,
      })
      continue
    }
    // Walk parent chain to detect cycles.
    let current: string | null = node.parent
    for (let i = 0; i < maxDepth; i++) {
      if (current === null) break
      if (current === node.id) {
        errors.push({
          kind: "cycle",
          nodeId: node.id,
          message: `node "${node.id}" is in a parent cycle`,
        })
        break
      }
      const next = byId.get(current)
      if (!next) break
      current = next.parent
    }
  }

  return errors
}

// ---------------------------------------------------------------------------
// Nest — flat -> recursive projection
// ---------------------------------------------------------------------------

/**
 * Build the recursive forest projection — two-pass O(N).
 * Sorts siblings by `index`. Orphan nodes (parent id not in the node
 * set) are skipped silently here; `validateForest` flags them separately.
 * Inverse of `flattenForest` modulo canonical (parent, index) sort.
 */
export function nestForest<A>(
  flat: readonly FlatTreeNode<A>[],
): readonly ForestNode<A>[] {
  const byId = new Map<string, FlatTreeNode<A>>()
  for (const node of flat) byId.set(node.id, node)

  // Group children by parent (null → roots).
  const childrenByParent = new Map<string | null, FlatTreeNode<A>[]>()
  for (const node of flat) {
    const parentKey =
      node.parent === null
        ? null
        : byId.has(node.parent)
          ? node.parent
          : "__orphan__"
    if (parentKey === "__orphan__") continue
    let group = childrenByParent.get(parentKey)
    if (!group) {
      group = []
      childrenByParent.set(parentKey, group)
    }
    group.push(node)
  }

  // Sort each group by index for deterministic ordering.
  for (const group of childrenByParent.values()) {
    group.sort((a, b) => a.index - b.index)
  }

  // Recursive build.
  function build(node: FlatTreeNode<A>): ForestNode<A> {
    const kids = childrenByParent.get(node.id) ?? []
    return {
      id: node.id,
      parent: node.parent,
      data: node.data,
      children: kids.map(build),
    }
  }

  const roots = childrenByParent.get(null) ?? []
  return roots.map(build)
}

// ---------------------------------------------------------------------------
// Flatten — recursive -> flat projection
// ---------------------------------------------------------------------------

/** Depth-first flatten; inverse of `nestForest`. */
export function flattenForest<A>(
  forest: readonly ForestNode<A>[],
): readonly FlatTreeNode<A>[] {
  const out: FlatTreeNode<A>[] = []
  function visit(node: ForestNode<A>, parent: string | null, index: number) {
    out.push({ id: node.id, parent, index, data: node.data })
    for (let i = 0; i < node.children.length; i++) {
      visit(node.children[i], node.id, i)
    }
  }
  for (let i = 0; i < forest.length; i++) {
    visit(forest[i], null, i)
  }
  return out
}

// ---------------------------------------------------------------------------
// Subtree enumeration
// ---------------------------------------------------------------------------

/**
 * Enumerate a node and all its descendants by id (BFS).
 *
 * Used by addressing tombstoning on subtree-delete and by
 * `WritableTreeRef.delete` to record one delete instruction per node.
 * Naming it as a named primitive keeps the pure walk separate from the
 * imperative consumers (GATHER → EXECUTE).
 */
export function subtreeIds(
  flat: readonly FlatTreeNode<unknown>[],
  rootId: string,
): readonly string[] {
  const childrenByParent = new Map<string, string[]>()
  for (const node of flat) {
    if (node.parent === null) continue
    let group = childrenByParent.get(node.parent)
    if (!group) {
      group = []
      childrenByParent.set(node.parent, group)
    }
    group.push(node.id)
  }

  const ids = new Set<string>()
  const queue: string[] = []
  // Confirm root exists before enumerating.
  if (!flat.some(n => n.id === rootId)) return []
  queue.push(rootId)
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined) break
    if (ids.has(id)) continue
    ids.add(id)
    const kids = childrenByParent.get(id) ?? []
    for (const k of kids) queue.push(k)
  }
  return Array.from(ids)
}
