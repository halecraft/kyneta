// Writable interpreter — produces ref-like objects at each schema node.
//
// This interpreter targets a **plain JS object store** as the backend,
// proving the architecture is backend-independent. It validates:
//
// 1. Context accumulation — store path derived from catamorphism's Path
// 2. Product nodes — Object.defineProperty lazy getters (no Proxy)
// 3. Namespace isolation — string keys for schema, no symbol protocol
// 4. Annotated nodes — text gets .insert/.delete, counter gets .increment
// 5. Scalar nodes — .get()/.set() with upward reference to parent
// 6. Sequence nodes — .get(i)/.push()/.insert()/.delete()/.length
// 7. Map nodes — Proxy for dynamic keys
// 8. Change dispatch — auto-commit vs batched mode
// 9. Portable refs — refs carry their context as closures
//
// Changefeed attachment ([CHANGEFEED] symbol) is NOT part of this interpreter.
// It is an orthogonal observation concern provided by the `withChangefeed`
// decorator via `enrich(writableInterpreter, withChangefeed)`.
// See `with-changefeed.ts` and theory §5.4 (capability decomposition).

import type { Interpreter, Path, SumVariants } from "../interpret.js"
import type {
  Schema,
  ScalarKind,
  ScalarSchema,
  ScalarPlain,
  ProductSchema,
  SequenceSchema,
  MapSchema,
  SumSchema,
  AnnotatedSchema,
  PositionalSumSchema,
  DiscriminatedSumSchema,
} from "../schema.js"
import type { ChangeBase } from "../change.js"
import {
  textChange,
  sequenceChange,
  mapChange,
  replaceChange,
  incrementChange,
} from "../change.js"
import {
  type Store,
  readByPath,
  applyChangeToStore,
} from "../store.js"
import { isNonNullObject } from "../guards.js"

// Re-export store utilities for backward compatibility
export { type Store, readByPath, writeByPath, applyChangeToStore } from "../store.js"

// ---------------------------------------------------------------------------
// WritableContext — shared state flowing through the tree
// ---------------------------------------------------------------------------

/**
 * The context shared across the entire interpreted tree. Unlike the
 * catamorphism's `path` parameter (which narrows automatically), the
 * context carries resources that are the *same* at every level:
 *
 * - `store` — the root mutable store object
 * - `dispatch` — sends a change to the store (applies via step)
 * - `autoCommit` — if true, each mutation dispatches immediately;
 *   if false, changes accumulate in `pending` until flushed
 * - `pending` — accumulated changes in batched mode (shared by reference)
 *
 * The "where am I" information comes from the catamorphism's `path`
 * parameter, not from the context. This means the context doesn't need
 * to be re-derived at each level — it's the same object throughout.
 *
 * **No observation infrastructure here.** Subscriber notification is
 * provided by the changefeed layer (`createChangefeedContext`) which wraps
 * `dispatch` to add notification after each change is applied.
 */
export interface WritableContext {
  readonly store: Store
  readonly dispatch: (path: Path, change: ChangeBase) => void
  readonly autoCommit: boolean
  readonly pending: PendingChange[]
}

export interface PendingChange {
  readonly path: Path
  readonly change: ChangeBase
}

// ---------------------------------------------------------------------------
// createWritableContext — factory for the root context
// ---------------------------------------------------------------------------

export interface WritableOptions {
  autoCommit?: boolean
}

/**
 * Creates a root WritableContext for a given store.
 *
 * Dispatch only applies changes to the store — no subscriber
 * notification. For observation, wrap with `createChangefeedContext`.
 *
 * ```ts
 * const store = { title: "", count: 0, items: [] }
 * const ctx = createWritableContext(store)
 * const doc = interpret(schema, writableInterpreter, ctx)
 * ```
 */
export function createWritableContext(
  store: Store,
  options: WritableOptions = {},
): WritableContext {
  const autoCommit = options.autoCommit ?? true
  const pending: PendingChange[] = []

  const dispatch = (path: Path, change: ChangeBase): void => {
    if (autoCommit) {
      applyChangeToStore(store, path, change)
    } else {
      pending.push({ path, change })
    }
  }

  return {
    store,
    dispatch,
    autoCommit,
    pending,
  }
}

