// SchemaRef<S, M, N> — parameterized recursive type for composed interpreter refs.
//
// SchemaRef<S, M, N> combines navigation, reading, writing, mode-dependent
// cross-cutting concerns, and typed native container access into a single
// recursive conditional type. It replaces the unsound `Readable<S> & Writable<S>`
// intersection by giving each schema node a precise type where `.at()` returns
// `SchemaRef<Child, M, N>` (not separate `Readable<Child>` / `Writable<Child>`
// with conflicting `.at()` types).
//
// The mode parameter `M extends RefMode` controls which cross-cutting concerns
// are intersected at every node:
//   - `"rw"`  → `HasTransact` only (read-write without changefeed)
//   - `"rwc"` → `HasTransact` + `HasChangefeed` (full stack)
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
// Three named aliases provide the user-facing API:
//   - `RRef<S>`       = `Readable<S>` — read-only tier (alias only, no new recursion)
//   - `RWRef<S, N>`   = `SchemaRef<S, "rw", N>` — read-write tier
//   - `Ref<S, N>`     = `SchemaRef<S, "rwc", N>` — full-stack tier (the common case)
//   - `DocRef<S, N>`  = root ref with N["root"] override (e.g. LoroDoc, not LoroMap)
//
// Key design points:
//   - Children are `SchemaRef<Child, M, N>`, preserving mode and native map recursively
//   - Sequences use `ReadableSequenceRef<SchemaRef<I, M, N>, Plain<I>> & SequenceRef`
//     — navigation + reading from ReadableSequenceRef, mutation from
//     SequenceRef (which has no `.at()`, so no overload conflict)
//   - Maps use `ReadableMapRef<SchemaRef<I, M, N>, Plain<I>> & WritableMapRef<Plain<I>>`
//   - `Wrap<T, M, Native>` intersects cross-cutting concerns per mode + HasNative<Native>
//
// See .plans/navigation-layer.md §Phase 3, Task 3.3.

import type { HasChangefeed } from "@kyneta/changefeed"
import type { Plain } from "./interpreter-types.js"
import type {
  Readable,
  ReadableMapRef,
  ReadableSequenceRef,
} from "./interpreters/readable.js"
import type {
  CounterRef,
  HasTransact,
  ProductRef,
  ScalarRef,
  SequenceRef,
  TextRef,
  WritableMapRef,
} from "./interpreters/writable.js"
import type {
  HasNative,
  NATIVE,
  NativeMap,
  UnknownNativeMap,
} from "./native.js"
import type {
  CounterSchema,
  DiscriminatedSumSchema,
  MapSchema,
  MovableSequenceSchema,
  PositionalSumSchema,
  ProductSchema,
  ScalarSchema,
  Schema,
  SequenceSchema,
  SetSchema,
  TextSchema,
  TreeSchema,
} from "./schema.js"

// ---------------------------------------------------------------------------
// RefMode — the mode parameter for SchemaRef
// ---------------------------------------------------------------------------

/**
 * The mode parameter that controls which cross-cutting concerns are
 * intersected at every node of a `SchemaRef<S, M, N>`.
 *
 * - `"rw"`  — read-write: `HasTransact` only
 * - `"rwc"` — read-write-changefeed: `HasTransact` + `HasChangefeed`
 */
export type RefMode = "rw" | "rwc"

// ---------------------------------------------------------------------------
// Wrap<T, M, Native> — mode-dispatched cross-cutting concern wrapper
// ---------------------------------------------------------------------------

/**
 * Intersects `T` with the cross-cutting concerns appropriate for mode `M`,
 * plus the typed `[NATIVE]` property via `HasNative<Native>`.
 *
 * - `"rw"`  → `T & HasTransact & HasNative<Native>`
 * - `"rwc"` → `T & HasTransact & HasChangefeed & HasNative<Native>`
 *
 * This is the single edit point for cross-cutting concerns. Every node in
 * `SchemaRef` is wrapped through `Wrap<T, M, Native>`, so adding a new
 * concern here propagates recursively to all nodes.
 */
