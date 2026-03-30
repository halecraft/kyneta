// Plain interpreter — reads values from a plain JS object.
//
// Given a schema and a plain JS object (the "store"), this interpreter
// reads the value at each path in the object tree. Annotations are
// transparent — the plain interpreter reads the same way regardless
// of annotation. This corresponds to today's `toJSON()` / `value()`
// functionality.

import { isNonNullObject } from "../guards.js"
import type { Interpreter, Path } from "../interpret.js"
import type {
  AnnotatedSchema,
  MapSchema,
  ProductSchema,
  ScalarSchema,
  SequenceSchema,
  SumSchema,
} from "../schema.js"


// ---------------------------------------------------------------------------
// Plain interpreter
// ---------------------------------------------------------------------------

/**
 * An interpreter that reads plain values from a nested JS object.
 *
 * The context (`Ctx`) is the root store object. The result (`A`) is
 * `unknown` — the plain JS value at each schema node.
 *
 * ```ts
 * const store = { title: "Hello", count: 42, tags: ["a", "b"] }
 * const schema = Schema.doc({
 *   title: Schema.string(),
 *   count: Schema.number(),
 *   tags: Schema.list(Schema.string()),
 * })
 * const result = interpret(schema, plainInterpreter, store)
 * // → { title: "Hello", count: 42, tags: ["a", "b"] }
 * ```
 *
 * ### Annotations are transparent
 *
 * `Schema.annotated("text")` and `Schema.string()` both read a string from
 * the store. The plain interpreter doesn't distinguish between annotated
 * and unannotated nodes — it reads from the same path regardless.
 */
export const plainInterpreter: Interpreter<unknown, unknown> = {
  scalar(ctx: unknown, path: Path, _schema: ScalarSchema): unknown {
    return path.read(ctx)
  },

  product(
    _ctx: unknown,
    _path: Path,
    _schema: ProductSchema,
    fields: Readonly<Record<string, () => unknown>>,
  ): unknown {
    // Force all field thunks — the plain interpreter eagerly reads
    // every field to produce a complete plain object.
    const result: Record<string, unknown> = {}
    for (const [key, thunk] of Object.entries(fields)) {
      result[key] = thunk()
    }
    return result
  },

  sequence(
    ctx: unknown,
    path: Path,
    _schema: SequenceSchema,
    item: (index: number) => unknown,
  ): unknown {
    // Read the array at this path and interpret each item
    const arr = path.read(ctx)
    if (!Array.isArray(arr)) {
      return []
    }
    return arr.map((_element, index) => item(index))
  },

  map(
    ctx: unknown,
    path: Path,
    _schema: MapSchema,
    item: (key: string) => unknown,
  ): unknown {
    // Read the object at this path and interpret each key
    const obj = path.read(ctx)
    if (!isNonNullObject(obj)) {
      return {}
    }
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(obj)) {
      result[key] = item(key)
    }
    return result
  },

  sum(
    ctx: unknown,
    path: Path,
    schema: SumSchema,
    variants: {
      byIndex?: (index: number) => unknown
      byKey?: (key: string) => unknown
    },
  ): unknown {
    // For discriminated sums, read the discriminant from the value
    // and interpret through the matching variant.
    if (schema.discriminant !== undefined && variants.byKey) {
      const value = path.read(ctx)
      if (isNonNullObject(value)) {
        const discValue = value[schema.discriminant]
        if (typeof discValue === "string") {
          return variants.byKey(discValue)
        }
      }
      // Can't determine variant — return the raw value
      return value
    }

    // For positional sums, we can't determine which variant the value
    // belongs to at runtime without additional type information.
    // Return the raw value — callers that need variant dispatch should
    // use discriminated sums.
    return path.read(ctx)
  },

  annotated(
    _ctx: unknown,
    _path: Path,
    _schema: AnnotatedSchema,
    inner: (() => unknown) | undefined,
  ): unknown {
    // Annotations are transparent for the plain interpreter.
    // If there's an inner schema, delegate to it — the inner
    // interpretation will read from the same path.
    if (inner !== undefined) {
      return inner()
    }

    // Leaf annotations (text, counter) — read the raw value at path.
    // The catamorphism passes the same path for the annotation and
    // its inner — so for leaf annotations without inner schema,
    // we read from the store directly.
    return _path.read(_ctx)
  },
}
