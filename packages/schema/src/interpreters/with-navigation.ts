// withNavigation — structural navigation (coalgebraic addressing).
//
// This transformer takes any interpreter that produces HasCall carriers
// (i.e. bottomInterpreter or anything above it) and adds structural
// navigation: product field getters, sequence .at()/.length/iterator,
// map .at()/.has()/.keys()/.size/.entries()/.values()/iterator, sum
// dispatch, and annotated delegation.
//
// Navigation is a coalgebra: A → F(A) — revealing addressable child
// positions within a composite. It says "give me a handle to the child
// at position X" without reading any values.
//
// Reading (filling the [CALL] slot) is NOT provided here — that's
// withReadable's job. This means ref() still throws after withNavigation
// alone; you need withReadable to make carriers callable.
//
// See .plans/navigation-layer.md §Phase 2, Task 2.1.

import { dispatchSum } from "../interpret.js"
import type { Interpreter, Path, SumVariants } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import type {
  AnnotatedSchema,
  MapSchema,
  ProductSchema,
  ScalarSchema,
  SequenceSchema,
  SumSchema,
} from "../schema.js"
import type { HasCall, HasNavigation } from "./bottom.js"

// ---------------------------------------------------------------------------
// withNavigation — the coalgebraic structural addressing transformer
// ---------------------------------------------------------------------------

/**
 * Transformer that adds structural navigation to carriers.
 *
 * Takes an `Interpreter<RefContext, A extends HasCall>` and returns an
 * `Interpreter<RefContext, A & HasNavigation>`. The carrier identity is
 * preserved — `withNavigation` mutates the carrier produced by the base
 * interpreter, it does not replace it.
 *
 * **No reading.** The `[CALL]` slot is NOT filled — calling the carrier
 * still throws. Use `withReadable` after `withNavigation` to enable
 * reading.
 *
 * **No caching.** Product field access forces the thunk on every access.
 * Sequence/map `.at()` calls the item closure fresh each time. Use
 * `withCaching` to add identity-preserving memoization.
 *
 * ```ts
 * const nav = withNavigation(bottomInterpreter)
 * const ctx: RefContext = { store: { title: "Hello" } }
 * const doc = interpret(schema, nav, ctx)
 * doc.title       // a carrier (calling it throws — no reader)
 * doc.title !== doc.title  // true (no caching)
 * ```
 */
