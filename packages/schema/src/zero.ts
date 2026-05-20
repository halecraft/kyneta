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

import type { Interpreter, Path, SumVariants } from "./interpret.js"
import { interpret } from "./interpret.js"
import type {
  DiscriminatedSumSchema,
  ProductSchema,
  ScalarKind,
  ScalarSchema,
  Schema,
  SumSchema,
  TreeSchema,
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
// zeroInterpreter — interpreter that derives structural defaults
// ---------------------------------------------------------------------------

export const zeroInterpreter: Interpreter<void, unknown> = {
  scalar(_ctx: undefined, _path: Path, schema: ScalarSchema): unknown {
    if (schema.constraint !== undefined && schema.constraint.length > 0) {
      return schema.constraint[0]
    }
    return scalarDefault(schema.scalarKind)
  },
  product(
    _ctx: undefined,
    _path: Path,
    _schema: ProductSchema,
    fields: Readonly<Record<string, () => unknown>>,
  ): unknown {
    const result: Record<string, unknown> = {}
    for (const [key, thunk] of Object.entries(fields)) {
      result[key] = thunk()
    }
    return result
  },
  sequence(): unknown {
    return []
  },
  map(): unknown {
    return {}
  },
  sum(
    _ctx: undefined,
    _path: Path,
    schema: SumSchema,
    variants: SumVariants<unknown>,
  ): unknown {
    if (schema.discriminant !== undefined) {
      const disc = schema as DiscriminatedSumSchema
      const firstKey = Object.keys(disc.variantMap)[0]
      if (firstKey !== undefined && variants.byKey) {
        return variants.byKey(firstKey)
      }
      return undefined
    }
    const positional = schema as { variants: readonly unknown[] }
    if (positional.variants.length > 0 && variants.byIndex) {
      return variants.byIndex(0)
    }
    return undefined
  },
  text(): unknown {
    return ""
  },
  counter(): unknown {
    return 0
  },
  set(): unknown {
    // Matches `Plain<SetSchema<I>> = Plain<I>[]` — sets materialize as
    // arrays, distinct from maps (which materialize as Records).
    return []
  },
  tree(
    _ctx: undefined,
    _path: Path,
    _schema: TreeSchema,
    nodeData: () => unknown,
  ): unknown {
    return nodeData()
  },
  movable(): unknown {
    return []
  },
  richtext(): unknown {
    return []
  },
}

// ---------------------------------------------------------------------------
// Zero.structural — derive defaults from the schema grammar
// ---------------------------------------------------------------------------

/**
 * Derives the mechanical structural zero for a schema by walking the
 * unified grammar. Requires no user configuration.
 */
function structural(schema: Schema): unknown {
  return interpret(schema, zeroInterpreter, undefined)
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
