// withAddressing — stable identity for all composite refs.
//
// This transformer owns address tables for all composite types,
// installs an AddressedPath root on the context (so all descendant
// paths are identity-stable), hooks into the `prepare` pipeline for
// eager index address advancement (sequences) and tombstoning (maps),
// attaches the `deleted` getter on refs via the `onRefCreated` hook,
// and attaches `[REMOVE]` on container-child refs (writable stacks only).
//
// The `[REMOVE]` attachment introduces a dependency on `writable.ts`
// (for `TRANSACT`, `hasTransact`, `REMOVE`, `WritableContext`). This
// coupling is justified: `onRefCreated` is the only correct attachment
// point for `[REMOVE]` because it owns child discrimination (index vs
// key) and path structure (parent path derivation). The `[REMOVE]`
// closure dispatches at the *parent* path — the sole exception to the
// "every node dispatches at its own path" invariant.
//
// Composition ordering:
//   withCaching(withAddressing(withReadable(withNavigation(bottom))))
//
// Addressing is foundational, not an optimization. An Address is the
// stable identity of an entity within a composite node:
// - Sequences: index address (mutable index + stable ID)
// - Maps: key address + tombstone tracking
// - Products: key address (always stable, never dead)
//
// See .jj-plan/01-cursor-stable-refs.md §Phase 2.

import type { ChangeBase } from "../change.js"
import {
  advanceAddresses,
  isMapChange,
  isReplaceChange,
  isSequenceChange,
  mapChange,
  sequenceChange,
} from "../change.js"
import { isPropertyHost } from "../guards.js"
import type { Interpreter, Path, SumVariants } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import {
  AddressedPath,
  AddressTableRegistry,
  type IndexAddress,
  type MapAddressTable,
  type SequenceAddressTable,
} from "../path.js"
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
import type { BatchOptions } from "../substrate.js"
import type { HasNavigation } from "./bottom.js"
import { installKeyedAddressing } from "./keyed-helpers.js"
import { installSequenceAddressing } from "./sequence-helpers.js"
import type { WritableContext } from "./writable.js"
import { hasTransact, REMOVE, TRANSACT } from "./writable.js"

// ---------------------------------------------------------------------------
// ADDRESS_TABLE symbol — discovery hook for withCaching (Phase 5)
// ---------------------------------------------------------------------------

/**
 * Symbol for discovering address tables on sequence/map refs.
 *
 * `withAddressing` attaches the address table under this symbol so
 * `withCaching` (and future layers) can delegate memoization to the
 * address table rather than maintaining a separate cache.
 *
 * Uses `Symbol.for` so multiple copies of this module share identity.
 */
export const ADDRESS_TABLE: unique symbol = Symbol.for(
  "kyneta:addressTable",
) as any

// ---------------------------------------------------------------------------
// Per-context state — prepare wrapping for address advancement
// ---------------------------------------------------------------------------

interface AddressingState {
  readonly handlers: Map<string, (change: ChangeBase) => void>
  readonly originalPrepare: (
    path: Path,
    change: ChangeBase,
    options?: BatchOptions,
  ) => void
}

const addressingContextState = new WeakMap<object, AddressingState>()

function hasPrepare(ctx: RefContext): ctx is RefContext & {
  prepare: (path: Path, change: ChangeBase, options?: BatchOptions) => void
} {
  return "prepare" in ctx && typeof (ctx as any).prepare === "function"
}

/**
 * Ensures the given context has its `prepare` wrapped for address
 * advancement. Returns the shared handler map, or `null` if the
 * context doesn't have `prepare` (read-only stack).
 *
 * Same structural pattern as `ensureCacheWiring` in `withCaching`.
 * The addressing layer's prepare wrapper fires BEFORE the cache layer's
 * wrapper (because withAddressing is inner to withCaching in composition),
 * so addresses are advanced before cache invalidation.
 */
