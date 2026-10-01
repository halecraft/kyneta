// reconcile-shadow — bring σ up to date from λ where a change touched it.
//
// Every way σ moves apart from an authored write and a plain `append` is one
// reconcile: the CRDT event bridges, an ephemeral merge or tick, a plain
// adopt. Each knows where the change landed (the ops a bridge announces, the
// paths an ephemeral join moved), and `planSubtreeEffect` says how far below
// that it reached. So the reconcile re-materializes only those parts, diffs
// each against σ, and applies the difference. It costs the size of what
// changed, and every σ object outside the touched parts keeps its identity.
//
//   plan     `planReconcile`: which parts of σ to refresh. Pure.
//   gather   read each part's next value from λ, through the resolver.
//   plan     `diffOps` of each part against σ. Pure.
//   execute  apply the ops to σ.

import type { Op } from "./changefeed.js"
import { diffOps } from "./diff-ops.js"
import { walkPath } from "./fold-path.js"
import type { Interpreter } from "./interpret.js"
import { interpret } from "./interpret.js"
import {
  type MaterializeContext,
  type MaterializeResolver,
  materializeContextFromResolver,
} from "./interpreters/materialize.js"
import type { Path } from "./path.js"
import { applyChange, ownedForStore, type PlainState } from "./reader.js"
import { KIND, type Schema as SchemaNode } from "./schema.js"
import { planSubtreeEffect, type SubtreeEffect } from "./subtree-effect.js"

/** Where a change landed, and how far below it reached. */
export interface Touched {
  readonly path: Path
  readonly effect: SubtreeEffect
}

/** Where each op landed, and how far below it its change reached. */
export function touchedBy(ops: readonly Op[]): Touched[] {
  return ops.map(op => ({
    path: op.path,
    effect: planSubtreeEffect(op.change),
  }))
}

/**
 * One `diffOps` call: the node at `path`, or, with `keys`, only those
 * entries of the record at `path`.
 */
export interface ReconcileTarget {
  readonly path: Path
  readonly schema: SchemaNode
  readonly keys?: readonly string[]
}

// ---------------------------------------------------------------------------
// planReconcile — pure
// ---------------------------------------------------------------------------

/**
 * The parts of σ to refresh after the changes `touched`, as few `diffOps`
 * calls as cover them. Five steps, in order:
 *
 * 1. **Expand.** `"none"` and `"all"` name the touched node. `{ keys }` names
 *    those children of a struct or a record, and the node itself on any other
 *    kind: a tree change's keys are deleted node ids, and a tree is diffed
 *    whole.
 * 2. **Lift to an opaque boundary.** A sum or `.json()` node is stored as one
 *    value, and a sum's variant is read from it.
 * 3. **Lift to decay.** To the outermost ancestor that declares `decayMs`: a
 *    write under an expired container makes the whole container visible
 *    again.
 * 4. **Record entries become keyed parents.** A node target at an entry could
 *    express neither a key that is gone (the materializer answers zeros for
 *    it) nor one that is new (the diff would be field writes under an entry σ
 *    lacks, not a map change at the record). This runs after both lifts,
 *    because a lift can land on an entry.
 * 5. **Cover and group.** A node target covers everything at or below its
 *    path, and a keyed target `{ k }` at P everything at or below `P.k`.
 *    Keyed targets at one record merge, their keys combined.
 *
 * A path that does not fit the schema is refreshed at the longest prefix
 * that does. Paths compare by `segmentKeys`, element by element.
 */
export function planReconcile(
  root: SchemaNode,
  touched: readonly Touched[],
): readonly ReconcileTarget[] {
  const candidates: Candidate[] = []
  for (const { path, effect } of touched) {
    for (const child of expand(root, path, effect)) {
      candidates.push(toCandidate(lift(root, child)))
    }
  }
  return group(cover(candidates))
}