/**
 * Flushes all pending changes in a batched context.
 * Applies each change to the store but does NOT notify subscribers.
 * For notification, use the feedable context's flush wrapper.
 *
 * Returns the list of changes that were flushed.
 */
export function flush(ctx: WritableContext): PendingChange[] {
  const flushed = [...ctx.pending]
  for (const { path, change } of flushed) {
    applyChangeToStore(ctx.store, path, change)
  }
  ctx.pending.length = 0
  return flushed
}

// ---------------------------------------------------------------------------
// Ref types — the objects produced by the writable interpreter
// ---------------------------------------------------------------------------

export interface ScalarRef<T = unknown> {
  get: () => T
  set: (value: T) => void
}

export interface TextRef {
  toString: () => string
  get: () => string
  insert: (index: number, content: string) => void
  delete: (index: number, length: number) => void
  update: (content: string) => void
}

export interface CounterRef {
  get: () => number
  increment: (n?: number) => void
  decrement: (n?: number) => void
}

export interface SequenceRef<T = unknown> {
  get: (index: number) => T
  push: (...items: unknown[]) => void
  insert: (index: number, ...items: unknown[]) => void
  delete: (index: number, count?: number) => void
  readonly length: number
  [Symbol.iterator](): Iterator<T>
  toArray: () => unknown[]
}

// ---------------------------------------------------------------------------
// Type-level interpretations — schema type → TypeScript type
// ---------------------------------------------------------------------------

// ScalarPlain is re-exported from schema.ts (the canonical definition).
// It maps ScalarKind literals to their corresponding TypeScript types.
export type { ScalarPlain } from "../schema.js"

// ---------------------------------------------------------------------------
// Plain<S> — type-level interpretation from schema type to plain JS type
// ---------------------------------------------------------------------------

/**
 * Computes the plain JavaScript/JSON type for a given schema type.
 *
 * This is the type-level counterpart to `Writable<S>`: where `Writable`
 * maps schema nodes to ref types (TextRef, CounterRef, etc.), `Plain`
 * maps them to bare JavaScript values (string, number, arrays, objects).
 *
 * Use `Plain<S>` for `toJSON()` return types, serialization boundaries,
 * snapshot types, and anywhere you need the "just data" shape of a schema.
 *
 * ```ts
 * const s = Schema.doc({
 *   title: Schema.string(),
 *   count: Schema.number(),
 *   items: Schema.list(Schema.struct({
 *     name: Schema.string(),
 *     done: Schema.boolean(),
 *   })),
 *   settings: Schema.struct({
 *     darkMode: Schema.boolean(),
 *   }),
 *   metadata: Schema.record(Schema.any()),
 * })
 *
 * type Doc = Plain<typeof s>
 * // = {
 * //     title: string
 * //     count: number
 * //     items: { name: string; done: boolean }[]
 * //     settings: { darkMode: boolean }
 * //     metadata: { [key: string]: unknown }
 * //   }
 * ```
 */
export type Plain<S extends Schema> =
  // --- Annotated: dispatch on tag ---
  S extends AnnotatedSchema<infer Tag, infer Inner>
    ? Tag extends "text"
      ? string
      : Tag extends "counter"
        ? number
        : Tag extends "doc"
          ? Inner extends ProductSchema<infer F>
            ? { [K in keyof F]: Plain<F[K]> }
            : unknown
          : Tag extends "movable"
            ? Inner extends SequenceSchema<infer I>
              ? Plain<I>[]
              : unknown
            : Tag extends "tree"
              ? Inner extends Schema
                ? Plain<Inner>
                : unknown
              : // Unknown annotation with inner — delegate
                Inner extends Schema
                ? Plain<Inner>
                : unknown
    : // --- Scalar ---
      S extends ScalarSchema<infer _K, infer V>
      ? V
      : // --- Product ---
        S extends ProductSchema<infer F>
        ? { [K in keyof F]: Plain<F[K]> }
        : // --- Sequence ---
          S extends SequenceSchema<infer I>
          ? Plain<I>[]
          : // --- Map ---
            S extends MapSchema<infer I>
            ? { [key: string]: Plain<I> }
            : // --- Sum ---
              S extends PositionalSumSchema<infer V>
              ? Plain<V[number]>
              : S extends DiscriminatedSumSchema<infer D, infer M>
                ? { [K in keyof M]: Plain<M[K]> & { [_ in D]: K } }[keyof M]
                : unknown

