// keyed-helpers: the `map` kind's refs, addressed by string key.
//
// Mutation (set/delete/clear), reading, navigation (at/has/keys/size/
// entries/values/iterator) and caching for a record. Sets are keyed too but
// value-addressed, and install their own narrower surface from
// `set-helpers.ts`.

import { mapChange, mapClearChange, own } from "../change.js"
import { coordinatePath } from "../coordinate-trie.js"
import type { Path } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import { rawEntry } from "../path.js"
import type { Schema as SchemaNode } from "../schema.js"
import type { NavigableCarrier } from "./bottom.js"
import { readChildAt } from "./read-at.js"
import type { WritableContext } from "./writable.js"

/** Install a record's mutation methods onto a ref: `set`, `delete`, `clear`. */
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
      const change = mapChange(own({ [key]: value }))
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

  // Dispatches the intent, not the keys this peer can see, and dispatches it
  // even when it sees none: which keys a clear reaches is the substrate's
  // merge law to decide. The ephemeral substrate also removes older entries
  // that have not arrived yet.
  Object.defineProperty(result, "clear", {
    value: (): void => {
      ctx.dispatch(path, mapClearChange())
    },
    enumerable: false,
    configurable: true,
  })
}

// ---------------------------------------------------------------------------
// Readable, navigation, addressing, caching helpers for map/set
// ---------------------------------------------------------------------------

/** `.get(key)` on a keyed ref. */
export interface KeyedReadable {
  readonly get: (key: string) => unknown
}

/**
 * Install `.get(key)`: the entry's value, read from the record's value
 * (`readChildAt`), so it builds no ref and freezes only that entry. A missing
 * key is `undefined`.
 */
export function installKeyedReadable<T extends object>(
  result: T,
  ctx: RefContext,
  path: Path,
  item: SchemaNode,
): asserts result is T & KeyedReadable {
  Object.defineProperty(result, "get", {
    value: (key: string): unknown =>
      readChildAt(ctx, path, rawEntry(key), item),
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
  // installs over `.at`.
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

/**
 * Override `.at(key)` to return the carrier kept on the entry's coordinate, so
 * an entry keeps one carrier while it exists, and gets the same one back when
 * its key is set again.
 */
export function installKeyedCaching(
  result: object,
  ctx: RefContext,
  path: Path,
): void {
  // `.at` comes from `installKeyedNavigation`, one layer further in.
  const navigable = result as NavigableCarrier<string>
  const baseAt = navigable.at
  const map = coordinatePath(ctx, path)

  Object.defineProperty(result, "at", {
    value: (key: string): unknown => {
      if (!ctx.reader.hasKey(map, key)) return undefined
      return map.trie.node(map.entry(key))?.ref ?? baseAt.call(result, key)
    },
    enumerable: false,
    configurable: true,
  })
}
