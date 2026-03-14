// withChangefeed — compositional changefeed interpreter transformer.
//
// This module owns the observation concern. It takes a base interpreter
// that produces refs with WritableContext support and attaches
// [CHANGEFEED] to every node:
//
// - Leaf refs (scalar, text, counter) get a plain Changefeed
// - Composite refs (product, sequence, map) get a ComposedChangefeed
//   with subscribeTree for tree-level observation
//
// Notification flow: the transformer wraps ctx.dispatch at each node
// so that when a change is dispatched at a path, the node's shallow
// subscribers fire. Tree notification propagates via subscription
// composition (children → parent) without any flat subscriber map.
//
// Compose: withChangefeed(withWritable(withCaching(withReadable(bottomInterpreter))))
//
// See .plans/compositional-changefeeds.md §Phase 3d.

import type { ChangeBase } from "../change.js"
import { isSequenceChange } from "../change.js"
import type { Interpreter, Path, SumVariants } from "../interpret.js"
import type {
  ScalarSchema,
  ProductSchema,
  SequenceSchema,
  MapSchema,
  SumSchema,
  AnnotatedSchema,
} from "../schema.js"
import {
  CHANGEFEED,
  hasChangefeed,
  hasComposedChangefeed,
} from "../changefeed.js"
import type {
  Changefeed,
  ComposedChangefeed,
  TreeEvent,
} from "../changefeed.js"
import type { WritableContext } from "./writable.js"
import { readByPath, pathKey } from "../store.js"
import { isPropertyHost } from "../guards.js"
import { READ } from "./bottom.js"

// ---------------------------------------------------------------------------
// Attach [CHANGEFEED] non-enumerably to any object
// ---------------------------------------------------------------------------

/**
 * Attaches a `[CHANGEFEED]` symbol property non-enumerably to `target`.
 * Uses `Object.defineProperty` to bypass Proxy `set` traps on map refs.
 */
export function attachChangefeed(
  target: object,
  cf: Changefeed<unknown, ChangeBase> | ComposedChangefeed<unknown, ChangeBase>,
): void {
  Object.defineProperty(target, CHANGEFEED, {
    value: cf,
    enumerable: false,
    configurable: true,
    writable: false,
  })
}

// ---------------------------------------------------------------------------
// Dispatch wrapping — per-context, idempotent
// ---------------------------------------------------------------------------

// WeakMap ensures a single dispatch wrapper per WritableContext, shared
// across all nodes interpreted with that context.
const contextState = new WeakMap<
  WritableContext,
  {
    listeners: Map<string, Set<(change: ChangeBase) => void>>
    originalDispatch: (path: Path, change: ChangeBase) => void
  }
>()

/**
 * Ensures the given WritableContext has its dispatch wrapped to fire
 * per-node listeners after each change is applied. Returns the shared
 * listener map.
 *
 * Each node registers its own shallow listener in this map. When
 * dispatch fires, the wrapper looks up exact-path listeners and
 * invokes them. This replaces the old flat subscriber map with a
 * still-flat notification mechanism, but each listener is owned by
 * a per-node changefeed (not a global map).
 */
function ensureDispatchWiring(
  ctx: WritableContext,
): Map<string, Set<(change: ChangeBase) => void>> {
  let state = contextState.get(ctx)
  if (state) return state.listeners

  const listeners = new Map<string, Set<(change: ChangeBase) => void>>()
  const originalDispatch = ctx.dispatch

  const wrappedDispatch = (path: Path, change: ChangeBase): void => {
    originalDispatch(path, change)
    // Only fire listeners when the change was actually applied to the
    // store. During a transaction, dispatch buffers into pending — the
    // store is unchanged, so subscribers must not see the change yet.
    // On commit(), inTransaction is set to false before replay, so
    // listeners fire correctly during the replay loop.
    if (ctx.inTransaction) return
    const key = pathKey(path)
    const set = listeners.get(key)
    if (set) {
      for (const cb of set) cb(change)
    }
  }
  ;(ctx as any).dispatch = wrappedDispatch

  state = { listeners, originalDispatch }
  contextState.set(ctx, state)
  return listeners
}

/**
 * Registers a listener for changes dispatched at a specific path.
 * Returns an unsubscribe function.
 */
