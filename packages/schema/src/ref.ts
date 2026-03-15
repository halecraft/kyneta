// SchemaRef<S, M> — parameterized recursive type for composed interpreter refs.
//
// SchemaRef<S, M> combines navigation, reading, writing, and mode-dependent
// cross-cutting concerns into a single recursive conditional type. It replaces
// the unsound `Readable<S> & Writable<S>` intersection by giving each schema
// node a precise type where `.at()` returns `SchemaRef<Child, M>` (not separate
// `Readable<Child>` / `Writable<Child>` with conflicting `.at()` types).
//
// The mode parameter `M extends RefMode` controls which cross-cutting concerns
// are intersected at every node:
//   - `"rw"`  → `HasTransact` only (read-write without changefeed)
//   - `"rwc"` → `HasTransact` + `HasChangefeed` (full stack)
//
// Three named aliases provide the user-facing API:
//   - `RRef<S>`  = `Readable<S>` — read-only tier (alias only, no new recursion)
//   - `RWRef<S>` = `SchemaRef<S, "rw">` — read-write tier
//   - `Ref<S>`   = `SchemaRef<S, "rwc">` — full-stack tier (the common case)
//
// Key design points:
//   - Children are `SchemaRef<Child, M>`, preserving the mode recursively
//   - Sequences use `ReadableSequenceRef<SchemaRef<I, M>, Plain<I>> & SequenceRef`
//     — navigation + reading from ReadableSequenceRef, mutation from
//     SequenceRef (which has no `.at()`, so no overload conflict)
//   - Maps use `ReadableMapRef<SchemaRef<I, M>, Plain<I>> & WritableMapRef<Plain<I>>`
//   - `Wrap<T, M>` intersects cross-cutting concerns per mode
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
import type { Readable, ReadableSequenceRef, ReadableMapRef } from "./interpreters/readable.js"
import type {
  HasTransact,
  ScalarRef,
  TextRef,
  CounterRef,
  SequenceRef,
  ProductRef,
  WritableMapRef,
} from "./interpreters/writable.js"
import type { HasChangefeed } from "./changefeed.js"

// ---------------------------------------------------------------------------
// RefMode — the mode parameter for SchemaRef
// ---------------------------------------------------------------------------

/**
 * The mode parameter that controls which cross-cutting concerns are
 * intersected at every node of a `SchemaRef<S, M>`.
 *
 * - `"rw"`  — read-write: `HasTransact` only
 * - `"rwc"` — read-write-changefeed: `HasTransact` + `HasChangefeed`
 */
export type RefMode = "rw" | "rwc"

// ---------------------------------------------------------------------------
// Wrap<T, M> — mode-dispatched cross-cutting concern wrapper
// ---------------------------------------------------------------------------

/**
 * Intersects `T` with the cross-cutting concerns appropriate for mode `M`.
 *
 * - `"rw"`  → `T & HasTransact`
 * - `"rwc"` → `T & HasTransact & HasChangefeed`
 *
 * This is the single edit point for cross-cutting concerns. Every node in
 * `SchemaRef` is wrapped through `Wrap<T, M>`, so adding a new concern
 * here propagates recursively to all nodes.
 */
export type Wrap<T, M extends RefMode> =
  M extends "rwc"
    ? T & HasTransact & HasChangefeed
    : T & HasTransact

// ---------------------------------------------------------------------------
// WithTransact<T> — backward-compatible alias
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `Wrap<T, "rw">` instead. Kept for backward compatibility.
 *
 * Equivalent to `Wrap<T, "rw">` — intersects `T` with `HasTransact` only.
 */
export type WithTransact<T> = Wrap<T, "rw">

// ---------------------------------------------------------------------------
// DiscriminantProductRef — hybrid product ref for discriminated union variants
// ---------------------------------------------------------------------------

/**
 * Produces a hybrid product ref where the discriminant field `D` resolves to
 * its `Plain<S>` value (a raw string literal), while all other fields remain
 * full recursive `SchemaRef<S, M>` refs.
 *
 * This enables standard TypeScript discriminated union narrowing:
 * ```ts
 * if (ref.type === "text") { ref.body.set("hello") } // TS narrows
 * ```
 *
 * TS homomorphic mapped types distribute over union type arguments, so
 * `DiscriminantProductRef<V[number]["fields"], D, M>` correctly produces
 * a union of per-variant product refs — a proper TS discriminated union.
 */
export type DiscriminantProductRef<
  F extends Record<string, Schema>,
  D extends string,
  M extends RefMode,
> = Wrap<
  (() => { [K in keyof F]: Plain<F[K]> }) &
  {
    readonly [K in keyof F]:
      K extends D ? Plain<F[K]> : SchemaRef<F[K], M>
  } &
  ProductRef<{ [K in keyof F]: Plain<F[K]> }>,
  M
>