export type Wrap<T, M extends RefMode, Native = unknown> = M extends "rwc"
  ? T &
      HasTransact &
      HasChangefeed &
      HasNative<Native> & {
        readonly isPopulated: (() => boolean) & HasChangefeed<boolean>
      }
  : T & HasTransact & HasNative<Native>

// ---------------------------------------------------------------------------
// DiscriminantProductRef — hybrid product ref for discriminated union variants
// ---------------------------------------------------------------------------

/**
 * Produces a hybrid product ref where the discriminant field `D` resolves to
 * its `Plain<S>` value (a raw string literal), while all other fields remain
 * full recursive `SchemaRef<S, M, N>` refs.
 *
 * This enables standard TypeScript discriminated union narrowing:
 * ```ts
 * if (ref.type === "text") { ref.body.set("hello") } // TS narrows
 * ```
 *
 * TS homomorphic mapped types distribute over union type arguments, so
 * `DiscriminantProductRef<V[number]["fields"], D, M, N>` correctly produces
 * a union of per-variant product refs — a proper TS discriminated union.
 */
export type DiscriminantProductRef<
  F extends Record<string, Schema>,
  D extends string,
  M extends RefMode,
  N extends NativeMap = UnknownNativeMap,
> = Wrap<
  (() => { [K in keyof F]: Plain<F[K]> }) & {
    readonly [K in keyof F]: K extends D ? Plain<F[K]> : SchemaRef<F[K], M, N>
  } & ProductRef<{ [K in keyof F]: Plain<F[K]> }>,
  M,
  N["struct"]
>

// ---------------------------------------------------------------------------
// SchemaRef<S, M, N> — the parameterized recursive core
// ---------------------------------------------------------------------------

/**
 * Computes the composed ref type for a given schema type, mode, and native map.
 *
 * This is the core recursive conditional type. User-facing aliases:
 * - `Ref<S, N>`   = `SchemaRef<S, "rwc", N>` — full stack (common case)
 * - `RWRef<S, N>` = `SchemaRef<S, "rw", N>` — read-write without changefeed
 *
 * Every node is:
 *   - Callable (reading: `ref()` → `Plain<S>`)
 *   - Navigable (`.at()` returns `SchemaRef<Child, M, N>` for collections)
 *   - Writable (`.set()`, `.push()`, `.insert()`, `.delete()`, etc.)
 *   - Transactable (`ref[TRANSACT]` → `WritableContext`)
 *   - Native-accessible (`ref[NATIVE]` → substrate-native container)
 *   - Observable (if M = "rwc": `ref[CHANGEFEED]` → `Changefeed`)
 *
 * The `N` parameter threads through unchanged — each branch indexes `N`
 * to pick the right native type (`N["text"]`, `N["list"]`, etc.).
 * This adds zero recursive depth.
 */
export type SchemaRef<
  S extends Schema,
  M extends RefMode,
  N extends NativeMap = UnknownNativeMap,
