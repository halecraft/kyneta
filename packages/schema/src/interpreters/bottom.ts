// Bottom interpreter — the universal foundation of the interpreter stack.
//
// Produces callable function carriers at every schema node. Each carrier
// delegates to a `[READ]` symbol slot which, by default, throws an
// informative error. Upstream transformers (`withReadable`) fill the
// `READ` slot to enable actual reading.
//
// The carrier is a real function object, so properties can be attached
// by any layer in the stack. Identity is preserved through the entire
// transformer chain — no layer replaces the carrier.
//
// This module also defines the capability lattice used for compile-time
// composition safety:
//
//   HasRead  ←  HasNavigation  ←  HasCaching
//
// Each level is branded with a phantom symbol so TypeScript's structural
// subtyping enforces valid transformer ordering.
//
// See .plans/interpreter-decomposition.md §Phase 1.

import type { Interpreter, Path, SumVariants } from "../interpret.js"
import type {
  ScalarSchema,
  ProductSchema,
  SequenceSchema,
  MapSchema,
  SumSchema,
  AnnotatedSchema,
} from "../schema.js"
import type { ChangeBase } from "../change.js"

// ---------------------------------------------------------------------------
// Forward-declared INVALIDATE symbol type
// ---------------------------------------------------------------------------
// The INVALIDATE runtime symbol lives in readable.ts today and will move
// to with-caching.ts in Phase 3. We declare its type here so HasCaching
// can reference it without importing the runtime value or using a
// computed Symbol.for() in the interface (which esbuild rejects).

declare const INVALIDATE_SYMBOL: unique symbol
/**
 * Type-level reference to the INVALIDATE symbol.
 * At runtime this is `Symbol.for("schema:invalidate")`.
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
export const READ: unique symbol = Symbol.for("kyneta:read") as any

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
 * A carrier that has a `[READ]` slot. This is the minimal capability
 * produced by `bottomInterpreter`.
 */
export interface HasRead {
  readonly [READ]: (...args: unknown[]) => unknown
}

/**
 * A carrier that has structural navigation (product field access,
 * sequence/map `.at()`, etc.). Extends `HasRead`.
 *
 * The `[NAVIGATION]` property is a phantom brand — it never exists
 * at runtime. Its purpose is to make `HasNavigation` structurally
 * distinct from `HasRead` so that `withCaching` can require it as
 * a precondition.
 */
export interface HasNavigation extends HasRead {
  /** @internal phantom brand — never set at runtime */
  readonly [NAVIGATION]: true
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
 * is `Symbol.for("schema:invalidate")`, defined in readable.ts (and
 * moving to with-caching.ts in Phase 3).
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
 * Creates a callable function carrier with a `[READ]` slot.
 *
 * The carrier is `(...args) => carrier[READ](...args)`. By default,
 * `READ` throws — compose with `withReadable` to enable reading.
 *
 * The carrier is a real `Function` object, so any layer can attach
 * properties (navigation, caching, mutation methods, etc.) without
 * replacing the carrier identity.
 */
export function makeCarrier(): HasRead {
  const carrier: any = function (this: any, ...args: unknown[]): unknown {
    return carrier[READ](...args)
  }

  carrier[READ] = (): unknown => {
    throw new Error(
      "No reader configured — compose with withReadable to enable reading",
    )
  }

  return carrier as HasRead
}

// ---------------------------------------------------------------------------
// bottomInterpreter — the universal foundation
// ---------------------------------------------------------------------------

/**
 * The bottom interpreter — produces callable function carriers at every
 * schema node. Each carrier's `[READ]` slot throws by default.
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
export const bottomInterpreter: Interpreter<unknown, HasRead> = {
  scalar(
    _ctx: unknown,
    _path: Path,
    _schema: ScalarSchema,
  ): HasRead {
    return makeCarrier()
  },

  product(
    _ctx: unknown,
    _path: Path,
    _schema: ProductSchema,
    _fields: Readonly<Record<string, () => HasRead>>,
  ): HasRead {
    // Field thunks are intentionally ignored — bottom produces inert
    // carriers. `withReadable` / `withCaching` will use the thunks
    // to build navigation and caching.
    return makeCarrier()
  },

  sequence(
    _ctx: unknown,
    _path: Path,
    _schema: SequenceSchema,
    _item: (index: number) => HasRead,
  ): HasRead {
    return makeCarrier()
  },

  map(
    _ctx: unknown,
    _path: Path,
    _schema: MapSchema,
    _item: (key: string) => HasRead,
  ): HasRead {
    return makeCarrier()
  },

  sum(
    _ctx: unknown,
    _path: Path,
    _schema: SumSchema,
    _variants: SumVariants<HasRead>,
  ): HasRead {
    return makeCarrier()
  },

  annotated(
    _ctx: unknown,
    _path: Path,
    _schema: AnnotatedSchema,
    inner: (() => HasRead) | undefined,
  ): HasRead {
    // Annotated nodes with an inner schema delegate to the inner
    // interpretation. This matches the convention used by all other
    // interpreters — the annotation wrapper is transparent at the
    // carrier level.
    if (inner !== undefined) {
      return inner()
    }
    // Leaf annotations (no inner schema) get their own carrier.
    return makeCarrier()
  },
}