function listenAtPath(
  listeners: Map<string, Set<(change: ChangeBase) => void>>,
  path: Path,
  callback: (change: ChangeBase) => void,
): () => void {
  const key = pathKey(path)
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(callback)
  return () => {
    set!.delete(callback)
    if (set!.size === 0) {
      listeners.delete(key)
    }
  }
}

// ---------------------------------------------------------------------------
// Changefeed factories
// ---------------------------------------------------------------------------

/**
 * Creates a leaf Changefeed (no children, no subscribeTree).
 * `subscribe` fires on any change dispatched at this path.
 */
function createLeafChangefeed(
  listeners: Map<string, Set<(change: ChangeBase) => void>>,
  path: Path,
  readCurrent: () => unknown,
): Changefeed<unknown, ChangeBase> {
  return {
    get current() {
      return readCurrent()
    },
    subscribe(callback: (change: ChangeBase) => void): () => void {
      return listenAtPath(listeners, path, callback)
    },
  }
}

/**
 * Creates a ComposedChangefeed for a product (struct) node.
 *
 * - `subscribe` fires only on changes at this node's own path.
 * - `subscribeTree` fires for all descendant changes with origin paths,
 *   PLUS own-path changes with origin [].
 *
 * The product forces all child thunks eagerly to obtain their
 * changefeeds, then subscribes to each child for tree propagation.
 */
function createProductChangefeed(
  listeners: Map<string, Set<(change: ChangeBase) => void>>,
  path: Path,
  readCurrent: () => unknown,
  fields: Readonly<Record<string, () => unknown>>,
): ComposedChangefeed<unknown, ChangeBase> {
  // Per-node shallow subscribers (node-level)
  const shallowSubs = new Set<(change: ChangeBase) => void>()
  // Per-node tree subscribers
  const treeSubs = new Set<(event: TreeEvent) => void>()

  // Register in the dispatch listener map for own-path changes
  listenAtPath(listeners, path, (change: ChangeBase) => {
    for (const cb of shallowSubs) cb(change)
    // Tree subscribers also see own-path changes with origin []
    if (treeSubs.size > 0) {
      const event: TreeEvent = { origin: [], change }
      for (const cb of treeSubs) cb(event)
    }
  })

  // Subscribe to children lazily on first subscribeTree call
  let childWiringDone = false

  function wireChildren(): void {
    if (childWiringDone) return
    childWiringDone = true

    for (const key of Object.keys(fields)) {
      const child = fields[key]!()
      if (!hasChangefeed(child)) continue

      const prefix: Path = [{ type: "key" as const, key }]

      if (hasComposedChangefeed(child)) {
        // Composite child — subscribe to its tree
        child[CHANGEFEED].subscribeTree((event: TreeEvent) => {
          if (treeSubs.size === 0) return
          const propagated: TreeEvent = {
            origin: [...prefix, ...event.origin],
            change: event.change,
          }
          for (const cb of treeSubs) cb(propagated)
        })
      } else {
        // Leaf child — subscribe to its shallow stream
        child[CHANGEFEED].subscribe((change: ChangeBase) => {
          if (treeSubs.size === 0) return
          const event: TreeEvent = { origin: prefix, change }
          for (const cb of treeSubs) cb(event)
        })
      }
    }
  }

  return {
    get current() {
      return readCurrent()
    },
    subscribe(callback: (change: ChangeBase) => void): () => void {
      shallowSubs.add(callback)
      return () => { shallowSubs.delete(callback) }
    },
    subscribeTree(callback: (event: TreeEvent) => void): () => void {
      wireChildren()
      treeSubs.add(callback)
      return () => { treeSubs.delete(callback) }
    },
  }
}

/**
 * Creates a ComposedChangefeed for a sequence (list) node.
 *
 * - `subscribe` fires on SequenceChange at this path (structural changes).
 * - `subscribeTree` fires for structural changes (with origin []) AND
 *   per-item content changes (with origin [{type:"index",index},...]).
 *
 * Dynamic subscription management: when items are inserted or deleted,
 * the transformer tears down old per-item subscriptions and establishes
 * new ones at the correct indices.
 */
