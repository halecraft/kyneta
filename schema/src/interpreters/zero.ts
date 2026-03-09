// Zero interpreter — produces structural defaults by ignoring context.
//
// This interpreter demonstrates that Zero.structural(schema) is equivalent
// to interpret(schema, zeroInterpreter, undefined). The zero interpreter
// is the "derive placeholder" operation expressed as an algebra over the
// schema functor.

import type { Interpreter, Path, SumVariants } from "../interpret.js"
import type {
  ScalarSchema,
  ProductSchema,
  SequenceSchema,
  MapSchema,
  SumSchema,
  AnnotatedSchema,
  DiscriminatedSumSchema,
  PositionalSumSchema,
} from "../schema.js"
import { scalarDefault } from "../zero.js"

// ---------------------------------------------------------------------------
// Annotation-specific defaults (mirrors zero.ts logic)
// ---------------------------------------------------------------------------

function annotationDefault(tag: string): { value: unknown } | undefined {
  switch (tag) {
    case "text":
      return { value: "" }
    case "counter":
      return { value: 0 }
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Zero interpreter
// ---------------------------------------------------------------------------

/**
 * An interpreter that ignores context and produces the structural zero
 * (mechanical default) for every schema node.
 *
 * This proves that `Zero.structural(schema)` is just a specific
 * interpreter applied via the generic `interpret()` catamorphism:
 *
 * ```ts
 * import { interpret } from "../interpret.js"
 * import { Zero } from "../zero.js"
 *
 * const schema = Schema.doc({
 *   title: Schema.string(),
 *   count: Schema.number(),
 *   items: Schema.list(Schema.string()),
 * })
 *
 * const viaZero = Zero.structural(schema)
 * const viaInterp = interpret(schema, zeroInterpreter, undefined)
 *
 * // These produce the same result:
 * // { title: "", count: 0, items: [] }
 * ```
 *
 * Context type is `void` — the zero interpreter needs no external data.
 */
export const zeroInterpreter: Interpreter<void, unknown> = {
  scalar(_ctx: void, _path: Path, schema: ScalarSchema): unknown {
    return scalarDefault(schema.scalarKind)
  },

  product(
    _ctx: void,
    _path: Path,
    _schema: ProductSchema,
    fields: Readonly<Record<string, () => unknown>>,
  ): unknown {
    // Force all field thunks to build the complete default object
    const result: Record<string, unknown> = {}
    for (const [key, thunk] of Object.entries(fields)) {
      result[key] = thunk()
    }
    return result
  },

  sequence(
    _ctx: void,
    _path: Path,
    _schema: SequenceSchema,
    _item: (index: number) => unknown,
  ): unknown {
    // Default for a sequence is an empty array — no items to interpret
    return []
  },

  map(
    _ctx: void,
    _path: Path,
    _schema: MapSchema,
    _item: (key: string) => unknown,
  ): unknown {
    // Default for a map is an empty object — no keys to interpret
    return {}
  },

  sum(
    _ctx: void,
    _path: Path,
    schema: SumSchema,
    variants: SumVariants<unknown>,
  ): unknown {
    if (schema.discriminant !== undefined && variants.byKey) {
      // Discriminated sum — use the first variant, inject discriminant key
      const discSchema = schema as DiscriminatedSumSchema
      const keys = Object.keys(discSchema.variantMap)
      if (keys.length === 0) {
        return undefined
      }
      const firstKey = keys[0]!
      const inner = variants.byKey(firstKey)
      // If the variant produces an object, add the discriminant key
      if (inner !== null && inner !== undefined && typeof inner === "object") {
        return { ...(inner as Record<string, unknown>), [schema.discriminant]: firstKey }
      }
      return inner
    }

    // Positional sum — use the first variant
    if (variants.byIndex) {
      const posSchema = schema as PositionalSumSchema
      if (posSchema.variants.length === 0) {
        return undefined
      }
      return variants.byIndex(0)
    }

    return undefined
  },

  annotated(
    _ctx: void,
    _path: Path,
    schema: AnnotatedSchema,
    inner: (() => unknown) | undefined,
  ): unknown {
    // Check for annotation-specific default first
    const known = annotationDefault(schema.tag)
    if (known !== undefined) {
      return known.value
    }

    // Delegate to inner schema if present
    if (inner !== undefined) {
      return inner()
    }

    // No inner schema and no known annotation — undefined
    return undefined
  },
}