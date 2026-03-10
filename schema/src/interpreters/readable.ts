// Readable interpreter — produces callable, function-shaped refs at every
// schema node. This is the foundational read surface.
//
// Every ref is an arrow function: `ref()` returns the current plain value
// at that path (`readByPath(ctx.store, path)`). Structural nodes have
// navigation (lazy getters for products, `.at(i)` for sequences,
// Map-like methods for maps). Leaf annotations get `[Symbol.toPrimitive]`
// for template literal coercion.
//
// The readable interpreter owns **reading + structural navigation**.
// Mutation is a separate concern provided by `withMutation`.
// Observation is a separate concern provided by `withChangefeed`.
//
// Composability hooks:
// - `[INVALIDATE]` on sequence/map refs — called by mutation layer to
//   clear child caches after writes.
//
// See theory §5.4 (capability decomposition) and readable-interpreter.md.

import type { Interpreter, Path, SumVariants } from "../interpret.js"
import {
  isNullableSum,
  type Schema,
  type ScalarSchema,
  type ProductSchema,
  type SequenceSchema,
  type MapSchema,
  type SumSchema,
  type AnnotatedSchema,
  type PositionalSumSchema,
  type DiscriminatedSumSchema,
} from "../schema.js"
import { type Store, readByPath } from "../store.js"
import { isNonNullObject } from "../guards.js"

import type { RefContext, Plain } from "../interpreter-types.js"

// Re-export RefContext for consumers
export type { RefContext } from "../interpreter-types.js"

// ---------------------------------------------------------------------------
// Composability symbols
// ---------------------------------------------------------------------------

/**
 * Symbol for cache invalidation. Attached to sequence and map refs.
 *
 * Called by `withMutation` after dispatching changes:
 * - `ref[INVALIDATE]()` — clears the entire child cache
 * - `ref[INVALIDATE](key)` — clears a single entry
 *
 * Uses `Symbol.for` so multiple copies of this module share identity.
 */
export const INVALIDATE: unique symbol = Symbol.for(
  "schema:invalidate",
) as any

// ---------------------------------------------------------------------------
// Readable<S> — type-level interpretation for readable refs
// ---------------------------------------------------------------------------

/**
 * An interface for readable sequence refs: callable + navigation.
 * The call signature returns the plain array. `.at(i)` returns a
 * child ref or `undefined` for out-of-bounds indices.
 * `.length` reflects the store array length.
 */
export interface ReadableSequenceRef<T = unknown> {
  (): unknown[]
  at: (index: number) => T | undefined
  readonly length: number
  [Symbol.iterator](): Iterator<T>
}

/**
 * An interface for readable map refs: callable + Map-like navigation.
 * The call signature returns the plain record. `.get(key)` returns a
 * child ref or `undefined` for missing keys. `.has()`, `.keys()`,
 * `.size`, `.entries()`, `.values()`, `[Symbol.iterator]` provide
 * Map-like introspection.
 */
export interface ReadableMapRef<T = unknown> {
  /** Callable: returns a deep plain snapshot of the entire map. */
  (): Record<string, unknown>
  /** Get a child ref by key. Returns undefined if key is not in the store. */
  get(key: string): T | undefined
  /** Check if a key exists in the store. */
  has(key: string): boolean
  /** Return all current store keys. */
  keys(): string[]
  /** Number of entries in the store. */
  readonly size: number
  /** Iterate over [key, childRef] pairs. */
  entries(): IterableIterator<[string, T]>
  /** Iterate over child refs. */
  values(): IterableIterator<T>
  /** Iterate over [key, childRef] pairs. */
  [Symbol.iterator](): IterableIterator<[string, T]>
}

/**
 * Computes the readable ref type for a given schema type.
 *
 * This is the type-level counterpart to `readableInterpreter`. Every
 * node is callable (`ref()` returns `Plain<S>`). Structural nodes have
 * navigation. Leaf nodes have `[Symbol.toPrimitive]`.
 *
 * ```ts
 * const s = Schema.doc({
 *   title: Schema.string(),
 *   count: Schema.number(),
 * })
 *
 * type Doc = Readable<typeof s>
 * // doc() → { title: string, count: number }
 * // doc.title() → string
 * // doc.count() → number
 * ```
 */
