// Ref<S> — unified recursive type for fully-composed interpreter refs.
//
// Ref<S> combines navigation, reading, writing, and HasTransact into a
// single recursive conditional type. It replaces the unsound
// `Readable<S> & Writable<S>` intersection by giving each schema node
// a precise type where `.at()` returns `Ref<Child>` (not separate
// `Readable<Child>` / `Writable<Child>` with conflicting `.at()` types).
//
// Key design points:
//   - Children are `Ref<Child>`, not `Readable<Child>` or `Writable<Child>`
//   - Sequences use `ReadableSequenceRef<Ref<I>, Plain<I>> & SequenceRef`
//     — navigation + reading from ReadableSequenceRef, mutation from
//     SequenceRef (which has no `.at()`, so no overload conflict)
//   - Maps use `ReadableMapRef<Ref<I>, Plain<I>> & WritableMapRef<Plain<I>>`
//   - `WithTransact<T>` wraps every node (matches runtime `attachTransact`)
//   - HasTransact is included at every level so `ref[TRANSACT]` works
//
// See .plans/navigation-layer.md §Phase 3, Task 3.3.

import type {
  Schema,
  ScalarSchema,
  ProductSchema,
  SequenceSchema,
  MapSchema,
  AnnotatedSchema,
  PositionalSumSchema,
  DiscriminatedSumSchema,
} from "./schema.js"
import type { Plain } from "./interpreter-types.js"
import type { ReadableSequenceRef, ReadableMapRef } from "./interpreters/readable.js"
import type {
  HasTransact,
  ScalarRef,
  TextRef,
  CounterRef,
  SequenceRef,
  ProductRef,
  WritableMapRef,
} from "./interpreters/writable.js"

// ---------------------------------------------------------------------------
// WithTransact helper — single edit point for cross-cutting concerns
// ---------------------------------------------------------------------------

/**
 * Intersects `T` with `HasTransact`. Every node in a fully-composed
 * interpreter stack carries `[TRANSACT]` pointing at its `WritableContext`.
 *
 * This helper provides a single edit point if additional cross-cutting
 * concerns (e.g. `HasChangefeed`) need to be woven in later.
 */
export type WithTransact<T> = T & HasTransact

// ---------------------------------------------------------------------------
// Ref<S> — the unified recursive type
// ---------------------------------------------------------------------------

/**
 * Computes the fully-composed ref type for a given schema type.
 *
 * This is the user-facing type for refs produced by the full interpreter
 * stack (`withWritable(withChangefeed(withCaching(withReadable(
 * withNavigation(bottomInterpreter)))))`). Every node is:
 *   - Callable (reading: `ref()` → `Plain<S>`)
 *   - Navigable (`.at()` returns `Ref<Child>` for collections)
 *   - Writable (`.set()`, `.push()`, `.insert()`, `.delete()`, etc.)
 *   - Transactable (`ref[TRANSACT]` → `WritableContext`)
 *
 * ```ts
 * const s = Schema.doc({
 *   title: LoroSchema.text(),
 *   items: Schema.list(Schema.struct({
 *     name: Schema.string(),
 *   })),
 * })
 *
 * type Doc = Ref<typeof s>
 * // doc()           → { title: string, items: { name: string }[] }
 * // doc.title()     → string
 * // doc.title.insert(0, "hi")
 * // doc.items.at(0) → Ref<struct> | undefined
 * // doc.items.at(0)?.name()     → string
 * // doc.items.at(0)?.name.set("updated")
 * // doc.items.push({ name: "new" })
 * // doc[TRANSACT]   → WritableContext
 * ```
 */
export type Ref<S extends Schema> =
  // --- Annotated: dispatch on tag ---
  S extends AnnotatedSchema<infer Tag, infer Inner>
    ? Tag extends "text"
      ? WithTransact<
          (() => string) &
          { [Symbol.toPrimitive](hint: string): string } &
          TextRef
        >
      : Tag extends "counter"
        ? WithTransact<
            (() => number) &
            { [Symbol.toPrimitive](hint: string): number | string } &
            CounterRef
          >
        : Tag extends "doc"
          ? Inner extends ProductSchema<infer F>
            ? WithTransact<
                (() => { [K in keyof F]: Plain<F[K]> }) &
                { readonly [K in keyof F]: Ref<F[K]> } &
                ProductRef<{ [K in keyof F]: Plain<F[K]> }>
              >
            : unknown
          : Tag extends "movable"
            ? Inner extends SequenceSchema<infer I>
              ? WithTransact<
                  ReadableSequenceRef<Ref<I>, Plain<I>> &
                  SequenceRef
                >
              : unknown
            : Tag extends "tree"
              ? Inner extends Schema ? Ref<Inner> : unknown
              : // Unknown annotation with inner — delegate
                Inner extends Schema ? Ref<Inner> : unknown
    : // --- Scalar ---
      S extends ScalarSchema<infer _K, infer V>
      ? WithTransact<
          (() => V) &
          { [Symbol.toPrimitive](hint: string): V | string } &
          ScalarRef<V>
        >
      : // --- Product ---
        S extends ProductSchema<infer F>
        ? WithTransact<
            (() => { [K in keyof F]: Plain<F[K]> }) &
            { readonly [K in keyof F]: Ref<F[K]> } &
            ProductRef<{ [K in keyof F]: Plain<F[K]> }>
          >
        : // --- Sequence ---
          S extends SequenceSchema<infer I>
          ? WithTransact<
              ReadableSequenceRef<Ref<I>, Plain<I>> &
              SequenceRef
            >
          : // --- Map ---
            S extends MapSchema<infer I>
            ? WithTransact<
                ReadableMapRef<Ref<I>, Plain<I>> &
                WritableMapRef<Plain<I>>
              >
            : // --- Sum ---
              S extends PositionalSumSchema<infer V>
              ? Ref<V[number]>
              : S extends DiscriminatedSumSchema
                ? unknown
                : unknown