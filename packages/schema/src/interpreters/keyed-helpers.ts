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
import { isPropertyHost } from "../guards.js"
import type { RefContext } from "../interpreter-types.js"
import type { Path } from "../interpret.js"
import type { WritableContext } from "./writable.js"
import { CALL } from "./bottom.js"

/**
 * Wire keyed mutation methods onto a ref: `set`, `delete`, `clear`.
 *
 * Shared by both `map` and `set` kinds — the mutation surface is
 * identical (set a key, delete a key, clear all keys).
 */
export function wireKeyedWriteOps(
  result: any,
  ctx: WritableContext,
  path: Path,
): void {
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

/** Wire the CALL slot (record snapshot) and `.get(key)` onto a keyed ref. */
export function wireKeyedReadable(
  result: any,
  ctx: RefContext,
  path: Path,
): void {
  // Snapshot goes through result.at(key) — not the raw item closure —
  // to respect caching/addressing identity.
  result[CALL] = () => {
    const keys = ctx.reader.keys(path)
    const snapshot: Record<string, unknown> = {}
    for (const key of keys) {
      const child: unknown = result.at(key)
      snapshot[key] =
        typeof child === "function" ? (child as () => unknown)() : child
    }
    return snapshot
  }

  Object.defineProperty(result, "get", {
    value: (key: string): unknown => {
      const child = result.at(key)
      return child !== undefined ? child() : undefined
    },
    enumerable: false,
    configurable: true,
  })
}

/** Wire `.at(key)`, `.has()`, `.keys()`, `.size`, `.entries()`, `.values()`, and `[Symbol.iterator]` onto a keyed ref. */
export function wireKeyedNavigation(
  result: any,
  ctx: RefContext,
  path: Path,
  item: (key: string) => unknown,
): void {
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
        yield [key, result.at(key)]
      }
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "values", {
    value: function* (): IterableIterator<unknown> {
      for (const key of ctx.reader.keys(path)) {
        yield result.at(key)
      }
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, Symbol.iterator, {
    value: function* (): IterableIterator<[string, unknown]> {
      for (const key of ctx.reader.keys(path)) {
        yield [key, result.at(key)]
      }
    },
    enumerable: false,
    configurable: true,
  })
}

/** Expose the address table via a well-known symbol and register a prepare handler for key-based address tracking. */
export function wireKeyedAddressing(
  result: any,
  path: Path,
  addressTableSymbol: symbol,
  getTable: () => unknown,
  registerHandler: (path: Path, handler: (change: any) => void) => void,
  handleChange: (table: unknown, change: any) => void,
): void {
  if (isPropertyHost(result)) {
    Object.defineProperty(result, addressTableSymbol, {
      get() {
        return getTable()
      },
      enumerable: false,
      configurable: true,
    })
  }

  registerHandler(path, (change: any) => {
    const t = getTable()
    if (t) handleChange(t, change)
  })
}

/** Override `.at(key)` with address-table-backed lookup and register an invalidation handler. */
export function wireKeyedCaching(
  result: any,
  path: Path,
  addressTableSym: symbol,
  invalidateSym: symbol,
  registerHandler: (path: Path, handler: (change: any) => void) => void,
): void {
  const baseAt = result.at as (key: string) => unknown

  Object.defineProperty(result, "at", {
    value: (key: string): unknown => {
      const addressTable = (result as any)[addressTableSym] as
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

  result[invalidateSym] = invalidateKeyed

  registerHandler(path, invalidateKeyed)
}