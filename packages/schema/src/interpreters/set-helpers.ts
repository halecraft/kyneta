// set-helpers — install operations for `Schema.set` refs.
//
// Sets are ref-layer **leaf-shaped**: there are no addressable per-member
// child refs, no `.at(value)`, no per-key caching. The surface is:
//
//   - `()` → `Plain<I>[]` (call signature: whole-set snapshot)
//   - `.has(value)` (membership query via `samePlainValue`)
//   - `.size` (member count)
//   - `[Symbol.iterator]` (iterates plain values, not refs)
//   - `.add(value)` / `.delete(value)` / `.clear()` (writable)
//
// This is intentionally narrower than `keyed-helpers.ts` (which serves
// `map` with `.at(key)`, `.keys()`, `.entries()`, `.values()`, etc.).
// Sets do NOT share keyed-helpers' navigation or per-key carriers: a set is
// read whole.

import { own, setOpChange } from "../change.js"
import { samePlainValue } from "../guards.js"
import type { Path } from "../interpret.js"
import { CALL } from "./bottom.js"
import type { WritableContext } from "./writable.js"

// ---------------------------------------------------------------------------
// installSetReadable — `.has`, `.size`, `[Symbol.iterator]`
// ---------------------------------------------------------------------------

/**
 * Install the readable surface for a set ref, over the members its `()`
 * returns (`withReadable` fills `[CALL]`):
 *
 * - `.has(value)` runs `samePlainValue` over the members.
 * - `.size` returns the member count.
 * - `[Symbol.iterator]` iterates plain values (not refs).
 *
 * Each reads the members through whatever `[CALL]` the outermost layer left,
 * so a tracking layer sees a read of the whole set. Membership is
 * content-equal via `samePlainValue` (not identity).
 */
export interface SetReadable {
  readonly has: (value: unknown) => boolean
  readonly size: number
  readonly [Symbol.iterator]: () => IterableIterator<unknown>
}

export function installSetReadable<T extends object>(
  result: T,
): asserts result is T & SetReadable {
  const members = (): readonly unknown[] => {
    const value = (result as { readonly [CALL]: () => unknown })[CALL]()
    return Array.isArray(value) ? value : []
  }

  Object.defineProperty(result, "has", {
    value: (value: unknown): boolean =>
      members().some(member => samePlainValue(member, value)),
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "size", {
    get(): number {
      return members().length
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, Symbol.iterator, {
    value: function* (): IterableIterator<unknown> {
      yield* members()
    },
    enumerable: false,
    configurable: true,
  })
}

// ---------------------------------------------------------------------------
// installSetWriteOps — `.add`, `.delete`, `.clear`
// ---------------------------------------------------------------------------

/**
 * Install the writable surface for a set ref:
 *
 * - `.add(value)` dispatches `setOpChange([value])`. Idempotent for an
 *   existing member (no-op via `stepSet`'s dedup).
 * - `.delete(value)` dispatches `setOpChange([], [value])`. Returns
 *   `true` if the member was present before the delete (matching
 *   native `Set.prototype.delete` semantics). Implemented by reading
 *   current state first.
 * - `.clear()` reads current members and dispatches a single
 *   `setOpChange([], current)`. This is the one place set writes read.
 */
export interface SetWriteOps {
  readonly add: (value: unknown) => void
  readonly delete: (value: unknown) => boolean
  readonly clear: () => void
}

export function installSetWriteOps<T extends object>(
  result: T,
  ctx: WritableContext,
  path: Path,
): asserts result is T & SetWriteOps {
  function readMembers(): unknown[] {
    const value = ctx.reader.read(path)
    return Array.isArray(value) ? value : []
  }

  Object.defineProperty(result, "add", {
    value: (value: unknown): void => {
      ctx.dispatch(path, setOpChange([own(value)]))
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "delete", {
    value: (value: unknown): boolean => {
      const wasPresent = readMembers().some(m => samePlainValue(m, value))
      if (wasPresent) {
        ctx.dispatch(path, setOpChange(undefined, [value]))
      }
      return wasPresent
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "clear", {
    value: (): void => {
      const current = readMembers()
      if (current.length > 0) {
        // A copy: the store compacts the members array in place, and the op
        // must still name what it removed.
        ctx.dispatch(path, setOpChange(undefined, [...current]))
      }
    },
    enumerable: false,
    configurable: true,
  })
}
