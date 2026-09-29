// diff-ops — the ops a local writer would have produced to turn one state
// into another.
//
// Pure. A state-based merge (the ephemeral substrate's join, a decay sweep, a
// plain substrate's reset) has no ops of its own: it moves σ from one state
// to another. Subscribers, addresses and cached reads all key off ops, and
// delivery walks up from a changed path, never down. So the announcement has
// to be as fine as the store — one op per field, record key or register that
// moved — or a subscriber below a coarse op never hears the change.

import type { ChangeBase } from "./change.js"
import {
  diffText,
  incrementChange,
  mapChange,
  own,
  replaceChange,
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
 * - A text leaf becomes `diffText(before, after)`'s minimal contiguous edit,
 *   and a counter an increment by the difference, so their subscribers
 *   receive the change type they understand.
 * - Every other node that differs — an atomic register (a sum or `.json()`
 *   node), a sequence, a set, a tree, a rich-text delta, a scalar — becomes
 *   one `replace`.
 * - Unchanged nodes produce nothing.
 *
 * Values are compared only where an op would be emitted — leaves, registers
 * and record keys — never at a container before recursing into it, which
 * would make the diff O(size × depth).
 *
 * Every payload is a copy (`own`), so the ops share nothing with `after`.
 */
export function diffOps(
  schema: SchemaNode,
  before: unknown,
  after: unknown,
  path: Path = RawPath.empty,
): Op[] {
  const ops: Op[] = []
  diffNode(schema, before, after, path, ops)
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

function diffRecord(
  item: SchemaNode,
  before: unknown,
  after: unknown,
  path: Path,
  ops: Op[],
): void {
  const from = isNonNullObject(before) ? before : {}
  const to = isNonNullObject(after) ? after : {}
  const arrived: Record<string, unknown> = {}
  const left: string[] = []
  for (const key of Object.keys(from)) {
    if (!(key in to)) left.push(key)
  }
  for (const [key, value] of Object.entries(to)) {
    if (!(key in from)) arrived[key] = own(value)
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
  for (const key of Object.keys(to)) {
    if (key in from) diffNode(item, from[key], to[key], path.entry(key), ops)
  }
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
