// Zero — default values separated from the schema.
//
// A zero is the identity element for the step monoid — the state before
// any actions have been applied. Different contexts need different zeros
// (new document vs. loading skeleton vs. test fixture), so zeros are
// separated from the schema and composed via overlay.
//
// Zero.structural(schema) derives mechanical defaults by walking the
// unified schema grammar. Zero.overlay(primary, fallback, schema)
// performs a deep structural merge aware of structural kinds.

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
// Zero.for — type-checked identity (runtime passthrough)
// ---------------------------------------------------------------------------

/**
 * Returns `value` unchanged. This exists purely for documentation and
 * type-checking — it signals "this is a zero for this schema" without
 * any transformation.
 *
 * In a fully typed system, this would enforce that `value` matches
 * `Plain<typeof schema>`. In this spike, it's a typed identity.
 */
function forSchema<T>(_schema: Schema, value: T): T {
  return value
}

// ---------------------------------------------------------------------------
// Zero.partial — accept partial values (sparse zero)
// ---------------------------------------------------------------------------

/**
 * Returns `value` unchanged. Like `Zero.for`, this exists for
 * documentation and future type-checking. A partial zero is a sparse
 * object where some leaves are `undefined` (not yet specified).
 *
 * Partial zeros are composed with `Zero.overlay` to fill in gaps.
 */
function partial<T>(_schema: Schema, value: T): T {
  return value
}

// ---------------------------------------------------------------------------
// Zero.overlay — deep structural merge with per-kind awareness
// ---------------------------------------------------------------------------

/**
 * Performs a deep structural merge of `primary` over `fallback`, using
 * the schema to determine the merge strategy at each level.
 *
 * The rule at each node:
 * - **scalar / annotated leaf**: `primary ?? fallback`
 * - **product**: merge per-key, recursing into each field
 * - **sequence**: use primary if non-nullish, else fallback
 * - **map**: use primary if non-nullish, else fallback
 * - **sum**: use primary if non-nullish, else fallback
 * - **annotated with inner**: recurse into inner schema
 *
 * This is NOT a simple `??` — it's a deep structural merge that
 * recurses through products so that a partial primary can have its
 * gaps filled by the fallback.
 */
function overlay(primary: unknown, fallback: unknown, schema: Schema): unknown {
  // If primary is nullish, use fallback entirely
  if (primary === undefined || primary === null) {
    return fallback
  }

  switch (schema._kind) {
    case "scalar":
      // Leaf: primary wins
      return primary

    case "product": {
      // Deep merge per-key
      const primaryObj = (primary as Record<string, unknown>) ?? {}
      const fallbackObj = (fallback as Record<string, unknown>) ?? {}
      const result: Record<string, unknown> = {}

      for (const [key, fieldSchema] of Object.entries(schema.fields)) {
        result[key] = overlay(primaryObj[key], fallbackObj[key], fieldSchema)
      }
      return result
    }

    case "sequence":
      // Sequences: primary wins wholesale (no per-item merge by default)
      return primary

    case "map":
      // Maps: primary wins wholesale
      return primary

    case "sum":
      // Sums: primary wins wholesale
      return primary

    case "annotated": {
      // If the annotation has an inner schema, recurse
      if (schema.schema !== undefined) {
        return overlay(primary, fallback, schema.schema)
      }
      // Leaf annotation (text, counter): primary wins
      return primary
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
 * const custom = Zero.for(mySchema, { title: "Untitled" })
 * const sparse = Zero.partial(mySchema, { title: "Draft" })
 * const merged = Zero.overlay(sparse, defaults, mySchema)
 * ```
 */
export const Zero = {
  /**
   * Derive the mechanical default for a schema — the value you get
   * before any actions have been applied.
   */
  structural,

  /**
   * Type-checked identity — documents that a value is a complete zero
   * for the given schema.
   */
  for: forSchema,

  /**
   * Accept a partial value as a sparse zero. Compose with `overlay`
   * to fill in gaps.
   */
  partial,

  /**
   * Deep structural merge: `overlay(primary, fallback, schema)`.
   * Uses primary where defined, recurses into products, falls back
   * to fallback at leaves.
   */
  overlay,
} as const
