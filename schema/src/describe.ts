// describe — human-readable indented tree view of a schema.
//
// Pure function over schema data. No interpreter machinery, no context,
// no dependencies beyond the schema types themselves.
//
//   import { describe } from "@loro-extended/schema"
//   console.log(describe(mySchema))
//
// Output example:
//
//   doc
//     name: text
//     description: text
//     stars: counter
//     tasks: list
//       title: string
//       done: boolean
//       priority: number
//     settings:
//       visibility: string
//       maxTasks: number
//       archived: boolean
//     labels: record<string>

import type {
  Schema,
  ScalarSchema,
  AnnotatedSchema,
  DiscriminatedSumSchema,
  PositionalSumSchema,
} from "./schema.js"

// ---------------------------------------------------------------------------
// describe — the public API
// ---------------------------------------------------------------------------

/**
 * Returns a human-readable indented tree view of a schema.
 *
 * Useful for logging, debugging, documentation, and introspection.
 * The output is designed to be immediately understandable even for
 * deeply nested schemas.
 *
 * ```ts
 * const schema = Schema.doc({
 *   title: Schema.string(),
 *   count: Schema.number(),
 *   items: Schema.list(Schema.struct({
 *     name: Schema.string(),
 *     done: Schema.boolean(),
 *   })),
 * })
 *
 * console.log(describe(schema))
 * // doc
 * //   title: text
 * //   count: counter
 * //   items: list
 * //     name: string
 * //     done: boolean
 * ```
 */
