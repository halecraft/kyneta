// landing — where a change landed, at the grain the document stores it.
//
// Pure. A change's path and how far below it reached (`planSubtreeEffect`)
// say where it was written in Kyneta's terms. A substrate stores some of
// that coarser: a sum or `.json()` node is one value, and a decaying
// container decays whole. Reconcile asks where a remote change landed, to
// refresh σ there (`planReconcile`), and undo asks where a local commit
// landed, for its record's footprint (`footprintOf`). Both read it here.

import type { Op } from "./changefeed.js"
import { walkPath } from "./fold-path.js"
import type { Path, RawPath } from "./path.js"
import { KIND, type Schema as SchemaNode } from "./schema.js"
import { planSubtreeEffect, type SubtreeEffect } from "./subtree-effect.js"

/** Where a change landed, and how far below it reached. */
export interface Touched {
  readonly path: RawPath
  readonly effect: SubtreeEffect
}

/** Where each op landed, and how far below it its change reached. */
export function touchedBy(ops: readonly Op[]): Touched[] {
  return ops.map(op => ({
    path: op.path,
    effect: planSubtreeEffect(op.change),
  }))
}

/** A path a change landed at, and the schema at each of its prefixes. */
export interface Landed {
  readonly path: RawPath
  /** `schemas[i]` is the schema at the path's first `i` segments. */
  readonly schemas: readonly SchemaNode[]
}

/**
 * Where `touched` landed.
 *
 * - **Expand.** `"none"` and `"all"` name the touched node. `{ keys }` names
 *   those children of a struct or a record, and the node itself on any other
 *   kind: a tree change's keys are deleted node ids, and a tree lands whole.
 * - **Lift to an opaque boundary.** A sum or `.json()` node is stored as one
 *   value, and a sum's variant is read from it.
 * - **Lift to decay.** To the outermost ancestor that declares `decayMs`: a
 *   write under an expired container makes the whole container visible
 *   again.
 *
 * A path that does not fit the schema lands at the longest prefix that does.
 */
export function landed(root: SchemaNode, touched: Touched): readonly Landed[] {
  return expand(root, touched.path, touched.effect).map(path =>
    lift(root, path),
  )
}

/**
 * The items whose keys no other item's keys are a prefix of, in their first
 * order, each set of keys once.
 */
export function uncovered<T>(
  items: readonly T[],
  keysOf: (item: T) => readonly string[],
): T[] {
  interface Node {
    readonly children: Map<string, Node>
    terminal: boolean
  }
  const trie: Node = { children: new Map(), terminal: false }
  const kept = new Set<T>()
  const byDepth = [...items].sort((a, b) => keysOf(a).length - keysOf(b).length)
  for (const item of byDepth) {
    let node = trie
    let covered = node.terminal
    for (const key of keysOf(item)) {
      if (covered) break
      let next = node.children.get(key)
      if (next === undefined) {
        next = { children: new Map(), terminal: false }
        node.children.set(key, next)
      }
      node = next
      covered = node.terminal
    }
    if (covered) continue
    node.terminal = true
    kept.add(item)
  }
  return items.filter(item => kept.has(item))
}

/** The schema at each prefix of a path, and how much of it fits. */
interface Walked {
  /** `schemas[i]` is the schema at the path's first `i` segments. */
  readonly schemas: readonly SchemaNode[]
  /** How many segments the walk got through. */
  readonly consumed: number
  readonly complete: boolean
}

function walkSchemas(root: SchemaNode, path: Path): Walked {
  const schemas: SchemaNode[] = [root]
  const walk = walkPath(undefined, root, path, (_value, schema) => {
    schemas.push(schema)
    return undefined
  })
  return {
    schemas,
    consumed: walk.consumed,
    complete: walk.stop === "complete",
  }
}

function expand(
  root: SchemaNode,
  path: RawPath,
  effect: SubtreeEffect,
): readonly RawPath[] {
  if (effect === "none" || effect === "all") return [path]
  const walked = walkSchemas(root, path)
  if (!walked.complete) return [path]
  switch (walked.schemas[walked.consumed]?.[KIND]) {
    case "product":
      return effect.keys.map(key => path.field(key))
    case "map":
      return effect.keys.map(key => path.entry(key))
    default:
      return [path]
  }
}

/** `path` lifted to its opaque boundary, then to its outermost decay. */
function lift(root: SchemaNode, path: RawPath): Landed {
  const walked = walkSchemas(root, path)
  let length = walked.consumed
  const decayAt = walked.schemas
    .slice(0, length + 1)
    .findIndex(schema => (schema as { decayMs?: number }).decayMs !== undefined)
  if (decayAt !== -1) length = decayAt
  return {
    path: path.slice(0, length),
    schemas: walked.schemas.slice(0, length + 1),
  }
}
