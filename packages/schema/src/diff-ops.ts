// diff-ops — the ops a local writer would have produced to turn one state
// into another.
//
// Pure. A state-based merge (the ephemeral substrate's join, a decay sweep, a
// plain substrate's reset) has no ops of its own: it moves σ from one state
// to another. Subscribers, addresses and cached reads all key off ops, and
// whatever lies below an op is taken as rewritten. So the announcement has to
// be as fine as the store, one op per field, record key, list window or
// register that moved, or everything below a coarse op would rebuild and
// notify whether or not it moved. `reconcileShadow` calls it once per part of
// σ a change touched, which is how every such merge brings σ up to date.

import type { ChangeBase, Owned, SequenceInstruction } from "./change.js"
import {
  diffText,
  incrementChange,
  mapChange,
  own,
  replaceChange,
  sequenceChange,
  trustAsOwned,
} from "./change.js"
import type { Op } from "./changefeed.js"
import { isNonNullObject, samePlainValue } from "./guards.js"
import { type Path, RawPath } from "./path.js"
import {
  KIND,
  type ProductSchema,
  type Schema as SchemaNode,
  storageClass,
} from "./schema.js"
import { Zero } from "./zero.js"

/**
 * The ops a local writer would have produced to turn `before` into `after`
 * at `path`, guided by `schema`.
 *
 * - A declared struct field recurses. A field either side lacks reads as
 *   its structural zero, as a projection reads it.
 * - A record diffs by key: one map change setting the keys that arrived and
 *   deleting the keys that left, and a recursion into each key present on
 *   both sides.
 * - A list diffs by position: one sequence change retaining the common
 *   prefix, deleting and inserting the middle, and leaving the common suffix
 *   alone. Exact for one insert or delete, and linear; several scattered
 *   edits replace the window between the first and the last.
 * - A text leaf becomes `diffText(before, after)`'s minimal contiguous edit,
 *   and a counter an increment by the difference, so their subscribers
 *   receive the change type they understand.
 * - Every other node that differs becomes one `replace`: an atomic register
 *   (a sum or `.json()` node), a set, a tree, a rich-text delta, a scalar.
 * - Unchanged nodes produce nothing.
 *
 * With `keys`, the top node is a record, diffed only at those entries: which
 * of them arrived or left, and a recursion into those present on both sides.
 * `before` and `after` need hold only the named entries.
 *
 * Values are compared only where an op would be emitted (leaves, registers,
 * record keys and list items), never at a container before recursing into
 * it, which would make the diff O(size × depth).
 *
 * Every payload is a copy (`own`), so the ops share nothing with `after`.
 */
export function diffOps(
  schema: SchemaNode,
  before: unknown,
  after: unknown,
  path: Path = RawPath.empty,
  keys?: readonly string[],
): Op[] {
  const ops: Op[] = []
  if (keys === undefined) {
    diffNode(schema, before, after, path, ops)
    return ops
  }
  if (schema[KIND] !== "map") {
    throw new Error(
      `diffOps: keys name entries of a record, not children of a ${String(schema[KIND])}.`,
    )
  }
  diffRecord(
    (schema as { readonly item: SchemaNode }).item,
    before,
    after,
    path,
    ops,
    keys,
  )
  return ops
}

function diffNode(
  schema: SchemaNode,
  before: unknown,
  after: unknown,
  path: Path,
  ops: Op[],
): void {
  if (storageClass(schema) === "container") {
    switch (schema[KIND]) {
      case "product":
        diffProduct(schema as ProductSchema, before, after, path, ops)
        return
      case "map":
        diffRecord(
          (schema as { readonly item: SchemaNode }).item,
          before,
          after,
          path,
          ops,
        )
        return
      case "sequence":
      case "movable":
        diffList(before, after, path, ops)
        return
      case "text":
        diffTextLeaf(before, after, path, ops)
        return
      case "counter":
        diffCounter(before, after, path, ops)
        return
    }
  }
  if (!samePlainValue(before, after)) {
    emit(ops, path, replaceChange(own(after)))
  }
}