function createSequenceChangefeed(
  listeners: Map<string, Set<(change: ChangeBase) => void>>,
  path: Path,
  readCurrent: () => unknown,
  getItemRef: (index: number) => unknown,
  getLength: () => number,
): ComposedChangefeed<unknown, ChangeBase> {
  const shallowSubs = new Set<(change: ChangeBase) => void>()
  const treeSubs = new Set<(event: TreeEvent) => void>()

  // Per-item unsubscribe functions, keyed by index
  const itemUnsubs = new Map<number, () => void>()

  function subscribeToItem(index: number): void {
    // Unsubscribe from any existing subscription at this index
    const existing = itemUnsubs.get(index)
    if (existing) existing()

    const child = getItemRef(index)
    if (!child || !hasChangefeed(child)) {
      itemUnsubs.delete(index)
      return
    }

    const prefix: Path = [{ type: "index" as const, index }]

    let unsub: () => void
    if (hasComposedChangefeed(child)) {
      unsub = child[CHANGEFEED].subscribeTree((event: TreeEvent) => {
        if (treeSubs.size === 0) return
        const propagated: TreeEvent = {
          origin: [...prefix, ...event.origin],
          change: event.change,
        }
        for (const cb of treeSubs) cb(propagated)
      })
    } else {
      unsub = child[CHANGEFEED].subscribe((change: ChangeBase) => {
        if (treeSubs.size === 0) return
        const event: TreeEvent = { origin: prefix, change }
        for (const cb of treeSubs) cb(event)
      })
    }
    itemUnsubs.set(index, unsub)
  }

  function subscribeToAllItems(): void {
    const len = getLength()
    for (let i = 0; i < len; i++) {
      subscribeToItem(i)
    }
  }

  function handleStructuralChange(change: ChangeBase): void {
    if (!isSequenceChange(change)) {
      // ReplaceChange or unknown — tear down all, rebuild
      for (const unsub of itemUnsubs.values()) unsub()
      itemUnsubs.clear()
      if (treeSubs.size > 0) subscribeToAllItems()
      return
    }

    // Parse the sequence ops to determine what indices changed
    // After the store is updated, we need to rebuild subscriptions
    // at affected indices. The simplest correct approach: tear down
    // all subscriptions and rebuild for the new length.
    //
    // This is O(n) per structural change but correct. A more
    // sophisticated approach would parse retain/insert/delete ops
    // to shift subscriptions, but that optimization can come later.
    for (const unsub of itemUnsubs.values()) unsub()
    itemUnsubs.clear()
    if (treeSubs.size > 0) subscribeToAllItems()
  }

  // Register in the dispatch listener map for own-path changes
  listenAtPath(listeners, path, (change: ChangeBase) => {
    // Fire shallow subscribers
    for (const cb of shallowSubs) cb(change)

    // Tree subscribers see own-path structural changes with origin []
    if (treeSubs.size > 0) {
      const event: TreeEvent = { origin: [], change }
      for (const cb of treeSubs) cb(event)
    }

    // Rebuild item subscriptions after structural change
    handleStructuralChange(change)
  })

  let initialWiringDone = false

  return {
    get current() {
      return readCurrent()
    },
    subscribe(callback: (change: ChangeBase) => void): () => void {
      shallowSubs.add(callback)
      return () => { shallowSubs.delete(callback) }
    },
    subscribeTree(callback: (event: TreeEvent) => void): () => void {
      if (!initialWiringDone) {
        initialWiringDone = true
        subscribeToAllItems()
      }
      treeSubs.add(callback)
      return () => {
        treeSubs.delete(callback)
        // If no more tree subscribers, tear down item subscriptions
        if (treeSubs.size === 0) {
          for (const unsub of itemUnsubs.values()) unsub()
          itemUnsubs.clear()
          initialWiringDone = false
        }
      }
    },
  }
}

/**
 * Creates a ComposedChangefeed for a map (record) node.
 *
 * Similar to sequence but keyed by string instead of number.
 * Dynamic subscription management for map entries.
 */