> =
  // --- Text ---
  S extends TextSchema
    ? Wrap<
        (() => string) & {
          [Symbol.toPrimitive](hint: string): string
        } & TextRef,
        M,
        N["text"]
      >
    : // --- Counter ---
      S extends CounterSchema
      ? Wrap<
          (() => number) & {
            [Symbol.toPrimitive](hint: string): number | string
          } & CounterRef,
          M,
          N["counter"]
        >
      : // --- Set (map-like shape) ---
        S extends SetSchema<infer I>
        ? Wrap<
            ReadableMapRef<SchemaRef<I, M, N>, Plain<I>> &
              WritableMapRef<Plain<I>>,
            M,
            N["set"]
          >
        : // --- Tree (delegate to inner nodeData) ---
          S extends TreeSchema<infer Inner>
          ? Inner extends Schema
            ? SchemaRef<Inner, M, N>
            : unknown
          : // --- MovableSequence ---
            S extends MovableSequenceSchema<infer I>
            ? Wrap<
                ReadableSequenceRef<SchemaRef<I, M, N>, Plain<I>> & SequenceRef,
                M,
                N["movableList"]
              >
            : // --- Scalar ---
              S extends ScalarSchema<infer _K, infer V>
              ? Wrap<
                  (() => V) & {
                    [Symbol.toPrimitive](hint: string): V | string
                  } & ScalarRef<V>,
                  M,
                  N["scalar"]
                >
              : // --- Product ---
                S extends ProductSchema<infer F>
                ? Wrap<
                    (() => { [K in keyof F]: Plain<F[K]> }) & {
                      readonly [K in keyof F]: SchemaRef<F[K], M, N>
                    } & ProductRef<{ [K in keyof F]: Plain<F[K]> }>,
                    M,
                    N["struct"]
                  >
                : // --- Sequence ---
                  S extends SequenceSchema<infer I>
                  ? Wrap<
                      ReadableSequenceRef<SchemaRef<I, M, N>, Plain<I>> &
                        SequenceRef,
                      M,
                      N["list"]
                    >
                  : // --- Map ---
                    S extends MapSchema<infer I>
                    ? Wrap<
                        ReadableMapRef<SchemaRef<I, M, N>, Plain<I>> &
                          WritableMapRef<Plain<I>>,
                        M,
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
                            M,
                            N["sum"]
                          >
                        : // General positional sum: distribute over variant union
                          SchemaRef<V[number], M, N>
                      : S extends DiscriminatedSumSchema<infer D, infer V>
                        ? DiscriminantProductRef<V[number]["fields"], D, M, N>
                        : unknown

// ---------------------------------------------------------------------------
// DocRef — root ref with N["root"] override
// ---------------------------------------------------------------------------

/**
 * Root document ref type. Replaces the product-level `N["struct"]` native
 * type with `N["root"]` — e.g. `LoroDoc` instead of `LoroMap`.
 *
 * At the type level, this uses `Omit` to strip the inherited `[NATIVE]`
 * from `SchemaRef` (which would be `N["struct"]` for a product) and
 * re-intersects `HasNative<N["root"]>`. This matches the runtime behavior:
 * `nativeResolver` returns the native doc at `path.segments.length === 0`.
 *
 * `createDoc` returns `DocRef<S, N>`. Children use `N["struct"]` /
 * `N["text"]` / etc. naturally from `SchemaRef`.
 */
export type DocRef<
  S extends Schema,
  N extends NativeMap = UnknownNativeMap,
> = Omit<SchemaRef<S, "rwc", N>, typeof NATIVE> & HasNative<N["root"]>

// ---------------------------------------------------------------------------
// Tier aliases — the user-facing ref types
// ---------------------------------------------------------------------------

/**
 * Read-only ref type. Alias for `Readable<S>`.
 *
 * Produced by `interpret(schema, ctx).with(readable).done()`.
 * Callable + navigable, no mutation methods, no `[TRANSACT]`, no `[CHANGEFEED]`.
 *
 * `Readable<S>` is a separate recursive type (not a `SchemaRef` mode) because
 * its structure is fundamentally different — no mutation interfaces are
 * intersected, and children are `Readable<Child>` (not `SchemaRef<Child, M, N>`).
 */
export type RRef<S extends Schema> = Readable<S>

/**
 * Read-write ref type without changefeed observation.
 *
 * Produced by `interpret(schema, ctx).with(readable).with(writable).done()`.
 * Callable + navigable + writable + `HasTransact`, but no `[CHANGEFEED]`.
 */
export type RWRef<
  S extends Schema,
  N extends NativeMap = UnknownNativeMap,
> = SchemaRef<S, "rw", N>

/**
 * Full-stack ref type: read + write + transact + changefeed. The common case.
 *
 * Produced by `interpret(schema, ctx).with(readable).with(writable).with(observation).done()`.
 * Every node is callable, navigable, writable, transactable, and observable.
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
> = SchemaRef<S, "rwc", N>
