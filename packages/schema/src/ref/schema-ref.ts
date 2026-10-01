// SchemaRef<S, N> — the recursive type of a document's refs.
//
// SchemaRef<S, N> combines navigation, reading, writing, observation and
// typed native container access into a single recursive conditional type. It
// gives each schema node a precise type where `.at()` returns
// `SchemaRef<Child, N>`: the read surfaces (`readable.ts`) and the write
// surfaces (`writable.ts`) are intersected per kind, with children typed as
// `SchemaRef` again.
//
// The native map parameter `N extends NativeMap` is the type-level functor
// that maps schema kinds to substrate-native container types. Each branch
// of SchemaRef indexes into N to determine the [NATIVE] type:
//   - text → N["text"] (e.g. LoroText for Loro)
//   - list → N["list"] (e.g. LoroList for Loro)
//   - struct → N["struct"] (e.g. LoroMap for Loro)
//   - etc.
//
// N is NOT recursive — it threads through unchanged at every level. Adding N
// increases type width (one more parameter) but NOT recursive depth.
//
// Named aliases provide the user-facing API:
//   - `Ref<S, N>`     = `SchemaRef<S, N>` — a document's ref (the common case)
//   - `RRef<S>`       = `Readable<S>` — the read surface alone, for code that
//     only reads (alias only, no new recursion)
//   - `DocRef<S, N>`  = root ref with N["root"] override (e.g. LoroDoc, not LoroMap)
//
// Key design points:
//   - Children are `SchemaRef<Child, N>`, preserving the native map recursively
//   - Sequences use `ReadableSequenceRef<SchemaRef<I, N>, Plain<I>> & SequenceRef`
//     — navigation + reading from ReadableSequenceRef, mutation from
//     SequenceRef (which has no `.at()`, so no overload conflict)
//   - Maps use `ReadableMapRef<SchemaRef<I, N>, Plain<I>> & WritableMapRef<Plain<I>>`
//   - Sets use `ReadableSetRef<Plain<I>> & WritableSetRef<Plain<I>>` — leaf-shaped
//     (no per-member child refs, no `.at(value)`)
//   - `Wrap<T, Native>` intersects the cross-cutting concerns + HasNative<Native>

import type { HasChangefeed } from "@kyneta/changefeed"
import type { RichTextDelta } from "../change.js"
import type { HasNative, NativeMap, UnknownNativeMap } from "../native.js"
import type { Plain } from "../plain-types.js"
import type {
  CounterSchema,
  DiscriminatedSumSchema,
  MapSchema,
  MovableSequenceSchema,
  PositionalSumSchema,
  ProductSchema,
  RichTextSchema,
  ScalarSchema,
  Schema,
  SequenceSchema,
  SetSchema,
  TextSchema,
  TreeSchema,
} from "../schema.js"
import type { HasRemove } from "./address.js"
import type {
  Readable,
  ReadableMapRef,
  ReadableSequenceRef,
  ReadableSetRef,
  ReadableTreeRef,
} from "./readable.js"
import type {
  CounterRef,
  ProductRef,
  RichTextRef,
  ScalarRef,
  SequenceRef,
  TextRef,
  WritableMapRef,
  WritableSetRef,
  WritableTreeRef,
} from "./writable.js"
import type { HasTransact } from "./write.js"

// ---------------------------------------------------------------------------
// Removable<T> — container-child ref wrapper
// ---------------------------------------------------------------------------

/**
 * A ref that can remove itself from its parent container via `[REMOVE]()`.
 *
 * Produced by `.at()` on sequence, map, and set refs. Product field refs
 * and top-level document refs are NOT `Removable`.
 *
 * At runtime, `[REMOVE]` is on the prototype of every list item's and record
 * entry's ref (`ref/address.ts`).
 */
export type Removable<T> = T & HasRemove

// ---------------------------------------------------------------------------
// Wrap<T, Native> — the cross-cutting concerns of every ref
// ---------------------------------------------------------------------------

/**
 * Intersects `T` with the cross-cutting concerns every ref has —
 * `HasTransact` and `HasChangefeed` — and the typed `[NATIVE]` property via
 * `HasNative<Native>`.
 *
 * This is the single edit point for cross-cutting concerns. Every node in
 * `SchemaRef` is wrapped through `Wrap<T, Native>`, so adding a new concern
 * here propagates recursively to all nodes.
 */
export type Wrap<T, Native = unknown> = T &
  HasTransact &
  HasChangefeed &
  HasNative<Native>

// ---------------------------------------------------------------------------
// DiscriminantProductRef — hybrid product ref for discriminated union variants
// ---------------------------------------------------------------------------

