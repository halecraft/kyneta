// keyed-helpers — shared keyed-coalgebra helpers.
//
// `map` and `set` are instances of the **keyed coalgebra** — same
// structural addressing (by string key), same mutation surface
// (set/delete/clear), same navigation surface (at/has/keys/size/
// entries/values/iterator).
//
// Currently unextended, but the helpers provide a clean extension
// point if keyed kinds gain new operations in the future.

import { mapChange } from "../change.js"
import type { Path } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import { CALL, type NavigableCarrier } from "./bottom.js"
import type { WritableContext } from "./writable.js"

/**
 * Install keyed mutation methods onto a ref: `set`, `delete`, `clear`.
 *
 * Shared by both `map` and `set` kinds — the mutation surface is
 * identical (set a key, delete a key, clear all keys).
 */
export interface KeyedWriteOps {
  readonly set: (key: string, value: unknown) => void
  readonly delete: (key: string) => void
  readonly clear: () => void
}

export function installKeyedWriteOps<T extends object>(
  result: T,
  ctx: WritableContext,
  path: Path,
): asserts result is T & KeyedWriteOps {
  Object.defineProperty(result, "set", {
    value: (key: string, value: unknown): void => {
      const change = mapChange({ [key]: value })
      ctx.dispatch(path, change)
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "delete", {
    value: (key: string): void => {
      const change = mapChange(undefined, [key])
      ctx.dispatch(path, change)
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "clear", {
    value: (): void => {
      const allKeys = ctx.reader.keys(path)
      if (allKeys.length > 0) {
        const change = mapChange(undefined, allKeys)
        ctx.dispatch(path, change)
      }
    },
    enumerable: false,
    configurable: true,
  })
}

// ---------------------------------------------------------------------------
// Readable, navigation, addressing, caching helpers for map/set
// ---------------------------------------------------------------------------

/** Install the CALL slot (record snapshot) and `.get(key)` onto a keyed ref. */
export interface KeyedReadable {
  readonly [CALL]: () => Record<string, unknown>
  readonly get: (key: string) => unknown
}

export function installKeyedReadable<T extends object>(
  result: T,
  ctx: RefContext,
  path: Path,
): asserts result is T & KeyedReadable {
  // `.at` was installed by `installKeyedNavigation`, one layer further in.
  // That surface is not visible in `T`: layers describe each other with
  // phantom brands (`HasNavigation`) rather than structurally, so the type
  // cannot carry it across the boundary. Naming the one member being relied on
  // states the dependency instead of hiding it.
  const navigable = result as NavigableCarrier<string>

  // Snapshot goes through result.at(key) — not the raw item closure —
  // to respect caching/addressing identity.
  Object.defineProperty(result, CALL, {
    value: (): Record<string, unknown> => {
      const keys = ctx.reader.keys(path)
      const snapshot: Record<string, unknown> = {}
      for (const key of keys) {
        const child: unknown = navigable.at(key)
        snapshot[key] =
          typeof child === "function" ? (child as () => unknown)() : child
      }
      return snapshot
    },
    enumerable: true,
    configurable: true,
    writable: true,
  })

  Object.defineProperty(result, "get", {
    value: (key: string): unknown => {
      const child = navigable.at(key)
      return typeof child === "function"
        ? (child as () => unknown)()
        : undefined
    },
    enumerable: false,
    configurable: true,
  })
}

/** Install `.at(key)`, `.has()`, `.keys()`, `.size`, `.entries()`, `.values()`, and `[Symbol.iterator]` onto a keyed ref. */
export interface KeyedNavigation {
  readonly at: (key: string) => unknown
  readonly has: (key: string) => boolean
  readonly keys: () => string[]
  readonly size: number
  readonly entries: () => IterableIterator<[string, unknown]>
  readonly values: () => IterableIterator<unknown>
  readonly [Symbol.iterator]: () => IterableIterator<[string, unknown]>
}

export function installKeyedNavigation<T extends object>(
  result: T,
  ctx: RefContext,
  path: Path,
  item: (key: string) => unknown,
): asserts result is T & KeyedNavigation {
  // Read back through the carrier rather than calling `item` directly, so
  // `entries`/`values` respect whatever caching or addressing a later layer
  // installs over `.at`. Same cross-layer situation as `installKeyedReadable`.
  const navigable = result as NavigableCarrier<string>
  Object.defineProperty(result, "at", {
    value: (key: string): unknown => {
      if (!ctx.reader.hasKey(path, key)) {
        return undefined
      }
      return item(key)
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "has", {
    value: (key: string): boolean => {
      return ctx.reader.hasKey(path, key)
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "keys", {
    value: (): string[] => ctx.reader.keys(path),
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "size", {
    get(): number {
      return ctx.reader.keys(path).length
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "entries", {
    value: function* (): IterableIterator<[string, unknown]> {
      for (const key of ctx.reader.keys(path)) {
        yield [key, navigable.at(key)]
      }
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "values", {
    value: function* (): IterableIterator<unknown> {
      for (const key of ctx.reader.keys(path)) {
        yield navigable.at(key)
      }
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, Symbol.iterator, {
    value: function* (): IterableIterator<[string, unknown]> {
      for (const key of ctx.reader.keys(path)) {
        yield [key, navigable.at(key)]
      }
    },
    enumerable: false,
    configurable: true,
  })
}

/** Override `.at(key)` with address-table-backed lookup and register an invalidation handler. */
export function installKeyedCaching(
  result: object,
  path: Path,
  addressTableSym: symbol,
  invalidateSym: symbol,
  registerHandler: (path: Path, handler: (change: any) => void) => void,
): void {
  // Both symbols arrive as parameters, so neither the slot being read nor the
  // one being written can be named in a type. This helper narrows rather than
  // asserts for that reason — the members it touches are dynamic by design.
  const slots = result as Record<symbol, unknown> & NavigableCarrier<string>
  const baseAt = slots.at

  Object.defineProperty(result, "at", {
    value: (key: string): unknown => {
      const addressTable = slots[addressTableSym] as
        | { byKey: Map<string, { address: any; ref: unknown }> }
        | undefined

      if (addressTable) {
        const entry = addressTable.byKey.get(key)
        if (entry?.ref !== undefined && !entry.address.dead) {
          return entry.ref
        }
      }

      return baseAt.call(result, key)
    },
    enumerable: false,
    configurable: true,
  })

  // Addressing layer handles all structural changes, so the cache
  // layer has nothing to invalidate.
  const invalidateKeyed = (_change: any): void => {}

  slots[invalidateSym] = invalidateKeyed

  registerHandler(path, invalidateKeyed)
}
