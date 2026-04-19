// Bottom interpreter — the universal foundation of the interpreter stack.
//
// Produces callable function carriers at every schema node. Each carrier
// delegates to a `[CALL]` symbol slot which, by default, throws an
// informative error. Upstream transformers (`withReadable`) fill the
// `CALL` slot to enable actual reading.
//
// The carrier is a real function object, so properties can be attached
// by any layer in the stack. Identity is preserved through the entire
// transformer chain — no layer replaces the carrier.
//
// This module also defines the capability lattice used for compile-time
// composition safety:
//
//   HasCall  ←  HasNavigation  ←  HasCaching
//                    ↑
//                 HasRead
//
// HasRead and HasCaching both extend HasNavigation independently,
// forming a diamond. HasRead means "the [CALL] slot has been filled
// with a reader." HasCaching means "child caching + INVALIDATE."
//
// Each level is branded with a phantom symbol so TypeScript's structural
// subtyping enforces valid transformer ordering.
//
// See .plans/interpreter-decomposition.md §Phase 1.

import type { ChangeBase } from "../change.js"
import type { Interpreter, Path, SumVariants } from "../interpret.js"
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

// ---------------------------------------------------------------------------
// Forward-declared INVALIDATE symbol type
// ---------------------------------------------------------------------------
// The INVALIDATE runtime symbol lives in with-caching.ts. We declare its
// type here so HasCaching can reference it without importing the runtime
// value or using a computed Symbol.for() in the interface (which esbuild
// rejects).

declare const INVALIDATE_SYMBOL: unique symbol
/**
 * Type-level reference to the INVALIDATE symbol.
 * At runtime this is `Symbol.for("kyneta:invalidate")`.
 */
export type INVALIDATE_TYPE = typeof INVALIDATE_SYMBOL

// ---------------------------------------------------------------------------
// Runtime symbols
// ---------------------------------------------------------------------------

/**
 * Symbol-keyed slot that controls what happens when a carrier is called.
 *
 * `bottomInterpreter` sets this to a function that throws. `withReadable`
 * replaces it with `() => readByPath(store, path)`.
 *
 * Uses `Symbol.for` so multiple copies of this module share identity.
 */
export const CALL: unique symbol = Symbol.for("kyneta:call") as any

// ---------------------------------------------------------------------------
// Phantom brand symbols — compile-time only, zero runtime cost
// ---------------------------------------------------------------------------

/**
 * Phantom brand indicating structural navigation is available
 * (product lazy getters, sequence `.at()`, map `.at()`, etc.).
 *
 * Present on carriers produced by `withReadable` and above.
 * Never exists at runtime — used purely for TypeScript's structural
 * subtyping to enforce composition ordering.
 */
declare const NAVIGATION: unique symbol

export type { NAVIGATION }

/**
 * Phantom brand indicating child caching is available.
 *
 * Present on carriers produced by `withCaching` and above.
 * Never exists at runtime.
 */
declare const CACHING: unique symbol

export type { CACHING }

// ---------------------------------------------------------------------------
// Capability interfaces — the lattice
// ---------------------------------------------------------------------------

/**
 * A carrier that has a `[CALL]` slot. This is the minimal capability
 * produced by `bottomInterpreter`.
 */
export interface HasCall {
  readonly [CALL]: (...args: unknown[]) => unknown
}

/**
 * A carrier that has structural navigation (product field access,
 * sequence/map `.at()`, etc.). Extends `HasCall`.
 *
 * The `[NAVIGATION]` property is a phantom brand — it never exists
 * at runtime. Its purpose is to make `HasNavigation` structurally
 * distinct from `HasCall` so that `withCaching` can require it as
 * a precondition.
 */
export interface HasNavigation extends HasCall {
  /** @internal phantom brand — never set at runtime */
  readonly [NAVIGATION]: true
}

/**
 * A carrier whose `[CALL]` slot has been filled with a reader — calling
 * the carrier returns a meaningful value. Extends `HasNavigation`.
 *
 * This is a phantom brand only — no runtime symbol. The runtime slot
 * is `[CALL]`. `HasRead` is produced by `withReadable` and means
 * "this carrier can be called to read a value."
 *
 * Distinct from `HasCall` (which just means "has a `[CALL]` slot that
 * may throw") and `HasNavigation` (which means "structural addressing
 * is available but calling may still throw").
 */
declare const READ_BRAND: unique symbol
export interface HasRead extends HasNavigation {
  /** @internal phantom brand — never set at runtime */
  readonly [READ_BRAND]: true
}