function diffProduct(
  schema: ProductSchema,
  before: unknown,
  after: unknown,
  path: Path,
  ops: Op[],
): void {
  const from = isNonNullObject(before) ? before : {}
  const to = isNonNullObject(after) ? after : {}
  for (const [key, field] of Object.entries(schema.fields)) {
    diffNode(
      field,
      key in from ? from[key] : Zero.structural(field),
      key in to ? to[key] : Zero.structural(field),
      path.field(key),
      ops,
    )
  }
}

/** `keys` defaults to every key either side holds. */
function diffRecord(
  item: SchemaNode,
  before: unknown,
  after: unknown,
  path: Path,
  ops: Op[],
  keys?: readonly string[],
): void {
  const from = isNonNullObject(before) ? before : {}
  const to = isNonNullObject(after) ? after : {}
  const arrived: Record<string, unknown> = {}
  const left: string[] = []
  const kept: string[] = []
  const classify = (key: string): void => {
    const inFrom = Object.hasOwn(from, key)
    const inTo = Object.hasOwn(to, key)
    if (inFrom && inTo) kept.push(key)
    else if (inFrom) left.push(key)
    else if (inTo) arrived[key] = own(to[key])
  }
  if (keys === undefined) {
    for (const key of Object.keys(from)) {
      if (!Object.hasOwn(to, key)) left.push(key)
    }
    for (const key of Object.keys(to)) {
      if (Object.hasOwn(from, key)) kept.push(key)
      else arrived[key] = own(to[key])
    }
  } else {
    for (const key of keys) classify(key)
  }
  if (left.length > 0 || Object.keys(arrived).length > 0) {
    emit(
      ops,
      path,
      mapChange(
        // Built here, of values `own` just copied.
        Object.keys(arrived).length > 0 ? trustAsOwned(arrived) : undefined,
        left.length > 0 ? left : undefined,
      ),
    )
  }
  for (const key of kept) {
    diffNode(item, from[key], to[key], path.entry(key), ops)
  }
}

/**
 * One sequence change: retain the common prefix, delete and insert the
 * middle, leave the common suffix. Items compare by value, so the edit is
 * linear in the lists' size.
 */
function diffList(
  before: unknown,
  after: unknown,
  path: Path,
  ops: Op[],
): void {
  const from: readonly unknown[] = Array.isArray(before) ? before : []
  const to: readonly unknown[] = Array.isArray(after) ? after : []
  const shorter = Math.min(from.length, to.length)
  let prefix = 0
  while (prefix < shorter && samePlainValue(from[prefix], to[prefix])) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < shorter - prefix &&
    samePlainValue(from[from.length - 1 - suffix], to[to.length - 1 - suffix])
  ) {
    suffix++
  }
  const deleted = from.length - prefix - suffix
  const inserted = to.slice(prefix, to.length - suffix)
  if (deleted === 0 && inserted.length === 0) return
  const instructions: SequenceInstruction<Owned<unknown>>[] = []
  if (prefix > 0) instructions.push({ retain: prefix })
  if (deleted > 0) instructions.push({ delete: deleted })
  if (inserted.length > 0) {
    instructions.push({ insert: inserted.map(item => own(item)) })
  }
  emit(ops, path, sequenceChange(instructions))
}

function diffTextLeaf(
  before: unknown,
  after: unknown,
  path: Path,
  ops: Op[],
): void {
  const from = typeof before === "string" ? before : ""
  const to = typeof after === "string" ? after : ""
  if (from !== to) emit(ops, path, diffText(from, to))
}

function diffCounter(
  before: unknown,
  after: unknown,
  path: Path,
  ops: Op[],
): void {
  const from = typeof before === "number" ? before : 0
  const to = typeof after === "number" ? after : 0
  if (from !== to) emit(ops, path, incrementChange(to - from))
}

function emit(ops: Op[], path: Path, change: ChangeBase): void {
  ops.push({ path, change })
}
