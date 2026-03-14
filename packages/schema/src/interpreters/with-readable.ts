// withReadable — fills the CALL slot and adds structural navigation.
//
// This transformer takes any interpreter that produces HasCall carriers
// (i.e. bottomInterpreter or anything above it) and:
//
// 1. Fills the [CALL] slot:
//    - Leaf nodes (scalar, text, counter): `() => readByPath(store, path)`
//    - Composite nodes (product, sequence, map): folds child values through
//      the carrier's navigation surface to produce a fresh snapshot
// 2. Adds structural navigation:
//    - Product: enumerable lazy getters (NO caching — thunk forced every access)
//    - Sequence: .at(i), .get(i), .length, [Symbol.iterator]
//    - Map: .at(key), .get(key), .has(key), .keys(), .size,
//           .entries(), .values(), [Symbol.iterator]
// 3. Adds [Symbol.toPrimitive] for scalar/text/counter annotations
//
// Caching is NOT provided here — that's withCaching's job (Phase 3).
// This means `ref.title !== ref.title` (each access forces the thunk).
//
// See .plans/interpreter-decomposition.md §Phase 2.

import type { Interpreter, Path, SumVariants } from "../interpret.js"
import type {
  ScalarSchema,
  ProductSchema,
  SequenceSchema,
  MapSchema,
  SumSchema,
  AnnotatedSchema,
} from "../schema.js"
import { readByPath, dispatchSum } from "../store.js"
import { isNonNullObject } from "../guards.js"
import { CALL } from "./bottom.js"
import type { HasCall, HasNavigation } from "./bottom.js"
import type { RefContext } from "../interpreter-types.js"

// ---------------------------------------------------------------------------
// withReadable — the refinement transformer
// ---------------------------------------------------------------------------

/**
 * Transformer that fills the `[CALL]` slot and adds structural navigation.
 *
 * Takes an `Interpreter<RefContext, A extends HasCall>` and returns an
 * `Interpreter<RefContext, A & HasNavigation>`. The carrier identity is
 * preserved — `withReadable` mutates the carrier produced by the base
 * interpreter, it does not replace it.
 *
 * **No caching.** Product field access forces the thunk on every access.
 * Sequence/map `.at()` calls the item closure fresh each time. Use
 * `withCaching` to add identity-preserving memoization.
 *
 * ```ts
 * const readable = withReadable(bottomInterpreter)
 * const ctx: RefContext = { store: { title: "Hello" } }
 * const doc = interpret(schema, readable, ctx)
 * doc.title()  // "Hello"
 * doc.title !== doc.title  // true (no caching)
 * ```
 */