function ensureAddressingWiring(
  ctx: RefContext,
): Map<string, (change: ChangeBase) => void> | null {
  if (!hasPrepare(ctx)) return null

  let state = addressingContextState.get(ctx)
  if (state) return state.handlers

  const handlers = new Map<string, (change: ChangeBase) => void>()
  const originalPrepare = ctx.prepare

  const wrappedPrepare = (
    path: Path,
    change: ChangeBase,
    options?: BatchOptions,
  ): void => {
    const key = path.key
    const handler = handlers.get(key)
    if (handler) handler(change)
    originalPrepare(path, change, options)
  }

  ctx.prepare = wrappedPrepare

  state = { handlers, originalPrepare }
  addressingContextState.set(ctx, state)
  return handlers
}

function registerAddressingHandler(
  handlers: Map<string, (change: ChangeBase) => void> | null,
  path: Path,
  handler: (change: ChangeBase) => void,
): void {
  if (handlers) {
    handlers.set(path.key, handler)
  }
}

// ---------------------------------------------------------------------------
// Sequence address advancement
// ---------------------------------------------------------------------------

/**
 * Handle a change to a sequence node by advancing index addresses
 * and rebuilding the byIndex reverse map.
 */
function handleSequenceChange(
  table: SequenceAddressTable,
  change: ChangeBase,
): void {
  if (isReplaceChange(change)) {
    // Replace: mark all addresses dead, clear the table
    for (const entry of table.byId.values()) {
      entry.address.dead = true
    }
    table.byId.clear()
    table.byIndex.clear()
    return
  }

  if (!isSequenceChange(change)) return

  // Collect all live index addresses for advancement
  const liveAddresses: IndexAddress[] = []
  for (const entry of table.byId.values()) {
    if (!entry.address.dead && entry.address.kind === "index") {
      liveAddresses.push(entry.address as IndexAddress)
    }
  }

  // Advance all addresses in one pass
  advanceAddresses(liveAddresses, change.instructions)

  // Rebuild byIndex from surviving (non-dead) addresses
  table.byIndex.clear()
  for (const entry of table.byId.values()) {
    if (!entry.address.dead && entry.address.kind === "index") {
      table.byIndex.set(entry.address.index, entry.address)
    }
  }
}

// ---------------------------------------------------------------------------
// Map address tombstoning
// ---------------------------------------------------------------------------

/**
 * Handle a change to a map node by tombstoning deleted keys
 * and resurrecting re-set keys.
 */
function handleMapChange(table: MapAddressTable, change: ChangeBase): void {
  if (isReplaceChange(change)) {
    // Replace: mark all addresses dead
    for (const entry of table.byKey.values()) {
      entry.address.dead = true
    }
    table.byKey.clear()
    return
  }

  if (!isMapChange(change)) return

  // Delete keys: mark addresses dead
  if (change.delete) {
    for (const key of change.delete) {
      const entry = table.byKey.get(key)
      if (entry) {
        entry.address.dead = true
      }
    }
  }

  // Set keys: resurrect if previously dead
  if (change.set) {
    for (const key of Object.keys(change.set)) {
      const entry = table.byKey.get(key)
      if (entry?.address.dead) {
        entry.address.dead = false
      }
    }
  }
}

// ---------------------------------------------------------------------------
// withAddressing — the interpreter transformer
// ---------------------------------------------------------------------------

/**
 * Transformer that adds stable addressing to all composite refs.
 *
 * Takes an `Interpreter<RefContext, A extends HasNavigation>` and returns
 * an `Interpreter<RefContext, A>`. The carrier identity is preserved.
 *
 * On first invocation per context, installs:
 * 1. `ctx.rootPath` — an `AddressedPath` root with a fresh registry
 * 2. `ctx.onRefCreated` — a hook that links addresses to refs and
 *    attaches the `deleted` getter
 * 3. Per-node `prepare` handlers for address advancement (sequences)
 *    and tombstoning (maps)
 *
 * The `[ADDRESS_TABLE]` symbol is attached to sequence/map refs for
 * downstream discovery by `withCaching`.
 */