export function describe(schema: Schema): string {
  const lines: string[] = []
  walk(schema, lines, 0, undefined)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Internal tree walker
// ---------------------------------------------------------------------------

const INDENT = "  "

/**
 * Recursively builds lines of the tree view.
 *
 * `label` is the field name (or variant key) that precedes the colon.
 * When undefined, the node is rendered without a label (e.g. the root).
 */
function walk(
  schema: Schema,
  lines: string[],
  depth: number,
  label: string | undefined,
): void {
  const prefix = INDENT.repeat(depth)
  const lbl = label !== undefined ? `${label}: ` : ""

  switch (schema._kind) {
    // --- Scalar: leaf value --------------------------------------------------
    case "scalar": {
      const s = schema as ScalarSchema
      if (s.constraint !== undefined && s.constraint.length > 0) {
        const vals = s.constraint.map((v) => JSON.stringify(v)).join(" | ")
        lines.push(`${prefix}${lbl}${schema.scalarKind}(${vals})`)
      } else {
        lines.push(`${prefix}${lbl}${schema.scalarKind}`)
      }
      return
    }

    // --- Product: fixed-key record -------------------------------------------
    case "product": {
      const keys = Object.keys(schema.fields)
      if (keys.length === 0) {
        lines.push(`${prefix}${lbl}{}`)
        return
      }
      // If there's a label, print it as a heading line, then indent fields
      if (label !== undefined) {
        lines.push(`${prefix}${label}:`)
        for (const key of keys) {
          walk(schema.fields[key]!, lines, depth + 1, key)
        }
      } else {
        // No label (bare product at root) — just print fields at current depth
        for (const key of keys) {
          walk(schema.fields[key]!, lines, depth, key)
        }
      }
      return
    }

    // --- Sequence: ordered collection ----------------------------------------
    case "sequence": {
      const itemDesc = inlineOrNull(schema.item)
      if (itemDesc !== null) {
        // Item is simple enough to render inline: "list<string>"
        lines.push(`${prefix}${lbl}list<${itemDesc}>`)
      } else {
        // Item is complex — render on next lines
        lines.push(`${prefix}${lbl}list`)
        walkChildren(schema.item, lines, depth + 1)
      }
      return
    }

    // --- Map: dynamic-key collection -----------------------------------------
    case "map": {
      const itemDesc = inlineOrNull(schema.item)
      if (itemDesc !== null) {
        lines.push(`${prefix}${lbl}record<${itemDesc}>`)
      } else {
        lines.push(`${prefix}${lbl}record`)
        walkChildren(schema.item, lines, depth + 1)
      }
      return
    }

    // --- Sum: union ----------------------------------------------------------
    case "sum": {
      if (schema.discriminant !== undefined) {
        // Discriminated sum
        const disc = schema as DiscriminatedSumSchema
        lines.push(`${prefix}${lbl}union(${disc.discriminant})`)
        for (const [key, variant] of Object.entries(disc.variantMap)) {
          walk(variant, lines, depth + 1, key)
        }
      } else {
        // Positional sum
        const pos = schema as PositionalSumSchema

        // Nullable sugar: sum([scalar("null"), X]) → nullable<X>
        if (
          pos.variants.length === 2 &&
          pos.variants[0]!._kind === "scalar" &&
          (pos.variants[0] as ScalarSchema).scalarKind === "null"
        ) {
          const inner = pos.variants[1]!
          const innerDesc = inlineOrNull(inner)
          if (innerDesc !== null) {
            lines.push(`${prefix}${lbl}nullable<${innerDesc}>`)
          } else {
            lines.push(`${prefix}${lbl}nullable`)
            walkChildren(inner, lines, depth + 1)
          }
        } else {
          lines.push(`${prefix}${lbl}union`)
          for (let i = 0; i < pos.variants.length; i++) {
            walk(pos.variants[i]!, lines, depth + 1, `${i}`)
          }
        }
      }
      return
    }

    // --- Annotated: semantic enrichment --------------------------------------
    case "annotated": {
      const tag = schema.tag

      // Leaf annotations (no inner schema)
      if (schema.schema === undefined) {
        lines.push(`${prefix}${lbl}${tag}`)
        return
      }

      // "doc" annotation — the root document wrapper.
      // Render as "doc" heading, then delegate to inner product's fields.
      if (tag === "doc") {
        lines.push(`${prefix}${lbl}doc`)
        walkChildren(schema.schema, lines, depth + 1)
        return
      }

      // "movable" annotation — movable list.
      // The inner schema is a sequence; unwrap it and show "movable-list<...>"
      if (tag === "movable" && schema.schema._kind === "sequence") {
        const itemDesc = inlineOrNull(schema.schema.item)
        if (itemDesc !== null) {
          lines.push(`${prefix}${lbl}movable-list<${itemDesc}>`)
        } else {
          lines.push(`${prefix}${lbl}movable-list`)
          walkChildren(schema.schema.item, lines, depth + 1)
        }
        return
      }

      // "tree" annotation — tree with typed node data.
      if (tag === "tree") {
        lines.push(`${prefix}${lbl}tree`)
        walkChildren(schema.schema, lines, depth + 1)
        return
      }

      // Generic annotation with inner schema
      const innerDesc = inlineOrNull(schema.schema)
      if (innerDesc !== null) {
        lines.push(`${prefix}${lbl}@${tag}<${innerDesc}>`)
      } else {
        lines.push(`${prefix}${lbl}@${tag}`)
        walkChildren(schema.schema, lines, depth + 1)
      }
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * If a schema node can be described in a short inline string (suitable for
 * use inside angle brackets), returns that string. Otherwise returns null,
 * signaling the caller should render it as indented children.
 */
function inlineOrNull(schema: Schema): string | null {
  switch (schema._kind) {
    case "scalar": {
      const s = schema as ScalarSchema
      if (s.constraint !== undefined && s.constraint.length > 0) {
        const vals = s.constraint.map((v) => JSON.stringify(v)).join(" | ")
        return `${schema.scalarKind}(${vals})`
      }
      return schema.scalarKind
    }

    case "annotated":
      // Leaf annotations like text, counter
      if (schema.schema === undefined) {
        return schema.tag
      }
      // movable list with inline item
      if (schema.tag === "movable" && schema.schema._kind === "sequence") {
        const inner = inlineOrNull(schema.schema.item)
        if (inner !== null) return `movable-list<${inner}>`
      }
      return null

    case "sequence": {
      const inner = inlineOrNull(schema.item)
      if (inner !== null) return `list<${inner}>`
      return null
    }

    case "map": {
      const inner = inlineOrNull(schema.item)
      if (inner !== null) return `record<${inner}>`
      return null
    }

    // Products, sums — never inline
    default:
      return null
  }
}

/**
 * Renders the children of a schema node. For products, this means each
 * field on its own line. For other nodes, a single unlabeled child.
 */
function walkChildren(
  schema: Schema,
  lines: string[],
  depth: number,
): void {
  if (schema._kind === "product") {
    for (const key of Object.keys(schema.fields)) {
      walk(schema.fields[key]!, lines, depth, key)
    }
  } else {
    walk(schema, lines, depth, undefined)
  }
}