// withNavigation — structural navigation (coalgebraic addressing).
//
// This transformer takes any interpreter that produces HasCall carriers
// (i.e. bottomInterpreter or anything above it) and adds structural
// navigation: product field getters, sequence .at()/.length/iterator,
// map .at()/.has()/.keys()/.size/.entries()/.values()/iterator, sum
// dispatch, and first-class type delegation.
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

import type { Interpreter, Path, SumVariants } from "../interpret.js"
import { dispatchSum } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import type {
  CounterSchema,
  MapSchema,
  MovableSequenceSchema,
  ProductSchema,
  RichTextSchema,
  ScalarSchema,
  SequenceSchema,
  SetSchema,
  SumSchema,
  TextSchema,
  TreeSchema,
} from "../schema.js"
import type { HasCall, HasNavigation } from "./bottom.js"
import { installKeyedNavigation } from "./keyed-helpers.js"
import { installSequenceNavigation } from "./sequence-helpers.js"

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
          const fieldPath = path.field(key)
          Object.defineProperty(result, key, {
            get() {
              return ctx.reader.read(fieldPath)
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
      const baseItem = item as (index: number) => A
      const result = base.sequence(ctx, path, schema, baseItem) as any
      installSequenceNavigation(result, ctx, path, item)
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
      const baseItem = item as (key: string) => A
      const result = base.map(ctx, path, schema, baseItem) as any
      installKeyedNavigation(result, ctx, path, item)
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
      const value = ctx.reader.read(path)
      const resolved = dispatchSum(value, schema, variants)
      if (resolved !== undefined) {
        return resolved
      }
      // Fallback: produce a bare carrier (shouldn't happen with valid schemas)
      const baseVariants = variants as SumVariants<A>
      return base.sum(ctx, path, schema, baseVariants) as A & HasNavigation
    },

    // --- Text ------------------------------------------------------------------
    // Leaf type — pass through to base. withReadable will fill [CALL]
    // and add toPrimitive later.
    text(ctx: RefContext, path: Path, schema: TextSchema): A & HasNavigation {
      return base.text(ctx, path, schema) as A & HasNavigation
    },

    // --- Counter ---------------------------------------------------------------
    // Leaf type — pass through to base. withReadable will fill [CALL]
    // and add toPrimitive later.
    counter(
      ctx: RefContext,
      path: Path,
      schema: CounterSchema,
    ): A & HasNavigation {
      return base.counter(ctx, path, schema) as A & HasNavigation
    },

    // --- Set -------------------------------------------------------------------
    // Delegate like map — set has the same structural addressing surface.
    set(
      ctx: RefContext,
      path: Path,
      schema: SetSchema,
      item: (key: string) => A & HasNavigation,
    ): A & HasNavigation {
      const baseItem = item as (key: string) => A
      const result = base.set(ctx, path, schema, baseItem) as any
      installKeyedNavigation(result, ctx, path, item)
      return result as A & HasNavigation
    },

    // --- Tree ------------------------------------------------------------------
    // Delegate via nodeData() — tree navigation surfaces the inner
    // product's fields. Like product delegation.
    tree(
      ctx: RefContext,
      path: Path,
      schema: TreeSchema,
      nodeData: () => A & HasNavigation,
    ): A & HasNavigation {
      const baseNodeData = nodeData as () => A
      const result = base.tree(ctx, path, schema, baseNodeData)
      // The nodeData thunk was already interpreted by the catamorphism
      // with the full interpreter stack, so the inner product already
      // has navigation installed. We just return the tree's carrier.
      return result as A & HasNavigation
    },

    // --- Movable ---------------------------------------------------------------
    // Delegate like sequence — movable has the same structural addressing.
    movable(
      ctx: RefContext,
      path: Path,
      schema: MovableSequenceSchema,
      item: (index: number) => A & HasNavigation,
    ): A & HasNavigation {
      const baseItem = item as (index: number) => A
      const result = base.movable(ctx, path, schema, baseItem) as any
      installSequenceNavigation(result, ctx, path, item)
      return result as A & HasNavigation
    },

    // --- RichText --------------------------------------------------------------
    // Leaf type — pass through to base. withReadable will fill [CALL]
    // and add toPrimitive later.
    richtext(
      ctx: RefContext,
      path: Path,
      schema: RichTextSchema,
    ): A & HasNavigation {
      return base.richtext(ctx, path, schema) as A & HasNavigation
    },
  }
}
