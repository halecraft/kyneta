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

import type {
  FlatTreeNode,
  Interpreter,
  Path,
  SumVariants,
} from "../interpret.js"
import { INTERPRETER, type RefContext } from "../interpreter-types.js"
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

import type { HasNavigation, HasRead } from "./bottom.js"
import { CALL, markRead } from "./bottom.js"
import { installKeyedReadable } from "./keyed-helpers.js"
import { installSequenceReadable } from "./sequence-helpers.js"
import { installSetReadable } from "./set-helpers.js"
import { installTreeReadable } from "./tree-helpers.js"

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
    [INTERPRETER]: true,
    // --- Scalar ---------------------------------------------------------------
    // ---------------------------------------------------------------------
    // Each case takes the carrier the layer below produced, adds members, and
    // returns it. `Object.assign` is what types that: its signature is
    // `<T, U>(target: T, source: U): T & U`, which is exactly "a `T`, plus
    // these members, still a `T`". Assigning to a property of a value typed as
    // the parameter `A` is a type error — `A` might have that member at
    // another type — which is why these used to open with `as any`.
    //
    // `markRead` at the end of each case is irreducible and small. `HasRead`
    // is a *phantom brand*: a symbol declared but never assigned at runtime,
    // marking "this carrier's `[CALL]` returns a real value". Nothing
    // structural can produce it, so claiming it is precisely what an assertion
    // is for. Everything before that line is now checked.
    // ---------------------------------------------------------------------
    scalar(ctx: RefContext, path: Path, schema: ScalarSchema): A & HasRead {
      const result = Object.assign(base.scalar(ctx, path, schema), {
        [CALL]: () => ctx.reader.read(path),
        // Hint-aware toPrimitive for template literal coercion
        [Symbol.toPrimitive]: (hint: string) => {
          const v = ctx.reader.read(path)
          return hint === "string" ? String(v) : v
        },
      })

      markRead(result)
      return result
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
      const carrier = base.product(ctx, path, schema, baseFields)
      // The product's fields are read back by name, and those names come from
      // the schema rather than the type — so this view is genuinely untyped,
      // and says only that much.
      const byFieldName = carrier as Record<string, unknown>

      const result = Object.assign(carrier, {
        // Fill CALL slot — fold child values through the carrier's navigation
        // surface (property getters) to produce a fresh snapshot. This goes
        // through withCaching's memoized getters when present.
        [CALL]: () => {
          const snapshot: Record<string, unknown> = {}
          for (const key of Object.keys(fields)) {
            const child = byFieldName[key]
            snapshot[key] = typeof child === "function" ? child() : child
          }
          return snapshot
        },
      })

      markRead(result)
      return result
    },

    // --- Sequence --------------------------------------------------------------
    sequence(
      ctx: RefContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A & HasRead,
    ): A & HasRead {
      const baseItem = item as (index: number) => A
      const result = base.sequence(ctx, path, schema, baseItem)
      installSequenceReadable(result, ctx, path)
      markRead(result)
      return result
    },

    // --- Map -------------------------------------------------------------------
    map(
      ctx: RefContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A & HasRead,
    ): A & HasRead {
      const baseItem = item as (key: string) => A
      const result = base.map(ctx, path, schema, baseItem)
      installKeyedReadable(result, ctx, path)
      markRead(result)
      return result
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
      const read = (): string => {
        const v = ctx.reader.read(path)
        return typeof v === "string" ? v : String(v ?? "")
      }
      const result = Object.assign(base.text(ctx, path, schema), {
        [CALL]: read,
        [Symbol.toPrimitive]: (_hint: string) => read(),
      })
      markRead(result)
      return result
    },

    // --- Counter ---------------------------------------------------------------
    // Counter: callable returning number, hint-aware toPrimitive.
    counter(ctx: RefContext, path: Path, schema: CounterSchema): A & HasRead {
      const read = (): number => {
        const v = ctx.reader.read(path)
        return typeof v === "number" ? v : 0
      }
      const result = Object.assign(base.counter(ctx, path, schema), {
        [CALL]: read,
        [Symbol.toPrimitive]: (hint: string) =>
          hint === "string" ? String(read()) : read(),
      })
      markRead(result)
      return result
    },

    // --- Set -------------------------------------------------------------------
    // Sets are leaf-shaped: `()` returns the plain array, `.has(value)`
    // is content-equal membership, `.size` and `[Symbol.iterator]` over
    // plain values. No `.at(value)`, no per-member child refs.
    set(
      ctx: RefContext,
      path: Path,
      schema: SetSchema,
      item: (key: string) => A & HasRead,
    ): A & HasRead {
      const baseItem = item as (key: string) => A
      const result = base.set(ctx, path, schema, baseItem)
      installSetReadable(result, ctx, path)
      markRead(result)
      return result
    },

    // --- Tree ------------------------------------------------------------------
    // Wire the recursive read surface (`ReadableTreeRef`): `.roots`,
    // `.node(id)`, callable snapshot `()`, depth-first iteration.
    tree(
      ctx: RefContext,
      path: Path,
      schema: TreeSchema,
      nodes: () => readonly FlatTreeNode<A & HasRead>[],
      node: (id: string) => A & HasRead,
    ): A & HasRead {
      const baseNodes = nodes as unknown as () => readonly FlatTreeNode<A>[]
      const baseNode = node as unknown as (id: string) => A
      const result = base.tree(ctx, path, schema, baseNodes, baseNode)
      installTreeReadable(result, ctx, path, node)
      markRead(result)
      return result
    },

    // --- Movable ---------------------------------------------------------------
    movable(
      ctx: RefContext,
      path: Path,
      schema: MovableSequenceSchema,
      item: (index: number) => A & HasRead,
    ): A & HasRead {
      const baseItem = item as (index: number) => A
      const result = base.movable(ctx, path, schema, baseItem)
      installSequenceReadable(result, ctx, path)
      markRead(result)
      return result
    },

    // --- RichText --------------------------------------------------------------
    // RichText: callable returning string, text-specific toPrimitive.
    richtext(ctx: RefContext, path: Path, schema: RichTextSchema): A & HasRead {
      const result = Object.assign(base.richtext(ctx, path, schema), {
        [CALL]: () => ctx.reader.read(path),
        [Symbol.toPrimitive]: (_hint: string) => {
          const v = ctx.reader.read(path)
          if (Array.isArray(v)) {
            return (v as Array<{ text: string }>).map(s => s.text).join("")
          }
          return ""
        },
      })
      markRead(result)
      return result
    },
  }
}