export function withReadable<A extends HasCall>(
  base: Interpreter<RefContext, A>,
): Interpreter<RefContext, A & HasNavigation> {
  return {
    // --- Scalar ---------------------------------------------------------------
    scalar(
      ctx: RefContext,
      path: Path,
      schema: ScalarSchema,
    ): A & HasNavigation {
      const result = base.scalar(ctx, path, schema) as any

      // Fill CALL slot
      result[CALL] = () => readByPath(ctx.store, path)

      // Hint-aware toPrimitive for template literal coercion
      result[Symbol.toPrimitive] = (hint: string) => {
        const v = readByPath(ctx.store, path)
        return hint === "string" ? String(v) : v
      }

      return result as A & HasNavigation
    },

    // --- Product ---------------------------------------------------------------
    product(
      ctx: RefContext,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => (A & HasNavigation)>>,
    ): A & HasNavigation {
      // Downcast thunks for the base interpreter
      const baseFields = fields as Readonly<Record<string, () => A>>
      const result = base.product(ctx, path, schema, baseFields) as any

      // Fill CALL slot — fold child values through the carrier's navigation
      // surface (property getters) to produce a fresh snapshot. This goes
      // through withCaching's memoized getters when present.
      result[CALL] = () => {
        const snapshot: Record<string, unknown> = {}
        for (const key of Object.keys(fields)) {
          const child = result[key]
          snapshot[key] = typeof child === "function" ? child() : child
        }
        return snapshot
      }

      // Define enumerable getters for each schema field.
      // NO caching — each access forces the thunk afresh.
      // withCaching (Phase 3) will wrap these with memoization.
      for (const key of Object.keys(fields)) {
        const thunk = fields[key]!
        Object.defineProperty(result, key, {
          get() {
            return thunk()
          },
          enumerable: true,
          configurable: true,
        })
      }

      return result as A & HasNavigation
    },

    // --- Sequence --------------------------------------------------------------
    sequence(
      ctx: RefContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => (A & HasNavigation),
    ): A & HasNavigation {
      // Downcast for base
      const baseItem = item as (index: number) => A
      const result = base.sequence(ctx, path, schema, baseItem) as any

      // Fill CALL slot — fold child values to produce a fresh array
      // snapshot. Uses the raw `item` closure (not result.at()) because
      // withCaching's cache shifting can leave refs with stale paths
      // after insert/delete. readByPath is still needed for structure
      // discovery (array length).
      result[CALL] = () => {
        const arr = readByPath(ctx.store, path)
        const len = Array.isArray(arr) ? arr.length : 0
        const snapshot: unknown[] = []
        for (let i = 0; i < len; i++) {
          const child: unknown = item(i)
          snapshot.push(typeof child === "function" ? (child as () => unknown)() : child)
        }
        return snapshot
      }

      // .at(i) — NO caching. Calls item(i) fresh each time.
      // Bounds checking: negative or out-of-bounds returns undefined.
      Object.defineProperty(result, "at", {
        value: (index: number): unknown => {
          const arr = readByPath(ctx.store, path)
          const len = Array.isArray(arr) ? arr.length : 0
          if (index < 0 || index >= len) return undefined
          return item(index)
        },
        enumerable: false,
        configurable: true,
      })

      // .get(i) — returns plain value (not a ref)
      Object.defineProperty(result, "get", {
        value: (index: number): unknown => {
          const child = result.at(index)
          return child !== undefined ? child() : undefined
        },
        enumerable: false,
        configurable: true,
      })

      // .length — live from store
      Object.defineProperty(result, "length", {
        get() {
          const arr = readByPath(ctx.store, path)
          return Array.isArray(arr) ? arr.length : 0
        },
        enumerable: false,
        configurable: true,
      })

      // [Symbol.iterator] — yields child refs
      result[Symbol.iterator] = function* () {
        const arr = readByPath(ctx.store, path)
        if (!Array.isArray(arr)) return
        for (let i = 0; i < arr.length; i++) {
          yield result.at(i)
        }
      }

      return result as A & HasNavigation
    },

    // --- Map -------------------------------------------------------------------
    map(
      ctx: RefContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => (A & HasNavigation),
    ): A & HasNavigation {
      // Downcast for base
      const baseItem = item as (key: string) => A
      const result = base.map(ctx, path, schema, baseItem) as any

      // Fill CALL slot — fold child values to produce a fresh record
      // snapshot. Uses the raw `item` closure (not result.at()) because
      // map keys can be dynamically added/removed and cached refs may
      // have stale state. readByPath is still needed for structure
      // discovery (object keys).
      result[CALL] = () => {
        const obj = readByPath(ctx.store, path)
        const keys = isNonNullObject(obj) ? Object.keys(obj) : []
        const snapshot: Record<string, unknown> = {}
        for (const key of keys) {
          const child: unknown = item(key)
          snapshot[key] = typeof child === "function" ? (child as () => unknown)() : child
        }
        return snapshot
      }

      // Helper: read store keys
      function storeKeys(): string[] {
        const obj = readByPath(ctx.store, path)
        return isNonNullObject(obj) ? Object.keys(obj) : []
      }

      // .at(key) — NO caching. Calls item(key) fresh each time.
      // Returns undefined for missing keys.
      Object.defineProperty(result, "at", {
        value: (key: string): unknown => {
          const obj = readByPath(ctx.store, path)
          if (!isNonNullObject(obj) || !(key in obj)) {
            return undefined
          }
          return item(key)
        },
        enumerable: false,
        configurable: true,
      })

      // .get(key) — returns plain value
      Object.defineProperty(result, "get", {
        value: (key: string): unknown => {
          const child = result.at(key)
          return child !== undefined ? child() : undefined
        },
        enumerable: false,
        configurable: true,
      })

      // .has(key)
      Object.defineProperty(result, "has", {
        value: (key: string): boolean => {
          const obj = readByPath(ctx.store, path)
          return isNonNullObject(obj) && key in obj
        },
        enumerable: false,
        configurable: true,
      })

      // .keys()
      Object.defineProperty(result, "keys", {
        value: (): string[] => storeKeys(),
        enumerable: false,
        configurable: true,
      })

      // .size
      Object.defineProperty(result, "size", {
        get(): number {
          return storeKeys().length
        },
        enumerable: false,
        configurable: true,
      })

      // .entries()
      Object.defineProperty(result, "entries", {
        value: function* (): IterableIterator<[string, unknown]> {
          for (const key of storeKeys()) {
            yield [key, result.at(key)]
          }
        },
        enumerable: false,
        configurable: true,
      })

      // .values()
      Object.defineProperty(result, "values", {
        value: function* (): IterableIterator<unknown> {
          for (const key of storeKeys()) {
            yield result.at(key)
          }
        },
        enumerable: false,
        configurable: true,
      })

      // [Symbol.iterator]
      Object.defineProperty(result, Symbol.iterator, {
        value: function* (): IterableIterator<[string, unknown]> {
          for (const key of storeKeys()) {
            yield [key, result.at(key)]
          }
        },
        enumerable: false,
        configurable: true,
      })

      return result as A & HasNavigation
    },

    // --- Sum -------------------------------------------------------------------
    sum(
      ctx: RefContext,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<A & HasNavigation>,
    ): A & HasNavigation {
      // Sum dispatch reads from the store to determine which variant.
      // The base interpreter's sum case is bypassed — we use dispatchSum
      // directly because the base (bottom) just returns a fresh carrier
      // that would be thrown away.
      const value = readByPath(ctx.store, path)
      const resolved = dispatchSum(value, schema, variants)
      if (resolved !== undefined) {
        return resolved
      }
      // Fallback: produce a bare carrier (shouldn't happen with valid schemas)
      const baseVariants = variants as SumVariants<A>
      return base.sum(ctx, path, schema, baseVariants) as A & HasNavigation
    },

    // --- Annotated -------------------------------------------------------------
    annotated(
      ctx: RefContext,
      path: Path,
      schema: AnnotatedSchema,
      inner: (() => (A & HasNavigation)) | undefined,
    ): A & HasNavigation {
      switch (schema.tag) {
        case "text": {
          // Text annotation: callable returning string, text-specific toPrimitive.
          // We call the base to get a carrier, then fill CALL.
          const baseInner = inner as (() => A) | undefined
          const result = base.annotated(ctx, path, schema, baseInner) as any

          result[CALL] = () => {
            const v = readByPath(ctx.store, path)
            return typeof v === "string" ? v : String(v ?? "")
          }
          result[Symbol.toPrimitive] = (_hint: string) => result[CALL]()
          return result as A & HasNavigation
        }

        case "counter": {
          // Counter annotation: callable returning number, hint-aware toPrimitive.
          const baseInner = inner as (() => A) | undefined
          const result = base.annotated(ctx, path, schema, baseInner) as any

          result[CALL] = () => {
            const v = readByPath(ctx.store, path)
            return typeof v === "number" ? v : 0
          }
          result[Symbol.toPrimitive] = (hint: string) => {
            const v = result[CALL]()
            return hint === "string" ? String(v) : v
          }
          return result as A & HasNavigation
        }

        case "doc":
        case "movable":
        case "tree":
          // Delegating annotations — inner was already interpreted.
          if (inner !== undefined) {
            return inner()
          }
          // No inner — produce a bare carrier
          return base.annotated(
            ctx, path, schema, undefined,
          ) as A & HasNavigation

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