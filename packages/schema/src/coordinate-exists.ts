// coordinate-exists — whether a coordinate still exists, and its schema.
//
// Pure over its inputs: a schema, a reader over σ, and a path or segment.
// A coordinate exists by one rule whatever it is (a key or node id is in the
// state, a field is declared by the parent's schema), with every sum resolved
// from σ by the rule `dispatchSum` applies, so a field of an inactive variant,
// or of a nullable that is null, does not exist.

import { type ChangeBase, isReplaceChange } from "./change.js"
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
 * - A field exists iff the parent's active schema declares it, whether or
 *   not σ holds a value for it.
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
 * The schema at `path` under `root`, resolving every sum on the way from σ;
 * `undefined` where the path does not fit the schema.
 *
 * The σ-aware sibling of `walkPath`, which reads no values and so stops at a
 * sum. A sum at `path` itself is returned unresolved.
 */
export function liveSchemaAt(
  root: SchemaNode,
  reader: Reader,
  path: Path,
): SchemaNode | undefined {
  let schema: SchemaNode | undefined = root
  const segments = path.segments
  for (let depth = 0; depth < segments.length; depth++) {
    const segment = segments[depth]
    if (schema === undefined || segment === undefined) return undefined
    schema = childSchema(schema, reader, path.slice(0, depth), segment)
  }
  return schema
}

/**
 * The schema a change at `path` lands at, for completing what it carries;
 * `undefined` where the path does not fit the schema.
 *
 * A `replace` lands at the declared schema, since its value decides a sum's
 * variant. Any other change presupposes the variant σ holds: a `push` onto a
 * nullable list is a sequence change at the sum's own path, because the sum
 * forwards to its variant's carrier, which shares the path.
 */
export function landingSchema(
  root: SchemaNode,
  reader: Reader,
  path: Path,
  change: ChangeBase,
): SchemaNode | undefined {
  const at = liveSchemaAt(root, reader, path)
  if (at === undefined || isReplaceChange(change)) return at
  return activeSchema(at, reader, path)
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