export type Readable<S extends Schema> =
  // --- Annotated: dispatch on tag ---
  S extends AnnotatedSchema<infer Tag, infer Inner>
    ? Tag extends "text"
      ? (() => string) & { [Symbol.toPrimitive](hint: string): string }
      : Tag extends "counter"
        ? (() => number) & {
            [Symbol.toPrimitive](hint: string): number | string
          }
        : Tag extends "doc"
          ? Inner extends ProductSchema<infer F>
            ? (() => { [K in keyof F]: Plain<F[K]> }) & {
                readonly [K in keyof F]: Readable<F[K]>
              }
            : unknown
          : Tag extends "movable"
            ? Inner extends SequenceSchema<infer I>
              ? ReadableSequenceRef<Readable<I>>
              : unknown
            : Tag extends "tree"
              ? Inner extends Schema
                ? Readable<Inner>
                : unknown
              : // Unknown annotation with inner — delegate
                Inner extends Schema
                ? Readable<Inner>
                : unknown
    : // --- Scalar ---
      S extends ScalarSchema<infer _K, infer V>
      ? (() => V) & { [Symbol.toPrimitive](hint: string): V | string }
      : // --- Product ---
        S extends ProductSchema<infer F>
        ? (() => { [K in keyof F]: Plain<F[K]> }) & {
            readonly [K in keyof F]: Readable<F[K]>
          }
        : // --- Sequence ---
          S extends SequenceSchema<infer I>
          ? ReadableSequenceRef<Readable<I>>
          : // --- Map ---
            S extends MapSchema<infer I>
            ? ReadableMapRef<Readable<I>>
            : // --- Sum ---
              S extends PositionalSumSchema<infer V>
              ? Readable<V[number]>
              : S extends DiscriminatedSumSchema
                ? unknown
                : unknown

// ---------------------------------------------------------------------------
// Readable interpreter
// ---------------------------------------------------------------------------

/**
 * A readable interpreter that produces callable, function-shaped refs
 * backed by a plain JS object store. Produces the **read surface** only.
 *
 * Every ref is an arrow function: `ref()` returns the current plain value.
 * Leaf refs have `[Symbol.toPrimitive]` for template literal coercion.
 * Structural refs have navigation (lazy getters, `.at(i)`, Proxy).
 *
 * For mutation, compose with `withMutation(readableInterpreter)`.
 * For observation, compose with `enrich(..., withChangefeed)`.
 *
 * ```ts
 * const store = { title: "Hello", count: 42 }
 * const ctx: RefContext = { store }
 * const doc = interpret(schema, readableInterpreter, ctx)
 * doc.title()     // "Hello"
 * doc.count()     // 42
 * doc()           // { title: "Hello", count: 42 }
 * `${doc.count}`  // "42" (via toPrimitive)
 * ```
 */