function createMapChangefeed(
  listeners: Map<string, Set<(change: ChangeBase) => void>>,
  path: Path,
  readCurrent: () => unknown,
  getEntryRef: (key: string) => unknown,
  getKeys: () => string[],
): ComposedChangefeed<unknown, ChangeBase> {
  const shallowSubs = new Set<(change: ChangeBase) => void>()
  const treeSubs = new Set<(event: TreeEvent) => void>()

  const entryUnsubs = new Map<string, () => void>()

  function subscribeToEntry(key: string): void {
    const existing = entryUnsubs.get(key)
    if (existing) existing()

    const child = getEntryRef(key)
    if (!child || !hasChangefeed(child)) {
      entryUnsubs.delete(key)
      return
    }

    const prefix: Path = [{ type: "key" as const, key }]

    let unsub: () => void
    if (hasComposedChangefeed(child)) {
      unsub = child[CHANGEFEED].subscribeTree((event: TreeEvent) => {
        if (treeSubs.size === 0) return
        const propagated: TreeEvent = {
          origin: [...prefix, ...event.origin],
          change: event.change,
        }
        for (const cb of treeSubs) cb(propagated)
      })
    } else {
      unsub = child[CHANGEFEED].subscribe((change: ChangeBase) => {
        if (treeSubs.size === 0) return
        const event: TreeEvent = { origin: prefix, change }
        for (const cb of treeSubs) cb(event)
      })
    }
    entryUnsubs.set(key, unsub)
  }

  function subscribeToAllEntries(): void {
    const keys = getKeys()
    for (const key of keys) {
      subscribeToEntry(key)
    }
  }

  function handleStructuralChange(_change: ChangeBase): void {
    // Tear down all and rebuild for current keys
    for (const unsub of entryUnsubs.values()) unsub()
    entryUnsubs.clear()
    if (treeSubs.size > 0) subscribeToAllEntries()
  }

  // Register in the dispatch listener map for own-path changes
  listenAtPath(listeners, path, (change: ChangeBase) => {
    for (const cb of shallowSubs) cb(change)

    if (treeSubs.size > 0) {
      const event: TreeEvent = { origin: [], change }
      for (const cb of treeSubs) cb(event)
    }

    handleStructuralChange(change)
  })

  let initialWiringDone = false

  return {
    get current() {
      return readCurrent()
    },
    subscribe(callback: (change: ChangeBase) => void): () => void {
      shallowSubs.add(callback)
      return () => { shallowSubs.delete(callback) }
    },
    subscribeTree(callback: (event: TreeEvent) => void): () => void {
      if (!initialWiringDone) {
        initialWiringDone = true
        subscribeToAllEntries()
      }
      treeSubs.add(callback)
      return () => {
        treeSubs.delete(callback)
        if (treeSubs.size === 0) {
          for (const unsub of entryUnsubs.values()) unsub()
          entryUnsubs.clear()
          initialWiringDone = false
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// withChangefeed — the interpreter transformer
// ---------------------------------------------------------------------------

/**
 * An interpreter transformer that attaches `[CHANGEFEED]` to every ref
 * produced by the base interpreter.
 *
 * - **Leaf refs** (scalar, text, counter) get a plain `Changefeed`:
 *   `subscribe` fires on any change dispatched at that path.
 *
 * - **Composite refs** (product, sequence, map) get a `ComposedChangefeed`:
 *   `subscribe` fires only for changes at the node's own path (node-level).
 *   `subscribeTree` fires for all descendant changes with relative origin
 *   paths (tree-level), making it a strict superset of `subscribe`.
 *
 * Notification flows through the changefeed tree, not flat subscriber maps.
 * Each node's `subscribeTree` composes its children's changefeeds.
 *
 * **Dispatch wrapping:** The transformer wraps `ctx.dispatch` (once per
 * context, idempotently) so that after each change is applied to the store,
 * the affected node's changefeed subscribers fire.
 *
 * **Transaction compatibility:** During a transaction, `dispatch` buffers
 * changes. On `commit()`, changes replay through the wrapped `ctx.dispatch`,
 * so subscribers fire at commit time — not during buffering.
 *
 * ```ts
 * const interp = withChangefeed(withWritable(withCaching(withReadable(bottomInterpreter))))
 * const ctx = createWritableContext(store)
 * const doc = interpret(schema, interp, ctx)
 * doc[CHANGEFEED].subscribe(cb)       // node-level
 * doc[CHANGEFEED].subscribeTree(cb)   // tree-level
 * ```
 */
export function withChangefeed<A>(
  base: Interpreter<WritableContext, A>,
): Interpreter<WritableContext, A> {
  return {
    // --- Scalar ---------------------------------------------------------------
    scalar(
      ctx: WritableContext,
      path: Path,
      schema: ScalarSchema,
    ): A {
      const result = base.scalar(ctx, path, schema)

      if (isPropertyHost(result)) {
        const listeners = ensureDispatchWiring(ctx)
        const cf = createLeafChangefeed(listeners, path, () =>
          readByPath(ctx.store, path),
        )
        attachChangefeed(result as object, cf)
      }

      return result
    },

    // --- Product --------------------------------------------------------------
    product(
      ctx: WritableContext,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => A>>,
    ): A {
      const result = base.product(ctx, path, schema, fields)

      if (isPropertyHost(result)) {
        const listeners = ensureDispatchWiring(ctx)
        const cf = createProductChangefeed(
          listeners,
          path,
          () => (result as any)[READ](),
          // The fields object contains thunks — forcing them yields
          // child refs with [CHANGEFEED] already attached (because
          // the catamorphism interprets children before parents, and
          // the field thunks capture the full interpreter).
          fields as Readonly<Record<string, () => unknown>>,
        )
        attachChangefeed(result as object, cf)
      }

      return result
    },

    // --- Sequence -------------------------------------------------------------
    sequence(
      ctx: WritableContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A,
    ): A {
      const result = base.sequence(ctx, path, schema, item)

      if (isPropertyHost(result)) {
        const listeners = ensureDispatchWiring(ctx)
        const resultAny = result as any

        const cf = createSequenceChangefeed(
          listeners,
          path,
          () => (result as any)[READ](),
          // Use the result's .at() method to get child refs —
          // this goes through the caching layer, so refs have
          // stable identity and [CHANGEFEED] attached.
          (index: number) => {
            if (typeof resultAny.at === "function") {
              return resultAny.at(index)
            }
            return item(index)
          },
          () => {
            const arr = readByPath(ctx.store, path)
            return Array.isArray(arr) ? arr.length : 0
          },
        )
        attachChangefeed(result as object, cf)
      }

      return result
    },

    // --- Map ------------------------------------------------------------------
    map(
      ctx: WritableContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A,
    ): A {
      const result = base.map(ctx, path, schema, item)

      if (isPropertyHost(result)) {
        const listeners = ensureDispatchWiring(ctx)
        const resultAny = result as any

        const cf = createMapChangefeed(
          listeners,
          path,
          () => (result as any)[READ](),
          (key: string) => {
            if (typeof resultAny.at === "function") {
              return resultAny.at(key)
            }
            return item(key)
          },
          () => {
            const obj = readByPath(ctx.store, path)
            if (obj !== null && obj !== undefined && typeof obj === "object") {
              return Object.keys(obj as Record<string, unknown>)
            }
            return []
          },
        )
        attachChangefeed(result as object, cf)
      }

      return result
    },

    // --- Sum ------------------------------------------------------------------
    // Pure structural dispatch — pass through. The resolved variant
    // already has [CHANGEFEED] from whichever case handled it.
    sum(
      ctx: WritableContext,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<A>,
    ): A {
      return base.sum(ctx, path, schema, variants)
    },

    // --- Annotated ------------------------------------------------------------
    annotated(
      ctx: WritableContext,
      path: Path,
      schema: AnnotatedSchema,
      inner: (() => A) | undefined,
    ): A {
      const result = base.annotated(ctx, path, schema, inner)

      switch (schema.tag) {
        case "text":
        case "counter": {
          // Leaf annotations — attach a leaf changefeed
          if (isPropertyHost(result)) {
            const listeners = ensureDispatchWiring(ctx)
            const cf = createLeafChangefeed(listeners, path, () =>
              readByPath(ctx.store, path),
            )
            attachChangefeed(result as object, cf)
          }
          return result
        }

        case "doc":
        case "movable":
        case "tree":
          // Delegating annotations — the inner case (product, sequence,
          // etc.) already attached [CHANGEFEED] during recursion.
          return result

        default:
          // Unknown annotation — if inner was provided, the inner case
          // handled it. Otherwise treat as a leaf.
          if (inner !== undefined) {
            return result
          }
          if (isPropertyHost(result)) {
            const listeners = ensureDispatchWiring(ctx)
            const cf = createLeafChangefeed(listeners, path, () =>
              readByPath(ctx.store, path),
            )
            attachChangefeed(result as object, cf)
          }
          return result
      }
    },
  }
}