/**
 * Computes the writable ref type for a given schema type.
 *
 * This is the type-level catamorphism: it recursively maps schema nodes
 * to their corresponding ref types, so that `interpret(schema, writableInterpreter, ctx)`
 * produces a fully typed result without any casts.
 *
 * ```ts
 * const s = Schema.doc({
 *   title: Schema.string(),
 *   count: Schema.number(),
 *   settings: Schema.struct({
 *     darkMode: Schema.boolean(),
 *   }),
 * })
 *
 * type Doc = Writable<typeof s>
 * // = { title: ScalarRef<string>; count: ScalarRef<number>; settings: { darkMode: ScalarRef<boolean> } }
 * ```
 */
export type Writable<S extends Schema> =
  // --- Annotated: dispatch on tag ---
  S extends AnnotatedSchema<infer Tag, infer Inner>
    ? Tag extends "text"
      ? TextRef
      : Tag extends "counter"
        ? CounterRef
        : Tag extends "doc"
          ? Inner extends ProductSchema<infer F>
            ? { readonly [K in keyof F]: Writable<F[K]> }
            : unknown
          : Tag extends "movable"
            ? Inner extends SequenceSchema<infer I>
              ? SequenceRef<Writable<I>>
              : unknown
            : Tag extends "tree"
              ? Inner extends Schema
                ? Writable<Inner>
                : unknown
              : // Unknown annotation with inner — delegate
                Inner extends Schema
                ? Writable<Inner>
                : unknown
    : // --- Scalar ---
      S extends ScalarSchema<infer _K, infer V>
      ? ScalarRef<V>
      : // --- Product ---
        S extends ProductSchema<infer F>
        ? { readonly [K in keyof F]: Writable<F[K]> }
        : // --- Sequence ---
          S extends SequenceSchema<infer I>
          ? SequenceRef<Writable<I>>
          : // --- Map ---
            S extends MapSchema<infer I>
            ? { readonly [key: string]: Writable<I> }
            : // --- Sum ---
              S extends PositionalSumSchema
              ? unknown
              : S extends DiscriminatedSumSchema
                ? unknown
                : unknown

// ---------------------------------------------------------------------------
// Specialized ref factories
// ---------------------------------------------------------------------------

function createTextRef(ctx: WritableContext, path: Path): TextRef {
  const ref: TextRef = {
    toString(): string {
      const v = readByPath(ctx.store, path)
      return typeof v === "string" ? v : String(v ?? "")
    },

    get(): string {
      return ref.toString()
    },

    insert(index: number, content: string): void {
      ctx.dispatch(
        path,
        textChange([
          ...(index > 0 ? [{ retain: index }] : []),
          { insert: content },
        ]),
      )
    },

    delete(index: number, length: number): void {
      ctx.dispatch(
        path,
        textChange([
          ...(index > 0 ? [{ retain: index }] : []),
          { delete: length },
        ]),
      )
    },

    update(content: string): void {
      const current = ref.toString()
      ctx.dispatch(
        path,
        textChange([
          ...(current.length > 0 ? [{ delete: current.length }] : []),
          { insert: content },
        ]),
      )
    },
  }

  return ref
}

function createCounterRef(ctx: WritableContext, path: Path): CounterRef {
  const ref: CounterRef = {
    get(): number {
      const v = readByPath(ctx.store, path)
      return typeof v === "number" ? v : 0
    },

    increment(n: number = 1): void {
      ctx.dispatch(path, incrementChange(n))
    },

    decrement(n: number = 1): void {
      ctx.dispatch(path, incrementChange(-n))
    },
  }

  return ref
}

function createScalarRef(ctx: WritableContext, path: Path): ScalarRef {
  const parentPath = path.slice(0, -1)
  const lastSeg = path[path.length - 1]
  const key =
    lastSeg !== undefined
      ? lastSeg.type === "key"
        ? lastSeg.key
        : String(lastSeg.index)
      : undefined

  const ref: ScalarRef = {
    get(): unknown {
      return readByPath(ctx.store, path)
    },
    set(value: unknown): void {
      if (key !== undefined) {
        // Upward reference: dispatch MapChange to parent
        ctx.dispatch(parentPath, mapChange({ [key]: value }))
      } else {
        // Root scalar — use replace
        ctx.dispatch(path, replaceChange(value))
      }
    },
  }

  return ref
}