export function withNavigation<A extends HasCall>(
  base: Interpreter<RefContext, A>,
): Interpreter<RefContext, A & HasNavigation> {
  return {
    // --- Scalar ---------------------------------------------------------------
    // No navigation needed for scalars — pass through.
    scalar(
      ctx: RefContext,
      path: Path,
      schema: ScalarSchema,
    ): A & HasNavigation {
      return base.scalar(ctx, path, schema) as A & HasNavigation
    },

    // --- Product ---------------------------------------------------------------
    // Add enumerable lazy getters for each schema field.
    product(
      ctx: RefContext,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => A & HasNavigation>>,
    ): A & HasNavigation {
      // Downcast thunks for the base interpreter
      const baseFields = fields as Readonly<Record<string, () => A>>
      const result = base.product(ctx, path, schema, baseFields) as any

      // Define enumerable getters for each schema field.
      // NO caching — each access forces the thunk afresh.
      // withCaching will wrap these with memoization.
      const discKey = schema.discriminantKey
      for (const key of Object.keys(fields)) {
        if (key === discKey) {
          // Discriminant field: return raw store value, not a ref.
          // This enables standard TS discriminated union narrowing
          // (ref.type === "text") and prevents discriminant mutation.
          const fieldPath: Path = [...path, { type: "key", key }]
          Object.defineProperty(result, key, {
            get() {
              return ctx.store.read(fieldPath)
            },
            enumerable: true,
            configurable: true,
          })
        } else {
          const thunk = fields[key]!
          Object.defineProperty(result, key, {
            get() {
              return thunk()
            },
            enumerable: true,
            configurable: true,
          })
        }
      }

      return result as A & HasNavigation
    },

    // --- Sequence --------------------------------------------------------------
    // Add .at(i), .length, [Symbol.iterator].
    sequence(
      ctx: RefContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A & HasNavigation,
    ): A & HasNavigation {
      // Downcast for base
      const baseItem = item as (index: number) => A
      const result = base.sequence(ctx, path, schema, baseItem) as any

      // .at(i) — NO caching. Calls item(i) fresh each time.
      // Bounds checking: negative or out-of-bounds returns undefined.
      Object.defineProperty(result, "at", {
        value: (index: number): unknown => {
          const len = ctx.store.arrayLength(path)
          if (index < 0 || index >= len) return undefined
          return item(index)
        },
        enumerable: false,
        configurable: true,
      })

      // .length — live from store
      Object.defineProperty(result, "length", {
        get() {
          return ctx.store.arrayLength(path)
        },
        enumerable: false,
        configurable: true,
      })

      // [Symbol.iterator] — yields child refs
      result[Symbol.iterator] = function* () {
        const len = ctx.store.arrayLength(path)
        for (let i = 0; i < len; i++) {
          yield result.at(i)
        }
      }

      return result as A & HasNavigation
    },

    // --- Map -------------------------------------------------------------------
    // Add .at(key), .has(key), .keys(), .size, .entries(), .values(),
    // [Symbol.iterator].
    map(
      ctx: RefContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A & HasNavigation,
    ): A & HasNavigation {
      // Downcast for base
      const baseItem = item as (key: string) => A
      const result = base.map(ctx, path, schema, baseItem) as any

      // .at(key) — NO caching. Calls item(key) fresh each time.
      // Returns undefined for missing keys.
      Object.defineProperty(result, "at", {
        value: (key: string): unknown => {
          if (!ctx.store.hasKey(path, key)) {
            return undefined
          }
          return item(key)
        },
        enumerable: false,
        configurable: true,
      })

      // .has(key)
      Object.defineProperty(result, "has", {
        value: (key: string): boolean => {
          return ctx.store.hasKey(path, key)
        },
        enumerable: false,
        configurable: true,
      })

      // .keys()
      Object.defineProperty(result, "keys", {
        value: (): string[] => ctx.store.keys(path),
        enumerable: false,
        configurable: true,
      })

      // .size
      Object.defineProperty(result, "size", {
        get(): number {
          return ctx.store.keys(path).length
        },
        enumerable: false,
        configurable: true,
      })

      // .entries()
      Object.defineProperty(result, "entries", {
        value: function* (): IterableIterator<[string, unknown]> {
          for (const key of ctx.store.keys(path)) {
            yield [key, result.at(key)]
          }
        },
        enumerable: false,
        configurable: true,
      })

      // .values()
      Object.defineProperty(result, "values", {
        value: function* (): IterableIterator<unknown> {
          for (const key of ctx.store.keys(path)) {
            yield result.at(key)
          }
        },
        enumerable: false,
        configurable: true,
      })

      // [Symbol.iterator]
      Object.defineProperty(result, Symbol.iterator, {
        value: function* (): IterableIterator<[string, unknown]> {
          for (const key of ctx.store.keys(path)) {
            yield [key, result.at(key)]
          }
        },
        enumerable: false,
        configurable: true,
      })

      return result as A & HasNavigation
    },

    // --- Sum -------------------------------------------------------------------
    // Sum dispatch reads from the store to determine which variant.
    // This is structural addressing — "which child position is active?"
    sum(
      ctx: RefContext,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<A & HasNavigation>,
    ): A & HasNavigation {
      const value = ctx.store.read(path)
      const resolved = dispatchSum(value, schema, variants)
      if (resolved !== undefined) {
        return resolved
      }
      // Fallback: produce a bare carrier (shouldn't happen with valid schemas)
      const baseVariants = variants as SumVariants<A>
      return base.sum(ctx, path, schema, baseVariants) as A & HasNavigation
    },

    // --- Annotated -------------------------------------------------------------
    // Delegating annotations (doc, movable, tree) pass through to inner.
    // Leaf annotations without known semantics delegate to scalar.
    // Text/counter annotations pass through — reading is withReadable's job.
    annotated(
      ctx: RefContext,
      path: Path,
      schema: AnnotatedSchema,
      inner: (() => A & HasNavigation) | undefined,
    ): A & HasNavigation {
      switch (schema.tag) {
        case "text":
        case "counter":
          // Leaf annotations — pass through to base. withReadable will
          // fill [CALL] and add toPrimitive later.
          return base.annotated(
            ctx,
            path,
            schema,
            inner as (() => A) | undefined,
          ) as A & HasNavigation

        case "doc":
        case "movable":
        case "tree":
          // Delegating annotations — inner was already interpreted.
          if (inner !== undefined) {
            return inner()
          }
          // No inner — produce a bare carrier
          return base.annotated(ctx, path, schema, undefined) as A &
            HasNavigation

        default:
          // Unknown annotation — delegate to inner if present
          if (inner !== undefined) {
            return inner()
          }
          // Leaf annotation without known semantics — treat as scalar
          return this.scalar(ctx, path, {
            _kind: "scalar" as const,
            scalarKind: "any" as any,
          })
      }
    },
  }
}
