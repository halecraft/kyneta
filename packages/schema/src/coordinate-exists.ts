// coordinate-exists — whether a coordinate still exists, and its schema.
//
// Pure over its inputs: a parent's schema, a reader over σ, and the segment.
// A coordinate exists by one rule whatever it is — a key or node id is in the
// state, a field is declared by the parent's schema — with every sum resolved
// from σ by the rule `dispatchSum` applies, so a field of an inactive variant,
// or of a nullable that is null, does not exist.

import { dispatchSum } from "./interpret.js"
import type { Path, Segment } from "./path.js"
import type { Reader } from "./reader.js"
import {
  type DiscriminatedSumSchema,
  KIND,
  type PositionalSumSchema,
  type ProductSchema,
  type Schema as SchemaNode,
} from "./schema.js"

/**
 * `schema` with every sum at `path` resolved to the variant σ holds there,
 * by the rule `dispatchSum` applies. A non-sum is returned as is.
 */
export function activeSchema(
  schema: SchemaNode,
  reader: Reader,
  path: Path,
): SchemaNode {
  let current = schema
  while (current[KIND] === "sum") {
    const variant: SchemaNode | undefined = dispatchSum(
      reader.read(path),
      current,
      {
        byKey: key => (current as DiscriminatedSumSchema).variantMap[key],
        byIndex: index => (current as PositionalSumSchema).variants[index],
      },
    )
    if (variant === undefined) return current
    current = variant
  }
  return current
}

/**
 * Whether `segment` exists under the coordinate at `parentPath`, whose schema
 * is `parentSchema`.
 *
 * - A field exists iff the parent's active schema declares it. A declared
 *   field exists even where σ lacks it: a partial entry reads as zeros.
 * - A map key exists iff σ has it.
 * - A tree node exists iff its id is in the forest.
 * - A list item is not asked: inside a rewritten subtree it has no
 *   correspondence, and outside one its address advances.
 */
export function coordinateExists(
  parentSchema: SchemaNode,
  reader: Reader,
  parentPath: Path,
  segment: Segment,
): boolean {
  const parent = activeSchema(parentSchema, reader, parentPath)
  const key = String(segment.coord())
  switch (segment.role) {
    case "field":
      return (
        parent[KIND] === "product" &&
        Object.hasOwn((parent as ProductSchema).fields, key)
      )
    case "entry":
      if (parent[KIND] === "tree") {
        return reader.forestTopology(parentPath).some(node => node.id === key)
      }
      return reader.hasKey(parentPath, key)
    case "index":
      return true
  }
}

/**
 * The schema of the child at `segment` under a parent whose schema is
 * `parentSchema`, resolving the parent's sums from σ; `undefined` where the
 * parent declares no such child.
 */
export function childSchema(
  parentSchema: SchemaNode,
  reader: Reader,
  parentPath: Path,
  segment: Segment,
): SchemaNode | undefined {
  const parent = activeSchema(parentSchema, reader, parentPath)
  switch (parent[KIND]) {
    case "product":
      return segment.role === "field"
        ? (parent as ProductSchema).fields[String(segment.coord())]
        : undefined
    case "map":
    case "set":
    case "sequence":
    case "movable":
    case "tree":
      return segment.role === "field"
        ? undefined
        : (parent as { readonly item: SchemaNode }).item
    default:
      return undefined
  }
}
