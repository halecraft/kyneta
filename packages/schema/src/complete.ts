// complete — a value shaped by its schema, before it enters σ.
//
// Pure over its inputs; `completeAt` reads σ through a reader and writes
// nothing. A write may carry a partial value: an untyped write, an older peer's
// entry, a `tree.create` with some of its data. The store takes the value
// complete, by the rule the materializer applies to native state: an absent
// value is its zero. So every read, every peer and every substrate see the
// same value.
//
// Recursion follows the schema kind, not the storage class: a sum's variant
// and a `.json()` struct are completed too, though each is stored as one
// register. Only the nodes that change are rebuilt, so a complete value costs
// one walk and no allocation, and comes back as itself.

import type { ChangeBase, PayloadSlot } from "./change.js"
import { mapPayload } from "./change.js"
import { landingSchema } from "./coordinate-exists.js"
import { isPlainObject } from "./guards.js"
import { dispatchSum } from "./interpret.js"
import { Zero } from "./interpreters/zero.js"
import type { Path } from "./path.js"
import type { Reader } from "./reader.js"
import {
  type DiscriminatedSumSchema,
  KIND,
  type PositionalSumSchema,
  type ProductSchema,
  type Schema as SchemaNode,
  type SumSchema,
} from "./schema.js"

/**
 * `value` shaped by `schema`: absent declared fields as `Zero.structural`,
 * undeclared keys dropped, a struct's fields in schema order, and sums
 * completed as the variant `dispatchSum` picks. Returns `value` itself when
 * it is already in that shape.
 *
 * A container of the wrong kind (a number where a struct is declared) is
 * absent, and so its zero, as the materializer reads it. A scalar of the
 * wrong kind passes through, as it does there: validation is not this
 * function's job.
 */
export function completeValue(schema: SchemaNode, value: unknown): unknown {
  if (value === undefined) return Zero.structural(schema)
  switch (schema[KIND]) {
    case "product":
      return isPlainObject(value)
        ? completeProduct(schema as ProductSchema, value)
        : Zero.structural(schema)
    case "map":
      // An array reads as a record keyed by index, as `plainResolution.keys`
      // lists it for the materializer; sets need it to list array members.
      if (Array.isArray(value)) {
        return completeEntries(schema.item, { ...value })
      }
      return isPlainObject(value)
        ? completeEntries(schema.item, value)
        : Zero.structural(schema)
    case "sequence":
    case "movable":
    case "set":
      return Array.isArray(value)
        ? completeItems(schema.item, value)
        : Zero.structural(schema)
    case "tree":
      return Array.isArray(value)
        ? completeForest(schema.item, value)
        : Zero.structural(schema)
    case "text":
      return typeof value === "string" ? value : Zero.structural(schema)
    case "counter":
      return typeof value === "number" ? value : Zero.structural(schema)
    case "richtext":
      return Array.isArray(value) ? value : Zero.structural(schema)
    case "sum":
      return completeSum(schema, value)
    case "scalar":
      return value
  }
}

/**
 * `change` with every carried value completed against the schema it lands
 * at: `mapPayload` over the slot schemas under `schema`, the schema at the
 * change's path. Returns `change` itself when nothing changes.
 *
 * A value whose slot the schema does not declare (an undeclared field of a
 * product, rich-text marks) is left as it is.
 */
export function completeChange(
  schema: SchemaNode,
  change: ChangeBase,
): ChangeBase {
  return mapPayload(change, (value, slot) => {
    const at = slotSchema(schema, slot)
    return at === undefined ? value : completeValue(at, value)
  })
}

/**
 * `change` at `path` completed against the schema it lands at, read from σ
 * through `reader` (`landingSchema`) as σ stands before the change applies.
 * A change that carries no values (text, counter, tree, deletions) is
 * returned without reading σ, and so is one whose path the schema does not
 * fit.
 */
export function completeAt(
  root: SchemaNode,
  reader: Reader,
  path: Path,
  change: ChangeBase,
): ChangeBase {
  let carries = false
  mapPayload(change, value => {
    carries = true
    return value
  })
  if (!carries) return change
  const at = landingSchema(root, reader, path, change)
  return at === undefined ? change : completeChange(at, change)
}

/** The schema of the value at `slot` under a change whose path has `schema`. */
function slotSchema(
  schema: SchemaNode,
  slot: PayloadSlot,
): SchemaNode | undefined {
  switch (slot.at) {
    case "self":
      return schema
    case "item":
      switch (schema[KIND]) {
        case "sequence":
        case "movable":
        case "set":
        case "tree":
          return schema.item
        default:
          return undefined
      }
    case "key":
      switch (schema[KIND]) {
        case "map":
          return schema.item
        case "product":
          return Object.hasOwn(schema.fields, slot.key)
            ? schema.fields[slot.key]
            : undefined
        default:
          return undefined
      }
    case "marks":
      return undefined
  }
}

/**
 * Rebuilt when a field changes or the value's own keys are not exactly the
 * schema's fields in schema order. That order is the materializer's, and the
 * same on every peer, so a writer and a receiver hold one key order.
 */
function completeProduct(
  schema: ProductSchema,
  value: Record<string, unknown>,
): unknown {
  let changed = false
  const out: Record<string, unknown> = {}
  const fields = Object.keys(schema.fields)
  for (const key of fields) {
    const child = value[key]
    const completed = completeValue(schema.fields[key] as SchemaNode, child)
    if (completed !== child || !Object.hasOwn(value, key)) changed = true
    out[key] = completed
  }
  if (!changed) {
    const own = Object.keys(value)
    changed =
      own.length !== fields.length || own.some((key, i) => key !== fields[i])
  }
  return changed ? out : value
}

function completeEntries(
  item: SchemaNode,
  value: Record<string, unknown>,
): unknown {
  let out: Record<string, unknown> | undefined
  for (const [key, child] of Object.entries(value)) {
    const completed = completeValue(item, child)
    if (completed !== child) out ??= { ...value }
    if (out !== undefined) out[key] = completed
  }
  return out ?? value
}

function completeItems(item: SchemaNode, value: readonly unknown[]): unknown {
  let out: unknown[] | undefined
  for (let i = 0; i < value.length; i++) {
    const child: unknown = value[i]
    const completed = completeValue(item, child)
    if (completed !== child) out ??= value.slice(0, i)
    out?.push(completed)
  }
  return out ?? value
}

/** A forest as σ holds it: `{ id, parent, index, data }` nodes. */
function completeForest(item: SchemaNode, value: readonly unknown[]): unknown {
  let out: unknown[] | undefined
  for (let i = 0; i < value.length; i++) {
    const node: unknown = value[i]
    let completed = node
    if (isPlainObject(node)) {
      const data = completeValue(item, node.data)
      if (data !== node.data) completed = { ...node, data }
    }
    if (completed !== node) out ??= value.slice(0, i)
    out?.push(completed)
  }
  return out ?? value
}

// `value` is defined here, so a completed variant is too, and `undefined`
// means the sum has no variant to pick.
function completeSum(schema: SumSchema, value: unknown): unknown {
  const completed = dispatchSum(value, schema, {
    byKey: key => {
      const variant = (schema as DiscriminatedSumSchema).variantMap[key]
      return variant === undefined ? value : completeValue(variant, value)
    },
    byIndex: index => {
      const variant = (schema as PositionalSumSchema).variants[index]
      return variant === undefined ? value : completeValue(variant, value)
    },
  })
  return completed ?? value
}