// ---------------------------------------------------------------------------
// SchemaRef<S, M> — the parameterized recursive core
// ---------------------------------------------------------------------------

/**
 * Computes the composed ref type for a given schema type and mode.
 *
 * This is the core recursive conditional type. User-facing aliases:
 * - `Ref<S>`   = `SchemaRef<S, "rwc">` — full stack (common case)
 * - `RWRef<S>` = `SchemaRef<S, "rw">` — read-write without changefeed
 *
 * Every node is:
 *   - Callable (reading: `ref()` → `Plain<S>`)
 *   - Navigable (`.at()` returns `SchemaRef<Child, M>` for collections)
 *   - Writable (`.set()`, `.push()`, `.insert()`, `.delete()`, etc.)
 *   - Transactable (`ref[TRANSACT]` → `WritableContext`)
 *   - Observable (if M = "rwc": `ref[CHANGEFEED]` → `Changefeed`)
 */
export type SchemaRef<S extends Schema, M extends RefMode> =
  // --- Annotated: dispatch on tag ---
  S extends AnnotatedSchema<infer Tag, infer Inner>
    ? Tag extends "text"
      ? Wrap<
          (() => string) &
          { [Symbol.toPrimitive](hint: string): string } &
          TextRef,
          M
        >
      : Tag extends "counter"
        ? Wrap<
            (() => number) &
            { [Symbol.toPrimitive](hint: string): number | string } &
            CounterRef,
            M
          >
        : Tag extends "doc"
          ? Inner extends ProductSchema<infer F>
            ? Wrap<
                (() => { [K in keyof F]: Plain<F[K]> }) &
                { readonly [K in keyof F]: SchemaRef<F[K], M> } &
                ProductRef<{ [K in keyof F]: Plain<F[K]> }>,
                M
              >
            : unknown
          : Tag extends "movable"
            ? Inner extends SequenceSchema<infer I>
              ? Wrap<
                  ReadableSequenceRef<SchemaRef<I, M>, Plain<I>> &
                  SequenceRef,
                  M
                >
              : unknown
            : Tag extends "tree"
              ? Inner extends Schema ? SchemaRef<Inner, M> : unknown
              : // Unknown annotation with inner — delegate
                Inner extends Schema ? SchemaRef<Inner, M> : unknown
    : // --- Scalar ---
      S extends ScalarSchema<infer _K, infer V>
      ? Wrap<
          (() => V) &
          { [Symbol.toPrimitive](hint: string): V | string } &
          ScalarRef<V>,
          M
        >
      : // --- Product ---
        S extends ProductSchema<infer F>
        ? Wrap<
            (() => { [K in keyof F]: Plain<F[K]> }) &
            { readonly [K in keyof F]: SchemaRef<F[K], M> } &
            ProductRef<{ [K in keyof F]: Plain<F[K]> }>,
            M
          >
        : // --- Sequence ---
          S extends SequenceSchema<infer I>
          ? Wrap<
              ReadableSequenceRef<SchemaRef<I, M>, Plain<I>> &
              SequenceRef,
              M
            >
          : // --- Map ---
            S extends MapSchema<infer I>
            ? Wrap<
                ReadableMapRef<SchemaRef<I, M>, Plain<I>> &
                WritableMapRef<Plain<I>>,
                M
              >
            : // --- Sum ---
              S extends PositionalSumSchema<infer V>
              ? V extends readonly [ScalarSchema<"null", any>, infer Inner extends Schema]
                ? // Nullable sugar: collapse to a single ref with nullable value domain
                  Wrap<
                    (() => Plain<Inner> | null) &
                    { [Symbol.toPrimitive](hint: string): Plain<Inner> | null | string } &
                    ScalarRef<Plain<Inner> | null>,
                    M
                  >
                : // General positional sum: distribute over variant union
                  SchemaRef<V[number], M>
              : S extends DiscriminatedSumSchema<infer D, infer V>
                ? DiscriminantProductRef<V[number]["fields"], D, M>
                : unknown

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
 * intersected, and children are `Readable<Child>` (not `SchemaRef<Child, M>`).
 */
export type RRef<S extends Schema> = Readable<S>

/**
 * Read-write ref type without changefeed observation.
 *
 * Produced by `interpret(schema, ctx).with(readable).with(writable).done()`.
 * Callable + navigable + writable + `HasTransact`, but no `[CHANGEFEED]`.
 */
export type RWRef<S extends Schema> = SchemaRef<S, "rw">

/**
 * Full-stack ref type: read + write + transact + changefeed. The common case.
 *
 * Produced by `interpret(schema, ctx).with(readable).with(writable).with(changefeed).done()`.
 * Every node is callable, navigable, writable, transactable, and observable.
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
 * // doc[CHANGEFEED] → Changefeed
 * ```
 */
export type Ref<S extends Schema> = SchemaRef<S, "rwc">