// ---------------------------------------------------------------------------
// Writable interpreter
// ---------------------------------------------------------------------------

/**
 * A writable interpreter that produces ref-like objects backed by a
 * plain JS object store. Produces the **mutation surface** only.
 *
 * For observation (changefeeds), use `enrich(writableInterpreter, withChangefeed)`
 * with a `ChangefeedContext`.
 *
 * - Context accumulation (store path derived from catamorphism's Path)
 * - Object.defineProperty for products (no Proxy)
 * - Proxy for maps (dynamic keys)
 * - Change dispatch with auto-commit and batched modes
 * - Portable refs (carry context as closures)
 *
 * ```ts
 * const store = { title: "", count: 0, items: [] }
 * const ctx = createWritableContext(store)
 * const doc = interpret(schema, writableInterpreter, ctx)
 * doc.title.insert(0, "Hello")   // store.title === "Hello"
 * doc.count.increment(5)         // store.count === 5
 * ```
 */
export const writableInterpreter: Interpreter<WritableContext, unknown> = {
  // --- Scalar ----------------------------------------------------------------
  // Bare scalars (unannotated) get .get()/.set(). This is the "upward
  // reference" case — the scalar dispatches a MapChange to its parent.

  scalar(ctx: WritableContext, path: Path, _schema: ScalarSchema): ScalarRef {
    return createScalarRef(ctx, path)
  },

  // --- Product ---------------------------------------------------------------
  // Fixed keys → Object.defineProperty with lazy getters. No Proxy.

  product(
    ctx: WritableContext,
    path: Path,
    _schema: ProductSchema,
    fields: Readonly<Record<string, () => unknown>>,
  ): unknown {
    const result: Record<string | symbol, unknown> = {}

    // Define lazy getters for each schema field — cache on first access
    for (const [key, thunk] of Object.entries(fields)) {
      let cached: unknown = undefined
      let resolved = false

      Object.defineProperty(result, key, {
        get() {
          if (!resolved) {
            cached = thunk()
            resolved = true
          }
          return cached
        },
        enumerable: true,
        configurable: true,
      })
    }

    return result
  },

  // --- Sequence --------------------------------------------------------------
  // .get(i) returns a child ref. .push/.insert/.delete dispatch changes.

  sequence(
    ctx: WritableContext,
    path: Path,
    _schema: SequenceSchema,
    item: (index: number) => unknown,
  ): SequenceRef {
    const childCache = new Map<number, unknown>()

    const ref: SequenceRef = {
      get(index: number): unknown {
        if (!childCache.has(index)) {
          childCache.set(index, item(index))
        }
        return childCache.get(index)
      },

      push(...items: unknown[]): void {
        const arr = readByPath(ctx.store, path)
        const length = Array.isArray(arr) ? arr.length : 0
        ctx.dispatch(
          path,
          sequenceChange([{ retain: length }, { insert: items }]),
        )
        childCache.clear()
      },

      insert(index: number, ...items: unknown[]): void {
        ctx.dispatch(
          path,
          sequenceChange([
            ...(index > 0 ? [{ retain: index }] : []),
            { insert: items },
          ]),
        )
        childCache.clear()
      },

      delete(index: number, count: number = 1): void {
        ctx.dispatch(
          path,
          sequenceChange([
            ...(index > 0 ? [{ retain: index }] : []),
            { delete: count },
          ]),
        )
        childCache.clear()
      },

      get length(): number {
        const arr = readByPath(ctx.store, path)
        return Array.isArray(arr) ? arr.length : 0
      },

      [Symbol.iterator](): Iterator<unknown> {
        const arr = readByPath(ctx.store, path)
        const items = Array.isArray(arr) ? arr : []
        let i = 0
        return {
          next(): IteratorResult<unknown> {
            if (i < items.length) {
              return { value: ref.get(i++), done: false }
            }
            return { value: undefined, done: true }
          },
        }
      },

      toArray(): unknown[] {
        const arr = readByPath(ctx.store, path)
        if (!Array.isArray(arr)) return []
        return arr.map((_item, i) => ref.get(i))
      },
    }

    return ref
  },

  // --- Map -------------------------------------------------------------------
  // Dynamic keys → Proxy. The one case where Proxy is necessary.
  // String keys map to child refs; symbols are forwarded to the target
  // (allowing decorators to attach protocol via Object.defineProperty).

  map(
    ctx: WritableContext,
    path: Path,
    _schema: MapSchema,
    item: (key: string) => unknown,
  ): unknown {
    const childCache = new Map<string, unknown>()

    // Target object — symbol-keyed protocol will be attached here
    // by decorators (e.g. withChangefeed) via Object.defineProperty.
    const target: Record<string | symbol, unknown> = {}

    return new Proxy(target, {
      get(_target, prop, _receiver) {
        // Symbol access → target object (protocol attached by decorators)
        if (typeof prop === "symbol") {
          return target[prop]
        }

        // String access → child ref (data)
        if (!childCache.has(prop)) {
          childCache.set(prop, item(prop))
        }
        return childCache.get(prop)
      },

      has(_target, prop) {
        // Symbol access → check target (protocol)
        if (typeof prop === "symbol") {
          return prop in target
        }
        // String access → check store data
        const obj = readByPath(ctx.store, path)
        if (isNonNullObject(obj)) {
          return prop in obj
        }
        return false
      },

      ownKeys(_target) {
        // Include symbol keys from target (protocol attached by decorators)
        const symbolKeys = Object.getOwnPropertySymbols(target)
        const obj = readByPath(ctx.store, path)
        if (isNonNullObject(obj)) {
          return [...Object.keys(obj), ...symbolKeys]
        }
        return [...symbolKeys]
      },

      getOwnPropertyDescriptor(_target, prop) {
        if (typeof prop === "symbol") {
          return Object.getOwnPropertyDescriptor(target, prop)
        }
        const obj = readByPath(ctx.store, path)
        if (isNonNullObject(obj)) {
          if (prop in obj) {
            if (!childCache.has(String(prop))) {
              childCache.set(String(prop), item(String(prop)))
            }
            return {
              configurable: true,
              enumerable: true,
              writable: true,
              value: childCache.get(String(prop)),
            }
          }
        }
        return undefined
      },

      // Allow symbol definitions from decorators (e.g. withChangefeed attaching [CHANGEFEED])
      defineProperty(_target, prop, descriptor) {
        if (typeof prop === "symbol") {
          Object.defineProperty(target, prop, descriptor)
          return true
        }
        return false
      },

      set(_target, prop, value) {
        if (typeof prop === "symbol") return false
        ctx.dispatch(path, mapChange({ [String(prop)]: value }))
        childCache.delete(prop)
        return true
      },

      deleteProperty(_target, prop) {
        if (typeof prop === "symbol") return false
        ctx.dispatch(path, mapChange(undefined, [String(prop)]))
        childCache.delete(String(prop))
        return true
      },
    })
  },

  // --- Sum -------------------------------------------------------------------
  // Delegates to the appropriate variant based on runtime value or first
  // variant as fallback.

  sum(
    _ctx: WritableContext,
    _path: Path,
    schema: SumSchema,
    variants: SumVariants<unknown>,
  ): unknown {
    if (schema.discriminant !== undefined && variants.byKey) {
      const keys = Object.keys(
        (schema as { variantMap: Record<string, unknown> }).variantMap,
      )
      if (keys.length > 0) {
        return variants.byKey(keys[0]!)
      }
    }
    if (variants.byIndex) {
      return variants.byIndex(0)
    }
    return undefined
  },

  // --- Annotated -------------------------------------------------------------
  // Dispatches on annotation tag to produce specialized refs:
  // - "text" → TextRef with .insert/.delete/.update
  // - "counter" → CounterRef with .increment/.decrement
  // - "doc", "movable", "tree" → delegate to inner
  // - unknown → delegate to inner or return scalar ref

  annotated(
    ctx: WritableContext,
    path: Path,
    schema: AnnotatedSchema,
    inner: (() => unknown) | undefined,
  ): unknown {
    switch (schema.tag) {
      case "text":
        return createTextRef(ctx, path)

      case "counter":
        return createCounterRef(ctx, path)

      case "doc":
      case "movable":
      case "tree":
        // These annotations wrap an inner schema — delegate
        if (inner !== undefined) {
          return inner()
        }
        return undefined

      default:
        // Unknown annotation — delegate to inner if present
        if (inner !== undefined) {
          return inner()
        }
        // Leaf annotation without known semantics — treat as scalar
        return createScalarRef(ctx, path)
    }
  },
}