/** A node target, or one key of a record. */
interface Candidate {
  readonly path: Path
  readonly schema: SchemaNode
  readonly key?: string
  /** `path`, or `path.entry(key)`: what this candidate covers. */
  readonly covers: readonly string[]
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
  path: Path,
  effect: SubtreeEffect,
): readonly Path[] {
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
function lift(
  root: SchemaNode,
  path: Path,
): { readonly path: Path; readonly schemas: readonly SchemaNode[] } {
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

function toCandidate(lifted: {
  readonly path: Path
  readonly schemas: readonly SchemaNode[]
}): Candidate {
  const { path, schemas } = lifted
  const length = path.length
  const schema = schemas[length] as SchemaNode
  const last = path.segments[length - 1]
  const parent = schemas[length - 1]
  if (last !== undefined && last.role === "entry" && parent?.[KIND] === "map") {
    return {
      path: path.slice(0, length - 1),
      schema: parent,
      key: String(last.coord()),
      covers: path.segmentKeys,
    }
  }
  return { path, schema, covers: path.segmentKeys }
}

/** The candidates no other candidate covers, in their first order. */
function cover(candidates: readonly Candidate[]): readonly Candidate[] {
  interface Node {
    readonly children: Map<string, Node>
    terminal: boolean
  }
  const trie: Node = { children: new Map(), terminal: false }
  const kept = new Set<Candidate>()
  const byDepth = [...candidates].sort(
    (a, b) => a.covers.length - b.covers.length,
  )
  for (const candidate of byDepth) {
    let node = trie
    let covered = node.terminal
    for (const key of candidate.covers) {
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
    kept.add(candidate)
  }
  return candidates.filter(candidate => kept.has(candidate))
}

/** Node targets as they are; keyed candidates merged per record. */
function group(candidates: readonly Candidate[]): readonly ReconcileTarget[] {
  const targets: ReconcileTarget[] = []
  const keyed = new Map<
    string,
    { readonly path: Path; readonly schema: SchemaNode; keys: string[] }
  >()
  for (const candidate of candidates) {
    if (candidate.key === undefined) {
      targets.push({ path: candidate.path, schema: candidate.schema })
      continue
    }
    const at = JSON.stringify(candidate.path.segmentKeys)
    let target = keyed.get(at)
    if (target === undefined) {
      target = { path: candidate.path, schema: candidate.schema, keys: [] }
      keyed.set(at, target)
      targets.push(target)
    }
    target.keys.push(candidate.key)
  }
  return targets
}

// ---------------------------------------------------------------------------
// reconcileShadow — the shell
// ---------------------------------------------------------------------------

/**
 * Bring σ up to date at each target, and return the ops it applied.
 *
 * Gathers every target's next value from λ first, through `resolver` and
 * `interpreter` (the materializer, with decay on ephemeral), plans each
 * part's ops with `diffOps` against σ, then applies them. A keyed target
 * reads only the named keys λ holds (`resolveHasKey`).
 *
 * `diffOps`'s payloads are copies of λ's values, and σ takes its own copy
 * through `ownedForStore`, so σ, λ and the returned ops share nothing: the
 * ops may be announced.
 */
export function reconcileShadow(
  shadow: PlainState,
  targets: readonly ReconcileTarget[],
  resolver: MaterializeResolver,
  interpreter: Interpreter<MaterializeContext, unknown>,
): Op[] {
  const ctx = materializeContextFromResolver(resolver)
  const read = (schema: SchemaNode, path: Path): unknown =>
    interpret(schema, interpreter, ctx, path)

  const nexts = targets.map(target => {
    const { path, schema, keys } = target
    if (keys === undefined) return read(schema, path)
    const next: Record<string, unknown> = {}
    const item = (schema as { readonly item: SchemaNode }).item
    for (const key of keys) {
      if (resolver.resolveHasKey(path, key)) {
        next[key] = read(item, path.entry(key))
      }
    }
    return next
  })

  const ops = targets.flatMap((target, i) =>
    diffOps(
      target.schema,
      target.path.read(shadow),
      nexts[i],
      target.path,
      target.keys,
    ),
  )

  for (const op of ops) {
    applyChange(shadow, op.path, ownedForStore(op.change))
  }
  return ops
}
