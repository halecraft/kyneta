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
// 3. Adds [Symbol.toPrimitive] for scalar/text/counter
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
import type { RefContext } from "../interpreter-types.js"
import type {
  CounterSchema,
  MapSchema,
  MovableSequenceSchema,
  ProductSchema,
  ScalarSchema,
  SequenceSchema,
  SetSchema,
  SumSchema,
  TextSchema,
  TreeSchema,
} from "../schema.js"

import type { HasNavigation, HasRead } from "./bottom.js"
import { CALL } from "./bottom.js"
import { wireSequenceReadable } from "./sequence-helpers.js"
import { wireKeyedReadable } from "./keyed-helpers.js"

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
    scalar(ctx: RefContext, path: Path, schema: ScalarSchema): A & HasRead {
      const result = base.scalar(ctx, path, schema) as any

      // Fill CALL slot
      result[CALL] = () => ctx.reader.read(path)

      // Hint-aware toPrimitive for template literal coercion
      result[Symbol.toPrimitive] = (hint: string) => {
        const v = ctx.reader.read(path)
        return hint === "string" ? String(v) : v
      }

      return result as A & HasRead
    },

    // --- Product ---------------------------------------------------------------
    product(
      ctx: RefContext,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => A & HasRead>>,
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
      item: (index: number) => A & HasRead,
    ): A & HasRead {
      const baseItem = item as (index: number) => A
      const result = base.sequence(ctx, path, schema, baseItem) as any
      wireSequenceReadable(result, ctx, path)
      return result as A & HasRead
    },

    // --- Map -------------------------------------------------------------------
    map(
      ctx: RefContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A & HasRead,
    ): A & HasRead {
      const baseItem = item as (key: string) => A
      const result = base.map(ctx, path, schema, baseItem) as any
      wireKeyedReadable(result, ctx, path)
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

    // --- Text ------------------------------------------------------------------
    // Text: callable returning string, text-specific toPrimitive.
    text(ctx: RefContext, path: Path, schema: TextSchema): A & HasRead {
      const result = base.text(ctx, path, schema) as any

      result[CALL] = () => {
        const v = ctx.reader.read(path)
        return typeof v === "string" ? v : String(v ?? "")
      }
      result[Symbol.toPrimitive] = (_hint: string) => result[CALL]()
      return result as A & HasRead
    },

    // --- Counter ---------------------------------------------------------------
    // Counter: callable returning number, hint-aware toPrimitive.
    counter(ctx: RefContext, path: Path, schema: CounterSchema): A & HasRead {
      const result = base.counter(ctx, path, schema) as any

      result[CALL] = () => {
        const v = ctx.reader.read(path)
        return typeof v === "number" ? v : 0
      }
      result[Symbol.toPrimitive] = (hint: string) => {
        const v = result[CALL]()
        return hint === "string" ? String(v) : v
      }
      return result as A & HasRead
    },

    // --- Set -------------------------------------------------------------------
    set(
      ctx: RefContext,
      path: Path,
      schema: SetSchema,
      item: (key: string) => A & HasRead,
    ): A & HasRead {
      const baseItem = item as (key: string) => A
      const result = base.set(ctx, path, schema, baseItem) as any
      wireKeyedReadable(result, ctx, path)
      return result as A & HasRead
    },

    // --- Tree ------------------------------------------------------------------
    // Delegate via nodeData() — the inner interpretation already has
    // reading installed.
    tree(
      ctx: RefContext,
      path: Path,
      schema: TreeSchema,
      nodeData: () => A & HasRead,
    ): A & HasRead {
      const baseNodeData = nodeData as () => A
      return base.tree(ctx, path, schema, baseNodeData) as A & HasRead
    },

    // --- Movable ---------------------------------------------------------------
    movable(
      ctx: RefContext,
      path: Path,
      schema: MovableSequenceSchema,
      item: (index: number) => A & HasRead,
    ): A & HasRead {
      const baseItem = item as (index: number) => A
      const result = base.movable(ctx, path, schema, baseItem) as any
      wireSequenceReadable(result, ctx, path)
      return result as A & HasRead
    },
  }
}
