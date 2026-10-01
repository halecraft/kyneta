// withReadable — fills the CALL slot and adds value reading.
//
// This transformer takes any interpreter that produces HasNavigation
// carriers (i.e. withNavigation(bottomInterpreter) or anything above
// it) and:
//
// 1. Fills every kind's [CALL] slot with `readAt`: σ's own value at the path,
//    frozen in place, on a writable stack, and a completed, frozen copy on a
//    read-only one. A composite's read is its σ value whole; it never
//    navigates to its children, so it builds no refs.
// 2. Adds .get() convenience methods, which read one child's value from the
//    parent's, again without building a ref:
//    - Sequence: .get(i)
//    - Map: .get(key)
// 3. Adds [Symbol.toPrimitive] for scalar/text/counter/richtext
//
// Navigation (product field getters, .at(), .length, .keys(), etc.) is
// NOT provided here — that's withNavigation's job. withReadable assumes
// navigation is already in place and builds on top of it.

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
  Schema as SchemaNode,
  SequenceSchema,
  SetSchema,
  SumSchema,
  TextSchema,
  TreeSchema,
} from "../schema.js"
import type { HasNavigation, HasRead } from "./bottom.js"
import { CALL, markRead } from "./bottom.js"
import { installKeyedReadable } from "./keyed-helpers.js"
import { readAt, valueAt } from "./read-at.js"
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
 * ```ts
 * const nav = withNavigation(bottomInterpreter)
 * const readable = withReadable(nav)
 * const ctx: RefContext = { reader: plainReader({ current: { title: "Hello" } }) }
 * const doc = interpret(schema, readable, ctx)
 * doc.title()  // "Hello"
 * ```
 */
export function withReadable<A extends HasNavigation>(
  base: Interpreter<RefContext, A>,
): Interpreter<RefContext, A & HasRead> {
  /** `carrier` with `[CALL]` reading the value at `path`. */
  const readable = <C extends object>(
    carrier: C,
    ctx: RefContext,
    path: Path,
    schema: SchemaNode,
  ): C & { [CALL]: () => unknown } =>
    Object.assign(carrier, { [CALL]: () => readAt(ctx, path, schema) })

  return {
    [INTERPRETER]: true,
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

    // --- Scalar ---------------------------------------------------------------
    scalar(ctx: RefContext, path: Path, schema: ScalarSchema): A & HasRead {
      const carrier = readable(
        base.scalar(ctx, path, schema),
        ctx,
        path,
        schema,
      )
      const result = Object.assign(carrier, {
        // Hint-aware toPrimitive for template literal coercion
        [Symbol.toPrimitive]: (hint: string) => {
          const v = valueAt(ctx, path)
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
      const baseFields = fields as Readonly<Record<string, () => A>>
      const result = readable(
        base.product(ctx, path, schema, baseFields),
        ctx,
        path,
        schema,
      )
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
      const result = readable(
        base.sequence(ctx, path, schema, baseItem),
        ctx,
        path,
        schema,
      )
      installSequenceReadable(result, ctx, path, schema.item)
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
      const result = readable(
        base.map(ctx, path, schema, baseItem),
        ctx,
        path,
        schema,
      )
      installKeyedReadable(result, ctx, path, schema.item)
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
    text(ctx: RefContext, path: Path, schema: TextSchema): A & HasRead {
      const carrier = readable(base.text(ctx, path, schema), ctx, path, schema)
      const result = Object.assign(carrier, {
        [Symbol.toPrimitive]: (_hint: string): string => {
          const v = valueAt(ctx, path)
          return typeof v === "string" ? v : String(v ?? "")
        },
      })
      markRead(result)
      return result
    },

    // --- Counter ---------------------------------------------------------------
    counter(ctx: RefContext, path: Path, schema: CounterSchema): A & HasRead {
      const carrier = readable(
        base.counter(ctx, path, schema),
        ctx,
        path,
        schema,
      )
      const result = Object.assign(carrier, {
        [Symbol.toPrimitive]: (hint: string) => {
          const v = valueAt(ctx, path)
          const n = typeof v === "number" ? v : 0
          return hint === "string" ? String(n) : n
        },
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
      const result = readable(
        base.set(ctx, path, schema, baseItem),
        ctx,
        path,
        schema,
      )
      installSetReadable(result)
      markRead(result)
      return result
    },

    // --- Tree ------------------------------------------------------------------
    // `()` is the flat forest σ holds. `.roots` and iteration nest it, with
    // each node's `data` a ref.
    tree(
      ctx: RefContext,
      path: Path,
      schema: TreeSchema,
      nodes: () => readonly FlatTreeNode<A & HasRead>[],
      node: (id: string) => A & HasRead,
    ): A & HasRead {
      const baseNodes = nodes as unknown as () => readonly FlatTreeNode<A>[]
      const baseNode = node as unknown as (id: string) => A
      const result = readable(
        base.tree(ctx, path, schema, baseNodes, baseNode),
        ctx,
        path,
        schema,
      )
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
      const result = readable(
        base.movable(ctx, path, schema, baseItem),
        ctx,
        path,
        schema,
      )
      installSequenceReadable(result, ctx, path, schema.item)
      markRead(result)
      return result
    },

    // --- RichText --------------------------------------------------------------
    richtext(ctx: RefContext, path: Path, schema: RichTextSchema): A & HasRead {
      const carrier = readable(
        base.richtext(ctx, path, schema),
        ctx,
        path,
        schema,
      )
      const result = Object.assign(carrier, {
        [Symbol.toPrimitive]: (_hint: string) => {
          const v = valueAt(ctx, path)
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
