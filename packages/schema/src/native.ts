// native — NativeMap functor, NATIVE/SUBSTRATE symbols, HasNative.
//
// Each substrate defines a functor from the schema category to the native
// container category. NativeMap is the type-level representation of this
// functor — one concrete implementation per substrate.
//
// NATIVE is a symbol property attached to every ref during interpretation,
// carrying the substrate-native container (LoroText, Y.Map, etc.) or
// undefined for scalars without a dedicated container.
//
// SUBSTRATE is an internal symbol property on root refs only, carrying the
// Substrate instance for sync functions (version, exportEntirety, etc.).

import type { PlainState } from "./reader.js"

// ---------------------------------------------------------------------------
// NATIVE — typed escape hatch symbol
// ---------------------------------------------------------------------------

/**
 * Symbol property on every ref, carrying the substrate-native container.
 *
 * - For Loro: `LoroDoc` (root), `LoroText`, `LoroList`, `LoroMap`, etc.
 * - For Yjs: `Y.Doc` (root), `Y.Text`, `Y.Array`, `Y.Map`, etc.
 * - For Plain: `PlainState` (root), `undefined` (all children)
 * - `undefined` for scalars that don't have a dedicated container
 *
 * Typed via `HasNative<T>` intersected into `SchemaRef` at every node.
 * Read via `unwrap(ref)` or directly as `ref[NATIVE]`.
 */
export const NATIVE: unique symbol = Symbol.for("kyneta:native") as any

// ---------------------------------------------------------------------------
// SUBSTRATE — internal, root only
// ---------------------------------------------------------------------------

/**
 * Symbol property on root refs only, carrying the `Substrate` instance.
 *
 * Used internally by generic sync functions (`version`, `exportEntirety`,
 * `exportSince`, `merge`) to recover the substrate from a root ref.
 * Not part of the public type API — not threaded through the type system.
 */
export const SUBSTRATE: unique symbol = Symbol.for("kyneta:substrate") as any

// ---------------------------------------------------------------------------
// NativeMap — the functor interface
// ---------------------------------------------------------------------------

/**
 * Type-level functor mapping schema kinds to native container types.
 *
 * Each substrate provides a concrete implementation:
 * - `LoroNativeMap` maps `text → LoroText`, `list → LoroList`, etc.
 * - `YjsNativeMap` maps `text → Y.Text`, `list → Y.Array`, etc.
 * - `PlainNativeMap` maps `root → PlainState`, everything else → `undefined`
 *
 * `SchemaRef<S, M, N>` indexes into `N` at each branch to determine the
 * concrete `[NATIVE]` type for that node.
 */
export interface NativeMap {
  readonly root: unknown
  readonly text: unknown
  readonly richtext: unknown
  readonly counter: unknown
  readonly list: unknown
  readonly movableList: unknown
  readonly struct: unknown
  readonly map: unknown
  readonly tree: unknown
  readonly set: unknown
  readonly scalar: unknown
  readonly sum: unknown
}

// ---------------------------------------------------------------------------
// UnknownNativeMap — the default (all slots unknown)
// ---------------------------------------------------------------------------

/**
 * The default NativeMap — all slots are `unknown`.
 *
 * Used as the default for `SchemaRef<S, M, N = UnknownNativeMap>`.
 * Existing code that doesn't specify `N` gets `[NATIVE]: unknown`
 * at every node — non-breaking.
 */
export interface UnknownNativeMap extends NativeMap {
  readonly root: unknown
  readonly text: unknown
  readonly richtext: unknown
  readonly counter: unknown
  readonly list: unknown
  readonly movableList: unknown
  readonly struct: unknown
  readonly map: unknown
  readonly tree: unknown
  readonly set: unknown
  readonly scalar: unknown
  readonly sum: unknown
}

// ---------------------------------------------------------------------------
// PlainNativeMap — plain JSON substrate
// ---------------------------------------------------------------------------

/**
 * NativeMap for the plain JSON substrate.
 *
 * Only the root has a native value (`PlainState` — the backing JS object).
 * All children are `undefined` — plain substrates don't have dedicated
 * containers for individual fields.
 */
export interface PlainNativeMap extends NativeMap {
  readonly root: PlainState
  readonly text: undefined
  readonly richtext: undefined
  readonly counter: undefined
  readonly list: undefined
  readonly movableList: undefined
  readonly struct: undefined
  readonly map: undefined
  readonly tree: undefined
  readonly set: undefined
  readonly scalar: undefined
  readonly sum: undefined
}

// ---------------------------------------------------------------------------
// HasNative — the property mixin
// ---------------------------------------------------------------------------

/**
 * Mixin type that adds a typed `[NATIVE]` property to a ref.
 *
 * Intersected into every node of `SchemaRef` via `Wrap<T, M, Native>`.
 * The concrete `T` is determined by indexing the `NativeMap`: e.g.
 * `HasNative<N["text"]>` for text nodes, `HasNative<N["list"]>` for lists.
 */
export interface HasNative<T> {
  readonly [NATIVE]: T
}
