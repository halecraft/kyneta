// sequence-helpers — shared indexed-coalgebra helpers.
//
// `text`, `sequence`, and `movable` are instances of the **indexed
// coalgebra** — one positional coalgebra parameterized by content type
// (characters for text, items for sequence/movable), extended by marks
// (jj:mlntwtqv) and move (future).
//
// The shared positional algebra (retain/insert/delete) is captured by
// `Instruction` and `foldInstructions` in `change.ts`. The shared ref
// installation (write ops, readable, navigation, addressing, caching) is
// captured by the helpers in this module. Each interpreter transformer
// (`withWritable`, `withReadable`, etc.) delegates its sequence and
// movable cases to these helpers, adding only kind-specific behavior.
//
// Extensions compose orthogonally:
// - Marks extend the instruction stream (format ≡ retain positionally).
//   jj:mlntwtqv will add `installRichTextWriteOps` as a peer of
//   `installTextWriteOps`, sharing `at()`.
// - Move extends the change union (move is absolute-to-absolute, not
//   cursor-relative). Future plans will add `installMoveOps`.
//
// Kind-specific behavior remains in the interpreter cases:
// - text returns `string`, sequence/movable return `T[]`
// - text is a changefeed leaf, sequence/movable are composites
// - text has no `.at()`, `.length`, or `[Symbol.iterator]` (characters
//   are not independently addressable refs)
//
// **`text` straddles two families:** it is indexed for writable (shares
// `at()` and the retain/insert/delete instruction stream) but leaf for
// readable, navigation, and changefeed (returns `string` directly, not
// a fold over children). This dual membership is inherent — text IS a
// sequence of characters, but characters are not independently
// addressable refs.

import { richTextChange, sequenceChange, textChange } from "../change.js"
import { isPropertyHost } from "../guards.js"
import type { Path } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import { CALL } from "./bottom.js"
import type { WritableContext } from "./writable.js"

// ---------------------------------------------------------------------------
// at — cursor-positioning primitive
// ---------------------------------------------------------------------------

/**
 * Position cursor at `index`, then apply `op`.
 *
 * The sequence coalgebra's addressing primitive — shared by all indexed
 * write ops including future richtext (jj:mlntwtqv). This is the
 * cursor-positioning kernel: every positional mutation (insert, delete,
 * format) can be expressed as `at(index, op)`.
 */
export const at = <T>(index: number, op: T): (T | { retain: number })[] =>
  index > 0 ? [{ retain: index }, op] : [op]

// ---------------------------------------------------------------------------
// installTextWriteOps — insert / delete / update for text refs
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Install text mutation methods onto a ref: `insert`, `delete`, `update`.
 *
 * Extension point: jj:mlntwtqv will add `installRichTextWriteOps` as a
 * peer (not wrapper) — richtext's `insert` takes optional marks and
 * uses `richTextChange` instead of `textChange`. What IS shared is
 * `at()`, the cursor-positioning primitive.
 */
export function installTextWriteOps(
  result: any,
  ctx: WritableContext,
  path: Path,
): void {
  result.insert = (index: number, content: string): void => {
    ctx.dispatch(path, textChange(at(index, { insert: content })))
  }

  result.delete = (index: number, length: number): void => {
    ctx.dispatch(path, textChange(at(index, { delete: length })))
  }

  result.update = (content: string): void => {
    // Read current text length via store inspection (not carrier call)
    // so navigate+write stacks work without a reading layer.
    const current = ctx.reader.read(path)
    const currentLength = typeof current === "string" ? current.length : 0
    ctx.dispatch(
      path,
      textChange([
        ...(currentLength > 0 ? [{ delete: currentLength }] : []),
        { insert: content },
      ]),
    )
  }
}

// ---------------------------------------------------------------------------
// installRichTextWriteOps — insert / delete / update / mark / unmark for richtext refs
// ---------------------------------------------------------------------------

/**
 * Install richtext mutation methods onto a ref: `insert`, `delete`, `update`,
 * `mark`, `unmark`.
 *
 * A peer of `installTextWriteOps`, NOT a wrapper — richtext's `insert` takes
 * optional marks and uses `richTextChange` instead of `textChange`.
 * What IS shared is `at()`, the cursor-positioning primitive.
 */