/**
 * Produces a hybrid product ref for a discriminated union variant.
 *
 * The discriminant field `D` resolves to its `Plain<S>` value (a raw string
 * literal). All other fields are `Readable<F[K]>` — callable for reading
 * but without `.set()`. The only write operation is `.set()` on the union
 * ref itself (via `ProductRef`) for whole-value replacement.
 *
 * Sum interiors are read-only because sums are opaque LWW values — variant
 * fields are not independently addressable CRDT positions. Individual field
 * mutation would violate the atomic replacement semantics of `lww-tag-replaced`.
 *
 * This enables standard TypeScript discriminated union narrowing:
 * ```ts
 * if (ref.type === "text") { console.log(ref.body()) } // TS narrows
 * ```
 *
 * TS homomorphic mapped types distribute over union type arguments, so
 * `DiscriminantProductRef<V[number]["fields"], D, N>` correctly produces
 * a union of per-variant product refs — a proper TS discriminated union.
 */
export type DiscriminantProductRef<
  F extends Record<string, Schema>,
  D extends string,
  N extends NativeMap = UnknownNativeMap,
> = Wrap<
  (() => { readonly [K in keyof F]: Plain<F[K]> }) & {
    readonly [K in keyof F]: K extends D ? Plain<F[K]> : Readable<F[K]>
  } & ProductRef<{ readonly [K in keyof F]: Plain<F[K]> }>,
  N["sum"]
>

// ---------------------------------------------------------------------------
// SchemaRef<S, N> — the recursive core
// ---------------------------------------------------------------------------

/**
 * Computes the ref type for a given schema type and native map. `Ref<S, N>`
 * is the user-facing alias.
 *
 * Every node is:
 *   - Callable (reading: `ref()` → `Plain<S>`)
 *   - Navigable (`.at()` returns `SchemaRef<Child, N>` for collections)
 *   - Writable (`.set()`, `.push()`, `.insert()`, `.delete()`, etc.)
 *   - Transactable (`ref[TRANSACT]` → `WritableContext`)
 *   - Native-accessible (`ref[NATIVE]` → substrate-native container)
 *   - Observable (`ref[CHANGEFEED]` → `Changefeed`)
 *
 * The `N` parameter threads through unchanged — each branch indexes `N`
 * to pick the right native type (`N["text"]`, `N["list"]`, etc.).
 * This adds zero recursive depth.
 */
export type SchemaRef<
  S extends Schema,
  N extends NativeMap = UnknownNativeMap,
> =
  // --- Text ---
  S extends TextSchema
    ? Wrap<
        (() => string) & {
          [Symbol.toPrimitive](hint: string): string
        } & TextRef,
        N["text"]
      >
    : // --- RichText ---
      S extends RichTextSchema
      ? Wrap<
          (() => RichTextDelta) & {
            [Symbol.toPrimitive](hint: string): string
          } & RichTextRef,
          N["richtext"]
        >
      : // --- Counter ---
        S extends CounterSchema
        ? Wrap<
            (() => number) & {
              [Symbol.toPrimitive](hint: string): number | string
            } & CounterRef,
            N["counter"]
          >
        : // --- Set (leaf-shaped: value-addressed, no per-member child refs) ---
          S extends SetSchema<infer I>
          ? Wrap<ReadableSetRef<Plain<I>> & WritableSetRef<Plain<I>>, N["set"]>
          : // --- Tree (flat-forest with recursive read surface) ---
            S extends TreeSchema<infer Inner>
            ? Wrap<
                ReadableTreeRef<Inner, SchemaRef<Inner, N>> &
                  WritableTreeRef<Plain<Inner>>,
                N["tree"]
              >
            : // --- MovableSequence ---
              S extends MovableSequenceSchema<infer I>
              ? Wrap<
                  ReadableSequenceRef<Removable<SchemaRef<I, N>>, Plain<I>> &
                    SequenceRef,
                  N["movableList"]
                >
              : // --- Scalar ---
                S extends ScalarSchema<infer _K, infer V>
                ? Wrap<
                    (() => V) & {
                      [Symbol.toPrimitive](hint: string): V | string
                    } & ScalarRef<V>,
                    N["scalar"]
                  >
                : // --- Product ---
                  S extends ProductSchema<infer F>
                  ? Wrap<
                      (() => { readonly [K in keyof F]: Plain<F[K]> }) & {
                        readonly [K in keyof F]: SchemaRef<F[K], N>
                      } & ProductRef<{ readonly [K in keyof F]: Plain<F[K]> }>,
                      N["struct"]
                    >
                  : // --- Sequence ---
                    S extends SequenceSchema<infer I>
                    ? Wrap<
                        ReadableSequenceRef<
                          Removable<SchemaRef<I, N>>,
                          Plain<I>
                        > &
                          SequenceRef,
                        N["list"]
                      >
                    : // --- Map ---
                      S extends MapSchema<infer I>
                      ? Wrap<
                          ReadableMapRef<Removable<SchemaRef<I, N>>, Plain<I>> &
                            WritableMapRef<Plain<I>>,
                          N["map"]
                        >
                      : // --- Sum ---
                        S extends PositionalSumSchema<infer V>
                        ? V extends readonly [
                            ScalarSchema<"null", any>,
                            infer Inner extends Schema,
                          ]
                          ? // Nullable sugar: collapse to a single ref with nullable value domain
                            Wrap<
                              (() => Plain<Inner> | null) & {
                                [Symbol.toPrimitive](
                                  hint: string,
                                ): Plain<Inner> | null | string
                              } & ScalarRef<Plain<Inner> | null>,
                              N["sum"]
                            >
                          : // General positional sum: distribute over variant union
                            SchemaRef<V[number], N>
                        : S extends DiscriminatedSumSchema<infer D, infer V>
                          ? DiscriminantProductRef<V[number]["fields"], D, N>
                          : unknown

