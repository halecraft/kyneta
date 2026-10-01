// reconcile-shadow — bring σ up to date from λ where a change touched it.
//
// Every way σ moves apart from an authored write and a plain `append` is one
// reconcile: the CRDT event bridges, an ephemeral merge or tick, a plain
// adopt. Each knows where the change landed (the ops a bridge announces, the
// paths an ephemeral join moved), `planSubtreeEffect` says how far below
// that it reached, and `landed` (`landing.ts`) where that is at the grain σ
// is stored. So the reconcile re-materializes only those parts, diffs
// each against σ, and applies the difference. It costs the size of what
// changed, and every σ object outside the touched parts keeps its identity.
//
//   plan     `planReconcile`: which parts of σ to refresh. Pure.
//   gather   read each part's next value from λ, through the resolver.
//   plan     `diffOps` of each part against σ. Pure.
//   execute  apply the ops to σ.

import type { Op } from "./changefeed.js"
import { diffOps } from "./diff-ops.js"
import type { Interpreter } from "./interpret.js"
import { interpret } from "./interpret.js"
import {
  type MaterializeContext,
  type MaterializeResolver,
  materializeContextFromResolver,
} from "./interpreters/materialize.js"
import { type Landed, landed, type Touched, uncovered } from "./landing.js"
import type { Path, RawPath } from "./path.js"
import { applyChange, freezePayload, type StateCell } from "./reader.js"
import { KIND, type Schema as SchemaNode } from "./schema.js"

/**
 * One `diffOps` call: the node at `path`, or, with `keys`, only those
 * entries of the record at `path`.
 */
export interface ReconcileTarget {
  readonly path: RawPath
  readonly schema: SchemaNode
  readonly keys?: readonly string[]
}

// ---------------------------------------------------------------------------
// planReconcile — pure
// ---------------------------------------------------------------------------

/**
 * The parts of σ to refresh after the changes `touched`, as few `diffOps`
 * calls as cover them. Three steps, in order:
 *
 * 1. **Land.** Where each change landed, at the grain σ is stored
 *    (`landed`): its keys expanded to the fields or entries they name, then
 *    lifted to an opaque boundary and to decay.
 * 2. **Record entries become keyed parents.** A node target at an entry could
 *    express neither a key that is gone (the materializer answers zeros for
 *    it) nor one that is new (the diff would be field writes under an entry σ
 *    lacks, not a map change at the record). This runs after landing,
 *    because a lift can land on an entry.
 * 3. **Cover and group.** A node target covers everything at or below its
 *    path, and a keyed target `{ k }` at P everything at or below `P.k`
 *    (`uncovered`). Keyed targets at one record merge, their keys combined.
 *
 * Paths compare by `segmentKeys`, element by element.
 */
export function planReconcile(
  root: SchemaNode,
  touched: readonly Touched[],
): readonly ReconcileTarget[] {
  const candidates = touched.flatMap(t => landed(root, t).map(toCandidate))
  return group(uncovered(candidates, c => c.covers))
}

/** A node target, or one key of a record. */
interface Candidate {
  readonly path: RawPath
  readonly schema: SchemaNode
  readonly key?: string
  /** `path`, or `path.entry(key)`: what this candidate covers. */
  readonly covers: readonly string[]
}

function toCandidate({ path, schemas }: Landed): Candidate {
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

/** Node targets as they are; keyed candidates merged per record. */
function group(candidates: readonly Candidate[]): readonly ReconcileTarget[] {
  const targets: ReconcileTarget[] = []
  const keyed = new Map<
    string,
    { readonly path: RawPath; readonly schema: SchemaNode; keys: string[] }
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
 * `diffOps`'s payloads are copies of λ's values, so λ shares nothing with σ
 * or the ops. σ and the returned ops share those copies, frozen
 * (`freezePayload`), so the ops may be announced.
 */
export function reconcileShadow(
  shadow: StateCell,
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
      target.path.read(shadow.current),
      nexts[i],
      target.path,
      target.keys,
    ),
  )

  for (const op of ops) {
    applyChange(shadow, op.path, freezePayload(op.change))
  }
  return ops
}
