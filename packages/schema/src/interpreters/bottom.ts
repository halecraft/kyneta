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

import type { ChangeBase } from "../change.js"
import type { Interpreter, Path, SumVariants } from "../interpret.js"
import { INTERPRETER, type RefContext } from "../interpreter-types.js"
import { NATIVE } from "../native.js"
import { POSITION } from "../position.js"
import type {
  CounterSchema,
  MapSchema,
  MovableSequenceSchema,
  ProductSchema,
  RichTextSchema,
  ScalarSchema,
  Schema,
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
export const CALL: unique symbol = Symbol.for("kyneta:call")

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
 * A carrier seen only through the `.at` that an inner layer installed.
 *
 * **Why this needs a name.** Layers describe each other with *phantom brands*
 * — `HasNavigation` marks "structural addressing is available" without saying
 * what that addressing looks like. So when the readable or caching layer wants
 * to call `.at`, which the navigation layer installed further in, the type it
 * has in hand does not carry it. The dependency is real and ordered; it is
 * simply not expressible through a brand.
 *
 * Naming it makes each of those sites state the one member it depends on,
 * rather than reaching for `any` and dropping every other check with it. `K` is
 * `number` for positional carriers and `string` for keyed ones.
 *
 * Making the brands structural would remove these narrowings altogether. It
 * would also mean every layer's return type carrying its full installed
 * surface, which is where the `TS2589` budget would go — see "Where types are
 * lost, and why" in `packages/schema/TECHNICAL.md`.
 */
export type NavigableCarrier<K> = { at: (key: K) => unknown }

/**
 * Strip `readonly` so an installer can fill in the members it is declaring.
 *
 * The surfaces installers attach are declared `readonly` because that is how
 * callers should see them — nobody outside should be reassigning a ref's
 * `.push`. The installer itself has to write them once, and this names that
 * exception rather than reaching for `any`.
 *
 * Deliberately not called `Writable`: that name is taken by the public
 * writable-document ref type, and the two have nothing to do with each other.
 */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * Mark a carrier as navigable.
 *
 * One of three brand markers — see {@link markRead} for why the body is empty.
 * `HasNavigation`'s brand is what lets `withCaching` require navigation as a
 * precondition without describing the navigation surface structurally.
 */
export function markNavigation<T>(
  carrier: T,
): asserts carrier is T & HasNavigation {
  // Intentionally empty — see {@link markRead}.
  void carrier
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
 * Mark a carrier as read-filled.
 *
 * **The empty body is the point.** `HasRead`'s brand is declared but never
 * assigned, so it does not exist at runtime and nothing structural can produce
 * it — `Object.assign` cannot, and neither can anything else. Claiming the
 * brand is therefore a statement about intent, not about the object, and an
 * assertion function with no body says exactly that.
 *
 * Used by `withReadable` once per case, after the `[CALL]` slot is filled. It
 * replaces a `as any` that used to sit at the top of each case and disable
 * checking for the whole body; now only the brand is asserted, and the members
 * being added are checked.
 */
export function markRead<T>(carrier: T): asserts carrier is T & HasRead {
  // Intentionally empty — see above.
  void carrier
}

/**
 * Mark a carrier as cache-enabled.
 *
 * The counterpart to {@link markRead}, and empty for the same reason:
 * `HasCaching` carries a phantom brand that has no runtime existence, so
 * claiming it is a statement of intent rather than a fact about the object.
 * The `[INVALIDATE]` slot it also declares is optional, and is attached
 * separately by `withCaching` where a node actually gets a cache.
 */
export function markCaching<T>(carrier: T): asserts carrier is T & HasCaching {
  // Intentionally empty — see {@link markRead}.
  void carrier
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
// Capability attachment helpers
// ---------------------------------------------------------------------------

function attachNative(
  result: HasCall,
  ctx: Partial<RefContext> | undefined,
  schema: Schema,
  path: Path,
): void {
  if (ctx?.nativeResolver) {
    Object.defineProperty(result, NATIVE, {
      value: ctx.nativeResolver(schema, path),
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }
}

function attachPosition(
  result: HasCall,
  ctx: Partial<RefContext> | undefined,
  schema: TextSchema | RichTextSchema,
  path: Path,
): void {
  if (ctx?.positionResolver) {
    Object.defineProperty(result, POSITION, {
      value: ctx.positionResolver(schema, path),
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }
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
 * The `Ctx` is `Partial<RefContext> | undefined` — bottom needs no context
 * for itself, but it attaches `[NATIVE]` and `[POSITION]` if the context
 * provides the respective resolvers.
 */
export const bottomInterpreter: Interpreter<
  Partial<RefContext> | undefined,
  HasCall
> = {
  [INTERPRETER]: true,

  scalar(
    ctx: Partial<RefContext> | undefined,
    path: Path,
    schema: ScalarSchema,
  ): HasCall {
    const carrier = makeCarrier()
    attachNative(carrier, ctx, schema, path)
    return carrier
  },

  product(
    ctx: Partial<RefContext> | undefined,
    path: Path,
    schema: ProductSchema,
    _fields: Readonly<Record<string, () => HasCall>>,
  ): HasCall {
    // Field thunks are intentionally ignored — bottom produces inert
    // carriers. `withReadable` / `withCaching` will use the thunks
    // to build navigation and caching.
    const carrier = makeCarrier()
    attachNative(carrier, ctx, schema, path)
    return carrier
  },

  sequence(
    ctx: Partial<RefContext> | undefined,
    path: Path,
    schema: SequenceSchema,
    _item: (index: number) => HasCall,
  ): HasCall {
    const carrier = makeCarrier()
    attachNative(carrier, ctx, schema, path)
    return carrier
  },

  map(
    ctx: Partial<RefContext> | undefined,
    path: Path,
    schema: MapSchema,
    _item: (key: string) => HasCall,
  ): HasCall {
    const carrier = makeCarrier()
    attachNative(carrier, ctx, schema, path)
    return carrier
  },

  sum(
    _ctx: Partial<RefContext> | undefined,
    _path: Path,
    _schema: SumSchema,
    _variants: SumVariants<HasCall>,
  ): HasCall {
    // No attachNative: the dispatched variant already carries [NATIVE]
    // from its own interpreter case. A sum has no container of its own;
    // the fallback bare carrier intentionally omits [NATIVE].
    return makeCarrier()
  },

  // --- First-class leaf types -----------------------------------------------
  // Text and counter are leaf types — they get their own carrier.

  text(
    ctx: Partial<RefContext> | undefined,
    path: Path,
    schema: TextSchema,
  ): HasCall {
    const carrier = makeCarrier()
    attachNative(carrier, ctx, schema, path)
    attachPosition(carrier, ctx, schema, path)
    return carrier
  },

  counter(
    ctx: Partial<RefContext> | undefined,
    path: Path,
    schema: CounterSchema,
  ): HasCall {
    const carrier = makeCarrier()
    attachNative(carrier, ctx, schema, path)
    return carrier
  },

  // --- First-class container types ------------------------------------------
  // Set delegates like map; movable delegates like sequence. Tree returns a
  // fresh carrier — the `nodes` thunk produces flat-forest topology
  // (`readonly FlatTreeNode<HasCall>[]`), not a single carrier.

  set(
    ctx: Partial<RefContext> | undefined,
    path: Path,
    schema: SetSchema,
    _item: (key: string) => HasCall,
  ): HasCall {
    const carrier = makeCarrier()
    attachNative(carrier, ctx, schema, path)
    return carrier
  },

  tree(
    ctx: Partial<RefContext> | undefined,
    path: Path,
    schema: TreeSchema,
    _nodes: () => readonly import("../interpret.js").FlatTreeNode<HasCall>[],
  ): HasCall {
    const carrier = makeCarrier()
    attachNative(carrier, ctx, schema, path)
    return carrier
  },

  movable(
    ctx: Partial<RefContext> | undefined,
    path: Path,
    schema: MovableSequenceSchema,
    _item: (index: number) => HasCall,
  ): HasCall {
    const carrier = makeCarrier()
    attachNative(carrier, ctx, schema, path)
    return carrier
  },

  richtext(
    ctx: Partial<RefContext> | undefined,
    path: Path,
    schema: RichTextSchema,
  ): HasCall {
    const carrier = makeCarrier()
    attachNative(carrier, ctx, schema, path)
    attachPosition(carrier, ctx, schema, path)
    return carrier
  },
}
