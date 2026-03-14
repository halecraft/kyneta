// withReadable — fills the CALL slot and adds value reading.
//
// This transformer takes any interpreter that produces HasNavigation
// carriers (i.e. withNavigation(bottomInterpreter) or anything above
// it) and:
//
// 1. Fills the [CALL] slot:
//    - Leaf nodes (scalar, text, counter): `() => readByPath(store, path)`
//    - Composite nodes (product, sequence, map): folds child values through
//      the carrier's navigation surface to produce a fresh snapshot
// 2. Adds .get() convenience methods:
//    - Sequence: .get(i) returns plain value (equivalent to .at(i)?.())
//    - Map: .get(key) returns plain value (equivalent to .at(key)?.())
// 3. Adds [Symbol.toPrimitive] for scalar/text/counter annotations
//
// Navigation (product field getters, .at(), .length, .keys(), etc.) is
// NOT provided here — that's withNavigation's job. withReadable assumes
// navigation is already in place and builds on top of it.
//
// Caching is NOT provided here — that's withCaching's job.
// This means `ref.title !== ref.title` (each access forces the thunk).
//
// See .plans/navigation-layer.md §Phase 2, Task 2.2.

import type { Interpreter, Path, SumVariants } from "../interpret.js"
import type {
  ScalarSchema,
  ProductSchema,
  SequenceSchema,
  MapSchema,
  SumSchema,
  AnnotatedSchema,
} from "../schema.js"
import { readByPath, storeArrayLength, storeKeys } from "../store.js"
import { CALL } from "./bottom.js"
import type { HasNavigation, HasRead } from "./bottom.js"
import type { RefContext } from "../interpreter-types.js"

// ---------------------------------------------------------------------------
// withReadable — the reading transformer
// ---------------------------------------------------------------------------

/**
 * Transformer that fills the `[CALL]` slot so carriers return values.
 *
 * Takes an `Interpreter<RefContext, A extends HasNavigation>` and returns
 * an `Interpreter<RefContext, A & HasRead>`. The carrier identity is
 * preserved — `withReadable` mutates the carrier produced by the base
 * interpreter, it does not replace it.
 *
 * **Requires navigation.** Product field getters, `.at()`, `.length`,
 * `.keys()` etc. must already be installed by `withNavigation`. This
 * transformer adds only reading concerns on top.
 *
 * **No caching.** Product field access forces the thunk on every access.
 * Sequence/map `.at()` calls the item closure fresh each time. Use
 * `withCaching` to add identity-preserving memoization.
 *
 * ```ts
 * const nav = withNavigation(bottomInterpreter)
 * const readable = withReadable(nav)
 * const ctx: RefContext = { store: { title: "Hello" } }
 * const doc = interpret(schema, readable, ctx)
 * doc.title()  // "Hello"
 * ```
 */
export function withReadable<A extends HasNavigation>(
  base: Interpreter<RefContext, A>,
): Interpreter<RefContext, A & HasRead> {
  return {
    // --- Scalar ---------------------------------------------------------------
    scalar(
      ctx: RefContext,
      path: Path,
      schema: ScalarSchema,
    ): A & HasRead {
      const result = base.scalar(ctx, path, schema) as any

      // Fill CALL slot
      result[CALL] = () => readByPath(ctx.store, path)

      // Hint-aware toPrimitive for template literal coercion
      result[Symbol.toPrimitive] = (hint: string) => {
        const v = readByPath(ctx.store, path)
        return hint === "string" ? String(v) : v
      }

      return result as A & HasRead
    },

    // --- Product ---------------------------------------------------------------
    product(
      ctx: RefContext,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => (A & HasRead)>>,
    ): A & HasRead {
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

      return result as A & HasRead
    },

    // --- Sequence --------------------------------------------------------------
    sequence(
      ctx: RefContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => (A & HasRead),
    ): A & HasRead {
      // Downcast for base
      const baseItem = item as (index: number) => A
      const result = base.sequence(ctx, path, schema, baseItem) as any

      // Fill CALL slot — fold child values to produce a fresh array
      // snapshot. Uses the raw `item` closure (not result.at()) because
      // withCaching's cache shifting can leave refs with stale paths
      // after insert/delete. readByPath is still needed for structure
      // discovery (array length).
      result[CALL] = () => {
        const len = storeArrayLength(ctx.store, path)
        const snapshot: unknown[] = []
        for (let i = 0; i < len; i++) {
          const child: unknown = item(i)
          snapshot.push(typeof child === "function" ? (child as () => unknown)() : child)
        }
        return snapshot
      }

      // .get(i) — returns plain value (not a ref)
      Object.defineProperty(result, "get", {
        value: (index: number): unknown => {
          const child = result.at(index)
          return child !== undefined ? child() : undefined
        },
        enumerable: false,
        configurable: true,
      })

      return result as A & HasRead
    },

    // --- Map -------------------------------------------------------------------
    map(
      ctx: RefContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => (A & HasRead),
    ): A & HasRead {
      // Downcast for base
      const baseItem = item as (key: string) => A
      const result = base.map(ctx, path, schema, baseItem) as any

      // Fill CALL slot — fold child values to produce a fresh record
      // snapshot. Uses the raw `item` closure (not result.at()) because
      // map keys can be dynamically added/removed and cached refs may
      // have stale state.
      result[CALL] = () => {
        const keys = storeKeys(ctx.store, path)
        const snapshot: Record<string, unknown> = {}
        for (const key of keys) {
          const child: unknown = item(key)
          snapshot[key] = typeof child === "function" ? (child as () => unknown)() : child
        }
        return snapshot
      }

      // .get(key) — returns plain value
      Object.defineProperty(result, "get", {
        value: (key: string): unknown => {
          const child = result.at(key)
          return child !== undefined ? child() : undefined
        },
        enumerable: false,
        configurable: true,
      })

      return result as A & HasRead
    },

    // --- Sum -------------------------------------------------------------------
    // Pass through — dispatch already handled by withNavigation.
    sum(
      ctx: RefContext,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<A & HasRead>,
    ): A & HasRead {
      const baseVariants = variants as SumVariants<A>
      return base.sum(ctx, path, schema, baseVariants) as A & HasRead
    },

    // --- Annotated -------------------------------------------------------------
    annotated(
      ctx: RefContext,
      path: Path,
      schema: AnnotatedSchema,
      inner: (() => (A & HasRead)) | undefined,
    ): A & HasRead {
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
          return result as A & HasRead
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
          return result as A & HasRead
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
          ) as A & HasRead

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