export function installRichTextWriteOps(
  result: any,
  ctx: WritableContext,
  path: Path,
): void {
  result.insert = (
    index: number,
    content: string,
    marks?: Record<string, unknown>,
  ): void => {
    ctx.dispatch(
      path,
      richTextChange(
        at(index, marks ? { insert: content, marks } : { insert: content }),
      ),
    )
  }

  result.delete = (index: number, length: number): void => {
    ctx.dispatch(path, richTextChange(at(index, { delete: length })))
  }

  result.update = (content: string): void => {
    const current = ctx.reader.read(path)
    const currentLength = Array.isArray(current)
      ? (current as Array<{ text: string }>).reduce(
          (sum, span) => sum + span.text.length,
          0,
        )
      : 0
    ctx.dispatch(
      path,
      richTextChange([
        ...(currentLength > 0 ? [{ delete: currentLength }] : []),
        { insert: content },
      ]),
    )
  }

  result.mark = (
    start: number,
    end: number,
    key: string,
    value: unknown,
  ): void => {
    ctx.dispatch(
      path,
      richTextChange(
        at(start, { format: end - start, marks: { [key]: value } }),
      ),
    )
  }

  result.unmark = (start: number, end: number, key: string): void => {
    ctx.dispatch(
      path,
      richTextChange(
        at(start, { format: end - start, marks: { [key]: null } }),
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// installListWriteOps — push / insert / delete for sequence refs
// ---------------------------------------------------------------------------

/**
 * Wire list mutation methods onto a ref: `push`, `insert`, `delete`.
 *
 * Extension point: `move()` for movable lists (future); `mark()`/`unmark()`
 * for annotated lists (future). Both would be added as additional wiring
 * functions, not modifications to this one.
 */
export function installListWriteOps(
  result: any,
  ctx: WritableContext,
  path: Path,
): void {
  result.push = (...items: unknown[]): void => {
    const length = ctx.reader.arrayLength(path)
    const change = sequenceChange([{ retain: length }, { insert: items }])
    ctx.dispatch(path, change)
  }

  result.insert = (index: number, ...items: unknown[]): void => {
    ctx.dispatch(path, sequenceChange(at(index, { insert: items })))
  }

  result.delete = (index: number, count: number = 1): void => {
    ctx.dispatch(path, sequenceChange(at(index, { delete: count })))
  }
}

// ---------------------------------------------------------------------------
// installSequenceReadable — CALL slot (array snapshot) + .get(i)
// ---------------------------------------------------------------------------

/** Install the CALL slot (array snapshot) and `.get(i)` onto a sequence ref. */
export function installSequenceReadable(
  result: any,
  ctx: RefContext,
  path: Path,
): void {
  // Snapshot goes through result.at(i) — not the raw item closure —
  // to respect caching/addressing identity.
  result[CALL] = () => {
    const len = ctx.reader.arrayLength(path)
    const snapshot: unknown[] = []
    for (let i = 0; i < len; i++) {
      const child: unknown = result.at(i)
      snapshot.push(
        typeof child === "function" ? (child as () => unknown)() : child,
      )
    }
    return snapshot
  }

  Object.defineProperty(result, "get", {
    value: (index: number): unknown => {
      const child = result.at(index)
      return child !== undefined ? child() : undefined
    },
    enumerable: false,
    configurable: true,
  })
}

// ---------------------------------------------------------------------------
// installSequenceNavigation — .at(i), .length, [Symbol.iterator]
// ---------------------------------------------------------------------------

/** Install positional navigation (`.at(i)`, `.length`, `[Symbol.iterator]`) onto a sequence ref. */
export function installSequenceNavigation(
  result: any,
  ctx: RefContext,
  path: Path,
  item: (index: number) => unknown,
): void {
  Object.defineProperty(result, "at", {
    value: (index: number): unknown => {
      const len = ctx.reader.arrayLength(path)
      if (index < 0 || index >= len) return undefined
      return item(index)
    },
    enumerable: false,
    configurable: true,
  })

  Object.defineProperty(result, "length", {
    get() {
      return ctx.reader.arrayLength(path)
    },
    enumerable: false,
    configurable: true,
  })

  result[Symbol.iterator] = function* () {
    const len = ctx.reader.arrayLength(path)
    for (let i = 0; i < len; i++) {
      yield result.at(i)
    }
  }
}

// ---------------------------------------------------------------------------
// installSequenceAddressing — address table getter + prepare handler
// ---------------------------------------------------------------------------

/** Expose the address table via a symbol property and register a prepare handler for address advancement. */
export function installSequenceAddressing(
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

// ---------------------------------------------------------------------------
// installSequenceCaching — address-table-backed .at() override + INVALIDATE
// ---------------------------------------------------------------------------

/** Override `.at()` with address-table-backed lookup for stable ref identity across mutations. */
export function installSequenceCaching(
  result: any,
  path: Path,
  addressTableSym: symbol,
  invalidateSym: symbol,
  registerHandler: (path: Path, handler: (change: any) => void) => void,
): void {
  const baseAt = result.at as (index: number) => unknown

  Object.defineProperty(result, "at", {
    value: (index: number): unknown => {
      const addressTable = (result as any)[addressTableSym] as
        | {
            byIndex: Map<number, any>
            byId: Map<number, { address: any; ref: unknown }>
          }
        | undefined

      if (addressTable) {
        const addr = addressTable.byIndex.get(index)
        if (addr && addr.kind === "index") {
          const entry = addressTable.byId.get(addr.id)
          if (entry?.ref !== undefined) {
            return entry.ref
          }
        }
      }

      return baseAt.call(result, index)
    },
    enumerable: false,
    configurable: true,
  })

  // Addressing layer handles all structural changes, so the cache
  // layer has nothing to invalidate.
  const invalidateSequence = (_change: any): void => {}

  result[invalidateSym] = invalidateSequence

  registerHandler(path, invalidateSequence)
}