export const readableInterpreter: Interpreter<RefContext, unknown> = {
  // --- Scalar ----------------------------------------------------------------
  // Arrow function returning the current value. Plus hint-aware toPrimitive.

  scalar(ctx: RefContext, path: Path, _schema: ScalarSchema): unknown {
    const ref: any = () => readByPath(ctx.store, path)
    ref[Symbol.toPrimitive] = (hint: string) => {
      const v = readByPath(ctx.store, path)
      return hint === "string" ? String(v) : v
    }
    return ref
  },

  // --- Product ---------------------------------------------------------------
  // Arrow function (callable for deep snapshot) with lazy child getters.
  // No Proxy — fixed keys from the schema.

  product(
    ctx: RefContext,
    path: Path,
    _schema: ProductSchema,
    fields: Readonly<Record<string, () => unknown>>,
  ): unknown {
    const ref = () => readByPath(ctx.store, path)

    // Define lazy getters for each schema field — cache on first access
    for (const [key, thunk] of Object.entries(fields)) {
      let cached: unknown = undefined
      let resolved = false

      Object.defineProperty(ref, key, {
        get() {
          if (!resolved) {
            cached = thunk()
            resolved = true
          }
          return cached
        },
        enumerable: true,
        configurable: true,
      })
    }

    return ref
  },

  // --- Sequence --------------------------------------------------------------
  // Arrow function (callable for plain array snapshot) with .at(i), .length,
  // [Symbol.iterator], and [INVALIDATE] for mutation layer cache coordination.

  sequence(
    ctx: RefContext,
    path: Path,
    _schema: SequenceSchema,
    item: (index: number) => unknown,
  ): unknown {
    const childCache = new Map<number, unknown>()

    const ref: any = () => readByPath(ctx.store, path)

    ref.at = (index: number): unknown => {
      // Bounds check: return undefined for out-of-bounds indices
      // (including negative indices, for simplicity)
      const arr = readByPath(ctx.store, path)
      const len = Array.isArray(arr) ? arr.length : 0
      if (index < 0 || index >= len) return undefined

      if (!childCache.has(index)) {
        childCache.set(index, item(index))
      }
      return childCache.get(index)
    }

    Object.defineProperty(ref, "length", {
      get() {
        const arr = readByPath(ctx.store, path)
        return Array.isArray(arr) ? arr.length : 0
      },
      enumerable: false,
      configurable: true,
    })

    ;(ref as any)[Symbol.iterator] = function* () {
      const arr = readByPath(ctx.store, path)
      if (!Array.isArray(arr)) return
      for (let i = 0; i < arr.length; i++) {
        yield (ref as any).at(i)
      }
    }

    // Composability hook: mutation layer calls this to invalidate caches
    ref[INVALIDATE] = (key?: number) => {
      if (key !== undefined) {
        childCache.delete(key)
      } else {
        childCache.clear()
      }
    }

    return ref
  },

  // --- Map -------------------------------------------------------------------
  // Arrow function with Map-like methods attached as non-enumerable
  // properties via Object.defineProperty. No Proxy needed.
  //
  // .get(key) checks store existence before creating a child ref.
  // .has(), .keys(), .size, .entries(), .values(), [Symbol.iterator]
  // provide Map-like introspection. [INVALIDATE] retained for cache
  // coordination with the mutation layer.

  map(
    ctx: RefContext,
    path: Path,
    _schema: MapSchema,
    item: (key: string) => unknown,
  ): unknown {
    const childCache = new Map<string, unknown>()

    const ref: any = () => readByPath(ctx.store, path)

    // --- Helper: read store keys ---
    function storeKeys(): string[] {
      const obj = readByPath(ctx.store, path)
      return obj !== null && obj !== undefined && typeof obj === "object"
        ? Object.keys(obj as Record<string, unknown>)
        : []
    }

    // --- Map-like methods (all non-enumerable) ---

    Object.defineProperty(ref, "get", {
      value: (key: string): unknown => {
        const obj = readByPath(ctx.store, path)
        if (
          obj === null ||
          obj === undefined ||
          typeof obj !== "object" ||
          !(key in (obj as Record<string, unknown>))
        ) {
          return undefined
        }
        if (!childCache.has(key)) {
          childCache.set(key, item(key))
        }
        return childCache.get(key)
      },
      enumerable: false,
      configurable: true,
    })

    Object.defineProperty(ref, "has", {
      value: (key: string): boolean => {
        const obj = readByPath(ctx.store, path)
        return (
          obj !== null &&
          obj !== undefined &&
          typeof obj === "object" &&
          key in (obj as Record<string, unknown>)
        )
      },
      enumerable: false,
      configurable: true,
    })

    Object.defineProperty(ref, "keys", {
      value: (): string[] => storeKeys(),
      enumerable: false,
      configurable: true,
    })

    Object.defineProperty(ref, "size", {
      get(): number {
        return storeKeys().length
      },
      enumerable: false,
      configurable: true,
    })

    Object.defineProperty(ref, "entries", {
      value: function* (): IterableIterator<[string, unknown]> {
        for (const key of storeKeys()) {
          yield [key, ref.get(key)]
        }
      },
      enumerable: false,
      configurable: true,
    })

    Object.defineProperty(ref, "values", {
      value: function* (): IterableIterator<unknown> {
        for (const key of storeKeys()) {
          yield ref.get(key)
        }
      },
      enumerable: false,
      configurable: true,
    })

    Object.defineProperty(ref, Symbol.iterator, {
      value: function* (): IterableIterator<[string, unknown]> {
        for (const key of storeKeys()) {
          yield [key, ref.get(key)]
        }
      },
      enumerable: false,
      configurable: true,
    })

    // Composability hook: mutation layer calls this to invalidate caches
    ref[INVALIDATE] = (key?: string) => {
      if (key !== undefined) {
        childCache.delete(key)
      } else {
        childCache.clear()
      }
    }

    return ref
  },

  // --- Sum -------------------------------------------------------------------
  // Dispatches to the correct variant based on runtime store state.
  // Identical logic to writable sum — purely a read concern.

  sum(
    ctx: RefContext,
    path: Path,
    schema: SumSchema,
    variants: SumVariants<unknown>,
  ): unknown {
    if (schema.discriminant !== undefined && variants.byKey) {
      // ── Discriminated sum ────────────────────────────────────────
      const discSchema = schema as DiscriminatedSumSchema
      const value = readByPath(ctx.store, path)

      if (isNonNullObject(value)) {
        const discValue = value[schema.discriminant]
        if (
          typeof discValue === "string" &&
          discValue in discSchema.variantMap
        ) {
          return variants.byKey(discValue)
        }
      }

      // Fallback: first variant
      const keys = Object.keys(discSchema.variantMap)
      if (keys.length > 0) {
        return variants.byKey(keys[0]!)
      }
      return undefined
    }

    // ── Positional sum ───────────────────────────────────────────
    if (variants.byIndex) {
      const posSchema = schema as PositionalSumSchema

      if (isNullableSum(posSchema)) {
        const value = readByPath(ctx.store, path)
        return value === null || value === undefined
          ? variants.byIndex(0) // null variant
          : variants.byIndex(1) // inner variant
      }

      // General positional sum: no runtime discriminator, use first
      return variants.byIndex(0)
    }

    return undefined
  },

  // --- Annotated -------------------------------------------------------------
  // Dispatches on annotation tag for specialized read refs:
  // - "text"    → callable returning string, text-specific toPrimitive
  // - "counter" → callable returning number, hint-aware toPrimitive
  // - "doc", "movable", "tree" → delegate to inner
  // - unknown   → delegate to inner, or scalar-like ref

  annotated(
    ctx: RefContext,
    path: Path,
    schema: AnnotatedSchema,
    inner: (() => unknown) | undefined,
  ): unknown {
    switch (schema.tag) {
      case "text": {
        const ref: any = () => {
          const v = readByPath(ctx.store, path)
          return typeof v === "string" ? v : String(v ?? "")
        }
        ref[Symbol.toPrimitive] = (_hint: string) => ref()
        return ref
      }

      case "counter": {
        const ref: any = () => {
          const v = readByPath(ctx.store, path)
          return typeof v === "number" ? v : 0
        }
        ref[Symbol.toPrimitive] = (hint: string) => {
          const v = ref()
          return hint === "string" ? String(v) : v
        }
        return ref
      }

      case "doc":
      case "movable":
      case "tree":
        // These annotations wrap an inner schema — delegate
        if (inner !== undefined) {
          return inner()
        }
        return undefined

      default:
        // Unknown annotation — delegate to inner if present
        if (inner !== undefined) {
          return inner()
        }
        // Leaf annotation without known semantics — treat as scalar
        return readableInterpreter.scalar(ctx, path, {
          _kind: "scalar",
          scalarKind: "any" as any,
        })
    }
  },
}