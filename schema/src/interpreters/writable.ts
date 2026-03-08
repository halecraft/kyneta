// Writable interpreter — produces ref-like objects at each schema node.
//
// This interpreter targets a **plain JS object store** as the backend,
// proving the architecture is backend-independent. It validates:
//
// 1. Context accumulation — store path derived from catamorphism's Path
// 2. Product nodes — Object.defineProperty lazy getters (no Proxy)
// 3. Namespace isolation — string keys for schema, symbols for protocol
// 4. Annotated nodes — text gets .insert/.delete, counter gets .increment
// 5. Scalar nodes — .get()/.set() with upward reference to parent
// 6. Sequence nodes — .get(i)/.push()/.insert()/.delete()/.length
// 7. Map nodes — Proxy for dynamic keys
// 8. Action dispatch — auto-commit vs batched mode
// 9. Portable refs — refs carry their context as closures

import type { Interpreter, Path, PathSegment, SumVariants } from "../interpret.js"
import type {
  Schema,
  ScalarKind,
  ScalarSchema,
  ProductSchema,
  SequenceSchema,
  MapSchema,
  SumSchema,
  AnnotatedSchema,
  PositionalSumSchema,
  DiscriminatedSumSchema,
} from "../schema.js"
import type { ActionBase } from "../action.js"
import {
  textAction,
  sequenceAction,
  mapAction,
  replaceAction,
  incrementAction,
} from "../action.js"
import { FEED } from "../feed.js"
import type { Feed } from "../feed.js"
import { step } from "../step.js"

// ---------------------------------------------------------------------------
// Store — a mutable nested plain JS object
// ---------------------------------------------------------------------------

/**
 * A plain JS object used as the backing store. The writable interpreter
 * reads from and writes to this object, proving no CRDT runtime is needed.
 */
export type Store = Record<string, unknown>

// ---------------------------------------------------------------------------
// Path conversion — catamorphism Path → string[] store path
// ---------------------------------------------------------------------------

/**
 * Converts the catamorphism's typed Path into a flat string[] for store
 * access. Index segments become their string representation.
 */
function toStorePath(path: Path): readonly string[] {
  return path.map((seg) =>
    seg.type === "key" ? seg.key : String(seg.index),
  )
}

// ---------------------------------------------------------------------------
// WritableContext — shared state flowing through the tree
// ---------------------------------------------------------------------------

/**
 * The context shared across the entire interpreted tree. Unlike the
 * catamorphism's `path` parameter (which narrows automatically), the
 * context carries resources that are the *same* at every level:
 *
 * - `store` — the root mutable store object
 * - `dispatch` — sends an action to the store (applies via step, notifies)
 * - `autoCommit` — if true, each mutation dispatches immediately;
 *   if false, actions accumulate in `pending` until flushed
 * - `pending` — accumulated actions in batched mode (shared by reference)
 * - `subscribers` — per-path subscriber sets (shared by reference)
 *
 * The "where am I" information comes from the catamorphism's `path`
 * parameter, not from the context. This means the context doesn't need
 * to be re-derived at each level — it's the same object throughout.
 */
export interface WritableContext {
  readonly store: Store
  readonly dispatch: (storePath: readonly string[], action: ActionBase) => void
  readonly autoCommit: boolean
  readonly pending: PendingAction[]
  readonly subscribers: Map<string, Set<(action: ActionBase) => void>>
}

export interface PendingAction {
  readonly path: readonly string[]
  readonly action: ActionBase
}

// ---------------------------------------------------------------------------
// Store helpers — read/write by path
// ---------------------------------------------------------------------------