export function withAddressing<A extends HasNavigation>(
  base: Interpreter<RefContext, A>,
): Interpreter<RefContext, A> {
  // Per-context registry — created once per interpretation tree.
  // We use a WeakMap keyed by context to ensure one registry per context.
  const registryByCtx = new WeakMap<object, AddressTableRegistry>()

  function getOrCreateRegistry(ctx: RefContext): AddressTableRegistry {
    let registry = registryByCtx.get(ctx)
    if (!registry) {
      registry = new AddressTableRegistry()
      registryByCtx.set(ctx, registry)

      // Install rootPath and onRefCreated on the context (once)
      const mutableCtx = ctx as {
        rootPath?: Path
        onRefCreated?: (path: Path, ref: unknown) => void
      }

      mutableCtx.rootPath = new AddressedPath([], registry)

      // Chain onRefCreated if one already exists (defensive)
      const existingHook = mutableCtx.onRefCreated
      mutableCtx.onRefCreated = (path: Path, ref: unknown) => {
        existingHook?.(path, ref)

        // Every path in an addressing stack must be addressed.
        // A RawPath here means ctx.rootPath wasn't set before child
        // path derivation — a timing bug in interpretImpl.
        if (!path.isAddressed) {
          throw new Error(
            `withAddressing: onRefCreated received a non-addressed path "${path.format()}". ` +
              `This indicates ctx.rootPath was not set before child path derivation.`,
          )
        }

        const addrPath = path as AddressedPath
        const lastAddr = addrPath.lastAddress()
        if (!lastAddr) return // empty path (e.g. annotated reuse) — skip

        // Attach `deleted` getter if the ref is an object
        if (isPropertyHost(ref)) {
          Object.defineProperty(ref, "deleted", {
            get() {
              return lastAddr.dead
            },
            enumerable: false,
            configurable: true,
          })
        }

        // Hoist parentPath — reused for table registration and [REMOVE] closure
        const parentPath = addrPath.slice(0, addrPath.length - 1)

        // Register ref in the appropriate address table
        if (lastAddr.kind === "index") {
          // Sequence item
          registry?.registerSequenceRef(parentPath.key, lastAddr, ref)
        } else if (lastAddr.kind === "key") {
          // Map/product entry — register in the map table
          const childKey = lastAddr.key
          registry?.ensureMapEntry(parentPath.key, childKey, lastAddr)
          registry?.registerMapRef(parentPath.key, childKey, ref)
        }

        // Attach [REMOVE] for container children on writable stacks.
        // Only attach when: (1) ref has [TRANSACT] (writable stack),
        // (2) ref is a property host, and (3) the child is part of a
        // container (sequence/map/set/movable), not a product field.
        //
        // Container discrimination: the addressing handler map has an
        // entry for every container parent (sequence, map, set, movable
        // cases register handlers). Product parents do not register
        // handlers. So handlers.has(parentPath.key) === true means
        // "parent is a container."
        if (isPropertyHost(ref) && hasTransact(ref)) {
          const isContainerChild =
            lastAddr.kind === "index" ||
            (addressingContextState.get(ctx)?.handlers.has(parentPath.key) ??
              false)

          if (isContainerChild) {
            Object.defineProperty(ref, REMOVE, {
              value() {
                if (lastAddr.dead) {
                  const detail =
                    lastAddr.kind === "index"
                      ? "The item this ref pointed to has been removed."
                      : `The entry "${lastAddr.key}" this ref pointed to has been removed.`
                  throw new Error(`Cannot remove a dead ref. ${detail}`)
                }
                const wctx: WritableContext = (ref as any)[TRANSACT]
                if (lastAddr.kind === "index") {
                  const index = lastAddr.index
                  wctx.dispatch(
                    parentPath,
                    sequenceChange([
                      ...(index > 0 ? [{ retain: index }] : []),
                      { delete: 1 },
                    ]),
                  )
                } else {
                  // key-based (map/set entry)
                  wctx.dispatch(
                    parentPath,
                    mapChange(undefined, [lastAddr.key]),
                  )
                }
              },
              enumerable: false,
              configurable: true,
              writable: false,
            })
          }
        }
      }
    }
    return registry
  }

  return {
    // --- Scalar ---------------------------------------------------------------
    scalar(ctx: RefContext, path: Path, schema: ScalarSchema): A {
      // Ensure registry is installed (in case scalar is the first node interpreted)
      getOrCreateRegistry(ctx)
      return base.scalar(ctx, path, schema)
    },

    // --- Product ---------------------------------------------------------------
    // No prepare handler needed — field addresses are schema-defined, never deleted.
    product(
      ctx: RefContext,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => A>>,
    ): A {
      getOrCreateRegistry(ctx)
      return base.product(ctx, path, schema, fields)
    },

    // --- Sequence ---------------------------------------------------------------
    // Hook into prepare for address advancement on structural changes.
    sequence(
      ctx: RefContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A,
    ): A {
      const registry = getOrCreateRegistry(ctx)
      const result = base.sequence(ctx, path, schema, item)
      const seqPathKey = path.key
      installSequenceAddressing(
        result,
        path,
        ADDRESS_TABLE,
        () => registry.getSequenceTable(seqPathKey),
        (p, handler) =>
          registerAddressingHandler(ensureAddressingWiring(ctx), p, handler),
        handleSequenceChange as (table: unknown, change: unknown) => void,
      )
      return result
    },

    // --- Map -------------------------------------------------------------------
    // Hook into prepare for tombstoning on key deletion.
    map(
      ctx: RefContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A,
    ): A {
      const registry = getOrCreateRegistry(ctx)
      const result = base.map(ctx, path, schema, item)
      const mapPathKey = path.key
      installKeyedAddressing(
        result,
        path,
        ADDRESS_TABLE,
        () => registry.getMapTable(mapPathKey),
        (p, handler) =>
          registerAddressingHandler(ensureAddressingWiring(ctx), p, handler),
        handleMapChange as (table: unknown, change: unknown) => void,
      )
      return result
    },

    // --- Sum -------------------------------------------------------------------
    sum(
      ctx: RefContext,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<A>,
    ): A {
      getOrCreateRegistry(ctx)
      return base.sum(ctx, path, schema, variants)
    },

    // --- Text ------------------------------------------------------------------
    text(ctx: RefContext, path: Path, schema: TextSchema): A {
      getOrCreateRegistry(ctx)
      return base.text(ctx, path, schema)
    },

    // --- Counter ---------------------------------------------------------------
    counter(ctx: RefContext, path: Path, schema: CounterSchema): A {
      getOrCreateRegistry(ctx)
      return base.counter(ctx, path, schema)
    },

    // --- Set -------------------------------------------------------------------
    // Hook into prepare for tombstoning on key deletion (like map).
    set(
      ctx: RefContext,
      path: Path,
      schema: SetSchema,
      item: (key: string) => A,
    ): A {
      const registry = getOrCreateRegistry(ctx)
      const result = base.set(ctx, path, schema, item)
      const mapPathKey = path.key
      installKeyedAddressing(
        result,
        path,
        ADDRESS_TABLE,
        () => registry.getMapTable(mapPathKey),
        (p, handler) =>
          registerAddressingHandler(ensureAddressingWiring(ctx), p, handler),
        handleMapChange as (table: unknown, change: unknown) => void,
      )
      return result
    },

    // --- Tree ------------------------------------------------------------------
    tree(
      ctx: RefContext,
      path: Path,
      schema: TreeSchema,
      nodeData: () => A,
    ): A {
      getOrCreateRegistry(ctx)
      return base.tree(ctx, path, schema, nodeData)
    },

    // --- Movable ---------------------------------------------------------------
    // Hook into prepare for address advancement on structural changes (like sequence).
    movable(
      ctx: RefContext,
      path: Path,
      schema: MovableSequenceSchema,
      item: (index: number) => A,
    ): A {
      const registry = getOrCreateRegistry(ctx)
      const result = base.movable(ctx, path, schema, item)
      const seqPathKey = path.key
      installSequenceAddressing(
        result,
        path,
        ADDRESS_TABLE,
        () => registry.getSequenceTable(seqPathKey),
        (p, handler) =>
          registerAddressingHandler(ensureAddressingWiring(ctx), p, handler),
        handleSequenceChange as (table: unknown, change: unknown) => void,
      )
      return result
    },

    // --- RichText --------------------------------------------------------------
    richtext(ctx: RefContext, path: Path, schema: RichTextSchema): A {
      getOrCreateRegistry(ctx)
      return base.richtext(ctx, path, schema)
    },
  }
}