// ---------------------------------------------------------------------------
// DocRef — root ref with N["root"] override
// ---------------------------------------------------------------------------

/**
 * Root document ref type. Identical in shape to `Ref<S, N>` for a product
 * schema, except the top-level `[NATIVE]` slot resolves to `N["root"]`
 * (e.g. `LoroDoc`) instead of `N["struct"]` (e.g. `LoroMap`). This matches
 * runtime behavior: `nativeResolver` returns the native *document* at
 * `path.segments.length === 0`, and the per-node native for children.
 *
 * Rather than `Omit`-ing `[NATIVE]` off `SchemaRef` and re-intersecting
 * (which forces `keyof` + a full mapped reconstruction + a second
 * `SchemaRef` instantiation — three deep evaluations, the TS2589 trigger
 * documented in jj:tvpmzxvx), this re-expresses the product branch of
 * `SchemaRef` directly with `N["root"]` as the wrapped native. Cost is one
 * product-body instantiation — the same as a plain `Ref<Product, N>`.
 * Children remain `SchemaRef<F[K], N>`, so nested structs naturally
 * resolve to `N["struct"]`.
 *
 * Non-product roots (rare) fall through to a plain `SchemaRef`.
 *
 * `unwrap` is unchanged: `unwrap(docRef)` indexes `[NATIVE]` → `N["root"]`;
 * `unwrap(docRef.child)` indexes the child's `[NATIVE]` → `N["struct"]`.
 *
 * IMPORTANT: public-facing aliases that return `DocRef<S, N>` for a generic
 * `S` (e.g. `Exchange.get`, `useDocument`) MUST gate it behind a conditional
 * — `S extends ProductSchema ? DocRef<S, N> : Ref<S, N>` — so the deferred
 * conditional prevents `DocRef` from being instantiated against an abstract
 * `S` during signature/contextual-type checking (the other TS2589 trigger,
 * confirmed empirically).
 */
export type DocRef<S extends Schema, N extends NativeMap = UnknownNativeMap> =
  S extends ProductSchema<infer F>
    ? Wrap<
        (() => { readonly [K in keyof F]: Plain<F[K]> }) & {
          readonly [K in keyof F]: SchemaRef<F[K], N>
        } & ProductRef<{ readonly [K in keyof F]: Plain<F[K]> }>,
        N["root"]
      >
    : SchemaRef<S, N>

// ---------------------------------------------------------------------------
// Tier aliases — the user-facing ref types
// ---------------------------------------------------------------------------

/**
 * The read surface of a ref alone: `Readable<S>`. For code that only reads,
 * such as a component taking a ref it never writes through. Callable and
 * navigable; every `Ref<S>` is one.
 *
 * `Readable<S>` is a separate recursive type (not a `SchemaRef` mode) because
 * its structure is fundamentally different — no mutation interfaces are
 * intersected, and children are `Readable<Child>` (not `SchemaRef<Child, N>`).
 */
export type RRef<S extends Schema> = Readable<S>

/**
 * A document's ref: read + write + transact + changefeed. What `createDoc`
 * and `exchange.get` return, at every node: callable, navigable, writable,
 * transactable, and observable.
 *
 * ```ts
 * const s = Schema.struct({
 *   title: Schema.text(),
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
 * // doc[CHANGEFEED] → Changefeed
 * // doc[NATIVE]     → N["struct"] (or N["root"] for DocRef)
 * ```
 */
export type Ref<
  S extends Schema,
  N extends NativeMap = UnknownNativeMap,
> = SchemaRef<S, N>
