// Zero — default values derived from the schema grammar.
//
// A zero is the identity element for the step monoid — the state before
// any actions have been applied. Zero.structural(schema) derives
// mechanical defaults by walking the unified schema grammar.
//
// Previous versions included Zero.overlay, Zero.for, and Zero.partial
// for seed-based initialization. These were removed because seed data
// conflates authoritative initial content with UI rendering defaults
// and produces state invisible to the sync protocol. Initial content
// should be applied via change() after substrate construction.

import type {
  DiscriminatedSumSchema,
  PositionalSumSchema,
  ScalarKind,
  ScalarSchema,
  Schema,
} from "./schema.js"

// ---------------------------------------------------------------------------
// Scalar defaults
// ---------------------------------------------------------------------------

/**
 * Returns the type-level default for a scalar kind.
 *
 * - `"string"` → `""`
 * - `"number"` → `0`
 * - `"boolean"` → `false`
 * - `"null"` → `null`
 * - `"undefined"` → `undefined`
 * - `"bytes"` → `new Uint8Array(0)`
 * - `"any"` → `undefined`
 */
export function scalarDefault(kind: ScalarKind): unknown {
  switch (kind) {
    case "string":
      return ""
    case "number":
      return 0
    case "boolean":
      return false
    case "null":
      return null
    case "undefined":
      return undefined
    case "bytes":
      return new Uint8Array(0)
    case "any":
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Annotation-specific defaults
// ---------------------------------------------------------------------------

/**
 * Returns a default value for well-known annotation tags, or `undefined`
 * if the tag is not recognized (in which case the caller should fall
 * through to the inner schema or a generic default).
 */
function annotationDefault(tag: string): { value: unknown } | undefined {
  switch (tag) {
    case "text":
      return { value: "" }
    case "counter":
      return { value: 0 }
    // "doc", "movable", "tree" — delegate to inner schema
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Zero.structural — derive defaults from the schema grammar
// ---------------------------------------------------------------------------

/**
 * Derives the mechanical structural zero for a schema by walking the
 * unified grammar. Requires no user configuration.
 *
 * - `scalar(kind)` → `scalarDefault(kind)`
 * - `product(fields)` → `{ k: structural(fields[k]) }` for each key
 * - `sequence(item)` → `[]`
 * - `map(item)` → `{}`
 * - `sum(variants)` → structural zero of the first variant
 * - `sum(discriminated)` → structural zero of the first variant in the map
 * - `annotated(tag, inner?)` → annotation-specific default if known,
 *   otherwise delegate to inner schema, otherwise `undefined`
 */
function structural(schema: Schema): unknown {
  switch (schema._kind) {
    case "scalar": {
      const s = schema as ScalarSchema
      if (s.constraint !== undefined && s.constraint.length > 0) {
        return s.constraint[0]
      }
      return scalarDefault(schema.scalarKind)
    }

    case "product": {
      const result: Record<string, unknown> = {}
      for (const [key, fieldSchema] of Object.entries(schema.fields)) {
        result[key] = structural(fieldSchema)
      }
      return result
    }

    case "sequence":
      return []

    case "map":
      return {}

    case "sum": {
      if (schema.discriminant !== undefined) {
        // Discriminated sum — use the first variant.
        // Each variant is a ProductSchema that declares the discriminant
        // as a constrained string scalar field, so walking its fields
        // naturally produces the discriminant value (from the constraint).
        const disc = schema as DiscriminatedSumSchema
        if (disc.variants.length === 0) {
          return undefined
        }
        return structural(disc.variants[0]!)
      }
      // Positional sum — use the first variant
      const variants = (schema as PositionalSumSchema).variants
      if (variants.length === 0) {
        return undefined
      }
      return structural(variants[0]!)
    }

    case "annotated": {
      // Check for annotation-specific default first
      const known = annotationDefault(schema.tag)
      if (known !== undefined) {
        return known.value
      }
      // Delegate to inner schema if present
      if (schema.schema !== undefined) {
        return structural(schema.schema)
      }
      // No inner schema and no known annotation — undefined
      return undefined
    }
  }
}

// ---------------------------------------------------------------------------
// Zero namespace
// ---------------------------------------------------------------------------

/**
 * Zero — default values for schemas.
 *
 * ```ts
 * const defaults = Zero.structural(mySchema)
 * // { title: "", count: 0, items: [], settings: { darkMode: false } }
 * ```
 */
export const Zero = {
  /**
   * Derive the mechanical default for a schema — the value you get
   * before any actions have been applied.
   */
  structural,
} as const