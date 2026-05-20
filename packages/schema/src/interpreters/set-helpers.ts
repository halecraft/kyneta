// set-helpers — install operations for `Schema.set` refs.
//
// Sets are ref-layer **leaf-shaped**: there are no addressable per-member
// child refs, no `.at(value)`, no per-key caching. The surface is:
//
//   - `()` → `Plain<I>[]` (call signature: whole-set snapshot)
//   - `.has(value)` (membership query via `isSameSetMember`)
//   - `.size` (member count)
//   - `[Symbol.iterator]` (iterates plain values, not refs)
//   - `.add(value)` / `.delete(value)` / `.clear()` (writable)
//
// This is intentionally narrower than `keyed-helpers.ts` (which serves
// `map` with `.at(key)`, `.keys()`, `.entries()`, `.values()`, etc.).
// Sets do NOT share keyed-helpers' navigation/addressing/caching
// infrastructure — invalidation is whole-carrier on any `SetChange`.

import { setOpChange } from "../change.js"
import { isSameSetMember } from "../guards.js"
import type { Path } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import { CALL } from "./bottom.js"
import type { WritableContext } from "./writable.js"

// ---------------------------------------------------------------------------
// installSetReadable — `()` call, `.has`, `.size`, `[Symbol.iterator]`
// ---------------------------------------------------------------------------

/**
 * Install the readable surface for a set ref:
 *
 * - `[CALL]` returns a snapshot of the set as `Plain<I>[]`.
 * - `.has(value)` runs `isSameSetMember` over the current members.
 * - `.size` returns the member count.
 * - `[Symbol.iterator]` iterates plain values (not refs).
 *
 * All operations consult `ctx.reader.read(path)`, which returns the
 * `T[]` storage shape directly. Membership is content-equal via
 * `isSameSetMember` (not identity).
 */
export function installSetReadable(
  result: any,
  ctx: RefContext,
  path: Path,
): void {
  function readMembers(): unknown[] {
    const value = ctx.reader.read(path)
    return Array.isArray(value) ? value : []
  }

  result[CALL] = (): unknown[] => readMembers()

  Object.defineProperty(result, "has", {
    value: (value: unknown): boolean =>
      readMembers().some(member => isSameSetMember(member, value)),
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "size", {
    get(): number {
      return readMembers().length
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, Symbol.iterator, {
    value: function* (): IterableIterator<unknown> {
      for (const member of readMembers()) {
        yield member
      }
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
export function installSetWriteOps(
  result: any,
  ctx: WritableContext,
  path: Path,
): void {
  function readMembers(): unknown[] {
    const value = ctx.reader.read(path)
    return Array.isArray(value) ? value : []
  }

  Object.defineProperty(result, "add", {
    value: (value: unknown): void => {
      ctx.dispatch(path, setOpChange([value]))
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "delete", {
    value: (value: unknown): boolean => {
      const wasPresent = readMembers().some(m => isSameSetMember(m, value))
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
        ctx.dispatch(path, setOpChange(undefined, current))
      }
    },
    enumerable: false,
    configurable: true,
  })
}