function readByPath(store: Store, path: readonly string[]): unknown {
  let current: unknown = store
  for (const key of path) {
    if (current === null || current === undefined) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function writeByPath(
  store: Store,
  path: readonly string[],
  value: unknown,
): void {
  if (path.length === 0) return
  let current: Record<string, unknown> = store
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!
    if (
      current[key] === null ||
      current[key] === undefined ||
      typeof current[key] !== "object"
    ) {
      current[key] = {}
    }
    current = current[key] as Record<string, unknown>
  }
  current[path[path.length - 1]!] = value
}

function applyActionToStore(
  store: Store,
  path: readonly string[],
  action: ActionBase,
): void {
  if (path.length === 0) {
    // Root-level action — apply step to the store itself and merge back
    const next = step(store as Record<string, unknown>, action)
    if (next !== null && next !== undefined && typeof next === "object") {
      // Merge result keys into the store (preserving the store reference)
      const nextObj = next as Record<string, unknown>
      for (const key of Object.keys(nextObj)) {
        store[key] = nextObj[key]
      }
      // Remove keys that were deleted
      for (const key of Object.keys(store)) {
        if (!(key in nextObj)) {
          delete store[key]
        }
      }
    }
    return
  }
  const current = readByPath(store, path)
  const next = step(current, action)
  writeByPath(store, path, next)
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
  const pending: PendingAction[] = []
  const subscribers = new Map<string, Set<(action: ActionBase) => void>>()

  const dispatch = (
    storePath: readonly string[],
    action: ActionBase,
  ): void => {
    if (autoCommit) {
      applyActionToStore(store, storePath, action)
      notifySubscribers(subscribers, storePath, action)
    } else {
      pending.push({ path: storePath, action })
    }
  }

  return {
    store,
    dispatch,
    autoCommit,
    pending,
    subscribers,
  }
}

/**
 * Flushes all pending actions in a batched context.
 * Returns the list of actions that were flushed.
 */
export function flush(ctx: WritableContext): PendingAction[] {
  const flushed = [...ctx.pending]
  for (const { path, action } of flushed) {
    applyActionToStore(ctx.store, path, action)
    notifySubscribers(ctx.subscribers, path, action)
  }
  ctx.pending.length = 0
  return flushed
}

// ---------------------------------------------------------------------------
// Subscriber notification
// ---------------------------------------------------------------------------

function pathKey(path: readonly string[]): string {
  return path.join("\0")
}

function notifySubscribers(
  subscribers: Map<string, Set<(action: ActionBase) => void>>,
  path: readonly string[],
  action: ActionBase,
): void {
  const key = pathKey(path)
  const subs = subscribers.get(key)
  if (subs) {
    for (const cb of subs) {
      cb(action)
    }
  }
}

function subscribeToPath(
  ctx: WritableContext,
  storePath: readonly string[],
  callback: (action: ActionBase) => void,
): () => void {
  const key = pathKey(storePath)
  let subs = ctx.subscribers.get(key)
  if (!subs) {
    subs = new Set()
    ctx.subscribers.set(key, subs)
  }
  subs.add(callback)
  return () => {
    subs!.delete(callback)
    if (subs!.size === 0) {
      ctx.subscribers.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------
// Feed creation helper
// ---------------------------------------------------------------------------

function createFeedForPath(
  ctx: WritableContext,
  storePath: readonly string[],
  readHead: () => unknown,
): Feed<unknown, ActionBase> {
  return {
    get head() {
      return readHead()
    },
    subscribe(callback: (action: ActionBase) => void): () => void {
      return subscribeToPath(ctx, storePath, callback)
    },
  }
}

// ---------------------------------------------------------------------------
// Attach [FEED] non-enumerably to any object
// ---------------------------------------------------------------------------

function attachFeed(
  target: object,
  feed: Feed<unknown, ActionBase>,
): void {
  Object.defineProperty(target, FEED, {
    value: feed,
    enumerable: false,
    configurable: false,
    writable: false,
  })
}

// ---------------------------------------------------------------------------
// Ref types — the objects produced by the writable interpreter
// ---------------------------------------------------------------------------

export interface ScalarRef<T = unknown> {
  get(): T
  set(value: T): void
}

export interface TextRef {
  toString(): string
  get(): string
  insert(index: number, content: string): void
  delete(index: number, length: number): void
  update(content: string): void
}

export interface CounterRef {
  get(): number
  increment(n?: number): void
  decrement(n?: number): void
}

export interface SequenceRef<T = unknown> {
  get(index: number): T
  push(...items: unknown[]): void
  insert(index: number, ...items: unknown[]): void
  delete(index: number, count?: number): void
  readonly length: number
  [Symbol.iterator](): Iterator<T>
  toArray(): unknown[]
}

// ---------------------------------------------------------------------------
// Writable<S> — type-level interpretation from schema type to ref type
// ---------------------------------------------------------------------------

/**
 * Maps a ScalarKind literal to the corresponding TypeScript plain type.
 */
export type ScalarPlain<K extends ScalarKind> =
  K extends "string" ? string
  : K extends "number" ? number
  : K extends "boolean" ? boolean
  : K extends "null" ? null
  : K extends "undefined" ? undefined
  : K extends "bytes" ? Uint8Array
  : K extends "any" ? unknown
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
 *   title: Schema.text(),
 *   count: Schema.counter(),
 *   settings: Schema.struct({
 *     darkMode: Schema.plain.boolean(),
 *   }),
 * })
 *
 * type Doc = Writable<typeof s>
 * // = { title: TextRef; count: CounterRef; settings: { darkMode: ScalarRef<boolean> } }
 * ```
 */
export type Writable<S extends Schema> =
  // --- Annotated: dispatch on tag ---
  S extends AnnotatedSchema<infer Tag, infer Inner>
    ? Tag extends "text" ? TextRef
    : Tag extends "counter" ? CounterRef
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
    // Unknown annotation with inner — delegate
    : Inner extends Schema
      ? Writable<Inner>
      : unknown
  // --- Scalar ---
  : S extends ScalarSchema<infer K>
    ? ScalarRef<ScalarPlain<K>>
  // --- Product ---
  : S extends ProductSchema<infer F>
    ? { readonly [K in keyof F]: Writable<F[K]> }
  // --- Sequence ---
  : S extends SequenceSchema<infer I>
    ? SequenceRef<Writable<I>>
  // --- Map ---
  : S extends MapSchema<infer I>
    ? { readonly [key: string]: Writable<I> }
  // --- Sum ---
  : S extends PositionalSumSchema
    ? unknown
  : S extends DiscriminatedSumSchema
    ? unknown
  : unknown

// ---------------------------------------------------------------------------
// Specialized ref factories
// ---------------------------------------------------------------------------

function createTextRef(
  ctx: WritableContext,
  storePath: readonly string[],
): TextRef {
  const ref: TextRef = {
    toString(): string {
      const v = readByPath(ctx.store, storePath)
      return typeof v === "string" ? v : String(v ?? "")
    },

    get(): string {
      return ref.toString()
    },

    insert(index: number, content: string): void {
      ctx.dispatch(
        storePath,
        textAction([
          ...(index > 0 ? [{ retain: index }] : []),
          { insert: content },
        ]),
      )
    },

    delete(index: number, length: number): void {
      ctx.dispatch(
        storePath,
        textAction([
          ...(index > 0 ? [{ retain: index }] : []),
          { delete: length },
        ]),
      )
    },

    update(content: string): void {
      const current = ref.toString()
      ctx.dispatch(
        storePath,
        textAction([
          ...(current.length > 0 ? [{ delete: current.length }] : []),
          { insert: content },
        ]),
      )
    },
  }

  attachFeed(
    ref,
    createFeedForPath(ctx, storePath, () => ref.toString()),
  )

  return ref
}

function createCounterRef(
  ctx: WritableContext,
  storePath: readonly string[],
): CounterRef {
  const ref: CounterRef = {
    get(): number {
      const v = readByPath(ctx.store, storePath)
      return typeof v === "number" ? v : 0
    },

    increment(n: number = 1): void {
      ctx.dispatch(storePath, incrementAction(n))
    },

    decrement(n: number = 1): void {
      ctx.dispatch(storePath, incrementAction(-n))
    },
  }

  attachFeed(
    ref,
    createFeedForPath(ctx, storePath, () => ref.get()),
  )

  return ref
}

function createScalarRef(
  ctx: WritableContext,
  storePath: readonly string[],
): ScalarRef {
  const parentPath = storePath.slice(0, -1)
  const key = storePath[storePath.length - 1]

  const ref: ScalarRef = {
    get(): unknown {
      return readByPath(ctx.store, storePath)
    },
    set(value: unknown): void {
      if (key !== undefined) {
        // Upward reference: dispatch MapAction to parent
        ctx.dispatch(parentPath, mapAction({ [key]: value }))
      } else {
        // Root scalar — use replace
        ctx.dispatch(storePath, replaceAction(value))
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
 * plain JS object store. Demonstrates:
 *
 * - Context accumulation (store path derived from catamorphism's Path)
 * - Object.defineProperty for products (no Proxy)
 * - Proxy for maps (dynamic keys)
 * - Namespace isolation (FEED is symbol-keyed, non-enumerable)
 * - Action dispatch with auto-commit and batched modes
 * - Portable refs (carry context as closures)
 *
 * The store path is computed from the catamorphism's `path` parameter,
 * so the `WritableContext` is the *same object* at every tree level.
 * No context re-derivation needed — the catamorphism handles the
 * structural descent.
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
  // reference" case — the scalar dispatches a MapAction to its parent.

  scalar(
    ctx: WritableContext,
    path: Path,
    _schema: ScalarSchema,
  ): ScalarRef {
    return createScalarRef(ctx, toStorePath(path))
  },

  // --- Product ---------------------------------------------------------------
  // Fixed keys → Object.defineProperty with lazy getters. No Proxy.
  // [FEED] symbol attached non-enumerably for namespace isolation.

  product(
    ctx: WritableContext,
    path: Path,
    _schema: ProductSchema,
    fields: Readonly<Record<string, () => unknown>>,
  ): unknown {
    const result: Record<string | symbol, unknown> = {}
    const storePath = toStorePath(path)

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

    // Attach [FEED] non-enumerably for namespace isolation
    attachFeed(
      result,
      createFeedForPath(ctx, storePath, () =>
        readByPath(ctx.store, storePath),
      ),
    )

    return result
  },

  // --- Sequence --------------------------------------------------------------
  // .get(i) returns a child ref. .push/.insert/.delete dispatch actions.

  sequence(
    ctx: WritableContext,
    path: Path,
    _schema: SequenceSchema,
    item: (index: number) => unknown,
  ): SequenceRef {
    const storePath = toStorePath(path)
    const childCache = new Map<number, unknown>()

    const ref: SequenceRef = {
      get(index: number): unknown {
        if (!childCache.has(index)) {
          childCache.set(index, item(index))
        }
        return childCache.get(index)
      },

      push(...items: unknown[]): void {
        const arr = readByPath(ctx.store, storePath)
        const length = Array.isArray(arr) ? arr.length : 0
        ctx.dispatch(
          storePath,
          sequenceAction([{ retain: length }, { insert: items }]),
        )
        childCache.clear()
      },

      insert(index: number, ...items: unknown[]): void {
        ctx.dispatch(
          storePath,
          sequenceAction([
            ...(index > 0 ? [{ retain: index }] : []),
            { insert: items },
          ]),
        )
        childCache.clear()
      },

      delete(index: number, count: number = 1): void {
        ctx.dispatch(
          storePath,
          sequenceAction([
            ...(index > 0 ? [{ retain: index }] : []),
            { delete: count },
          ]),
        )
        childCache.clear()
      },

      get length(): number {
        const arr = readByPath(ctx.store, storePath)
        return Array.isArray(arr) ? arr.length : 0
      },

      [Symbol.iterator](): Iterator<unknown> {
        const arr = readByPath(ctx.store, storePath)
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
        const arr = readByPath(ctx.store, storePath)
        if (!Array.isArray(arr)) return []
        return arr.map((_item, i) => ref.get(i))
      },
    }

    attachFeed(
      ref,
      createFeedForPath(ctx, storePath, () =>
        readByPath(ctx.store, storePath),
      ),
    )

    return ref
  },

  // --- Map -------------------------------------------------------------------
  // Dynamic keys → Proxy. The one case where Proxy is necessary.
  // String keys map to child refs; symbols (FEED) go to the base object.

  map(
    ctx: WritableContext,
    path: Path,
    _schema: MapSchema,
    item: (key: string) => unknown,
  ): unknown {
    const storePath = toStorePath(path)
    const childCache = new Map<string, unknown>()

    // Base object holds symbol-keyed protocol
    const base: Record<string | symbol, unknown> = {}

    attachFeed(
      base,
      createFeedForPath(ctx, storePath, () =>
        readByPath(ctx.store, storePath),
      ),
    )

    return new Proxy(base, {
      get(_target, prop, _receiver) {
        // Symbol access → base object (protocol)
        if (typeof prop === "symbol") {
          return base[prop]
        }

        // String access → child ref (data)
        if (!childCache.has(prop)) {
          childCache.set(prop, item(prop))
        }
        return childCache.get(prop)
      },

      has(_target, prop) {
        // Symbol access → check base (protocol)
        if (typeof prop === "symbol") {
          return prop in base
        }
        // String access → check store data
        const obj = readByPath(ctx.store, storePath)
        if (obj !== null && obj !== undefined && typeof obj === "object") {
          return prop in (obj as Record<string, unknown>)
        }
        return false
      },

      ownKeys(_target) {
        // Must include non-configurable symbol keys from the base
        // (the Proxy invariant requires this).
        const symbolKeys = Object.getOwnPropertySymbols(base)
        const obj = readByPath(ctx.store, storePath)
        if (obj !== null && obj !== undefined && typeof obj === "object") {
          return [...Object.keys(obj as Record<string, unknown>), ...symbolKeys]
        }
        return [...symbolKeys]
      },

      getOwnPropertyDescriptor(_target, prop) {
        if (typeof prop === "symbol") {
          return Object.getOwnPropertyDescriptor(base, prop)
        }
        const obj = readByPath(ctx.store, storePath)
        if (obj !== null && obj !== undefined && typeof obj === "object") {
          if (prop in (obj as Record<string, unknown>)) {
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

      set(_target, prop, value) {
        if (typeof prop === "symbol") return false
        ctx.dispatch(storePath, mapAction({ [String(prop)]: value }))
        childCache.delete(prop)
        return true
      },

      deleteProperty(_target, prop) {
        if (typeof prop === "symbol") return false
        ctx.dispatch(storePath, mapAction(undefined, [String(prop)]))
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
    const storePath = toStorePath(path)

    switch (schema.tag) {
      case "text":
        return createTextRef(ctx, storePath)

      case "counter":
        return createCounterRef(ctx, storePath)

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
        return createScalarRef(ctx, storePath)
    }
  },
}