/**
 * A carrier that has child caching and change-driven cache invalidation.
 * Extends `HasNavigation`.
 *
 * `INVALIDATE` is optional because not every node kind gets a cache
 * (scalars, text, counters don't). `withWritable` guards at runtime:
 * `if (INVALIDATE in result)`.
 *
 * The `[CACHING]` property is a phantom brand.
 *
 * Note: The INVALIDATE slot uses a declared symbol type rather than
 * `Symbol.for(...)` because esbuild doesn't support computed property
 * names with expressions in interfaces. The runtime symbol identity
 * is `Symbol.for("kyneta:invalidate")`, defined in with-caching.ts.
 */
export interface HasCaching extends HasNavigation {
  readonly [INVALIDATE_SYMBOL]?: (change: ChangeBase) => void
  /** @internal phantom brand — never set at runtime */
  readonly [CACHING]: true
}

// ---------------------------------------------------------------------------
// makeCarrier — creates the callable foundation
// ---------------------------------------------------------------------------

/**
 * Creates a callable function carrier with a `[CALL]` slot.
 *
 * The carrier is `(...args) => carrier[CALL](...args)`. By default,
 * `CALL` throws — compose with `withReadable` to enable reading.
 *
 * The carrier is a real `Function` object, so any layer can attach
 * properties (navigation, caching, mutation methods, etc.) without
 * replacing the carrier identity.
 */
export function makeCarrier(): HasCall {
  const carrier: any = function (this: any, ...args: unknown[]): unknown {
    return carrier[CALL](...args)
  }

  carrier[CALL] = (): unknown => {
    throw new Error("No call behavior configured")
  }

  return carrier as HasCall
}

// ---------------------------------------------------------------------------
// bottomInterpreter — the universal foundation
// ---------------------------------------------------------------------------

/**
 * The bottom interpreter — produces callable function carriers at every
 * schema node. Each carrier's `[CALL]` slot throws by default.
 *
 * This is the starting point for every interpreter stack:
 *
 * ```ts
 * bottomInterpreter                                  // carriers only
 * withReadable(bottomInterpreter)                    // + reading + navigation
 * withCaching(withReadable(bottomInterpreter))       // + caching
 * withWritable(withCaching(withReadable(bottom)))    // + mutation
 * ```
 *
 * The `Ctx` is `unknown` — bottom needs no context. Layers that need
 * context (e.g. `withReadable` needs a store) narrow it in their own
 * type signatures.
 */
export const bottomInterpreter: Interpreter<unknown, HasCall> = {
  scalar(_ctx: unknown, _path: Path, _schema: ScalarSchema): HasCall {
    return makeCarrier()
  },

  product(
    _ctx: unknown,
    _path: Path,
    _schema: ProductSchema,
    _fields: Readonly<Record<string, () => HasCall>>,
  ): HasCall {
    // Field thunks are intentionally ignored — bottom produces inert
    // carriers. `withReadable` / `withCaching` will use the thunks
    // to build navigation and caching.
    return makeCarrier()
  },

  sequence(
    _ctx: unknown,
    _path: Path,
    _schema: SequenceSchema,
    _item: (index: number) => HasCall,
  ): HasCall {
    return makeCarrier()
  },

  map(
    _ctx: unknown,
    _path: Path,
    _schema: MapSchema,
    _item: (key: string) => HasCall,
  ): HasCall {
    return makeCarrier()
  },

  sum(
    _ctx: unknown,
    _path: Path,
    _schema: SumSchema,
    _variants: SumVariants<HasCall>,
  ): HasCall {
    return makeCarrier()
  },

  // --- First-class leaf types -----------------------------------------------
  // Text and counter are leaf types — they get their own carrier.

  text(_ctx: unknown, _path: Path, _schema: TextSchema): HasCall {
    return makeCarrier()
  },

  counter(_ctx: unknown, _path: Path, _schema: CounterSchema): HasCall {
    return makeCarrier()
  },

  // --- First-class container types ------------------------------------------
  // Set delegates like map, tree delegates via nodeData, movable delegates
  // like sequence.

  set(
    _ctx: unknown,
    _path: Path,
    _schema: SetSchema,
    _item: (key: string) => HasCall,
  ): HasCall {
    return makeCarrier()
  },

  tree(
    _ctx: unknown,
    _path: Path,
    _schema: TreeSchema,
    nodeData: () => HasCall,
  ): HasCall {
    return nodeData()
  },

  movable(
    _ctx: unknown,
    _path: Path,
    _schema: MovableSequenceSchema,
    _item: (index: number) => HasCall,
  ): HasCall {
    return makeCarrier()
  },

  richtext(_ctx: unknown, _path: Path, _schema: RichTextSchema): HasCall {
    return makeCarrier()
  },
}
