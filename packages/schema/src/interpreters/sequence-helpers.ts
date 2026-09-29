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

import { own, richTextChange, sequenceChange, textChange } from "../change.js"
import type { Path } from "../interpret.js"
import type { RefContext } from "../interpreter-types.js"
import { CALL, type Mutable, type NavigableCarrier } from "./bottom.js"
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
export interface TextWriteOps {
  readonly insert: (index: number, content: string) => void
  readonly delete: (index: number, length: number) => void
  readonly update: (content: string) => void
}

export function installTextWriteOps<T extends object>(
  result: T,
  ctx: WritableContext,
  path: Path,
): asserts result is T & TextWriteOps {
  const ops = result as Mutable<TextWriteOps>

  ops.insert = (index: number, content: string): void => {
    ctx.dispatch(path, textChange(at(index, { insert: content })))
  }

  ops.delete = (index: number, length: number): void => {
    ctx.dispatch(path, textChange(at(index, { delete: length })))
  }

  ops.update = (content: string): void => {
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
export interface RichTextWriteOps {
  readonly insert: (
    index: number,
    content: string,
    marks?: Record<string, unknown>,
  ) => void
  readonly delete: (index: number, length: number) => void
  readonly update: (content: string) => void
  readonly mark: (
    start: number,
    end: number,
    key: string,
    value: unknown,
  ) => void
  readonly unmark: (start: number, end: number, key: string) => void
}

export function installRichTextWriteOps<T extends object>(
  result: T,
  ctx: WritableContext,
  path: Path,
): asserts result is T & RichTextWriteOps {
  const ops = result as Mutable<RichTextWriteOps>

  ops.insert = (
    index: number,
    content: string,
    marks?: Record<string, unknown>,
  ): void => {
    ctx.dispatch(
      path,
      richTextChange(
        at(
          index,
          marks ? { insert: content, marks: own(marks) } : { insert: content },
        ),
      ),
    )
  }

  ops.delete = (index: number, length: number): void => {
    ctx.dispatch(path, richTextChange(at(index, { delete: length })))
  }

  ops.update = (content: string): void => {
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

  ops.mark = (
    start: number,
    end: number,
    key: string,
    value: unknown,
  ): void => {
    ctx.dispatch(
      path,
      richTextChange(
        at(start, { format: end - start, marks: own({ [key]: value }) }),
      ),
    )
  }

  ops.unmark = (start: number, end: number, key: string): void => {
    ctx.dispatch(
      path,
      richTextChange(
        at(start, { format: end - start, marks: own({ [key]: null }) }),
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
export interface ListWriteOps {
  readonly push: (...items: unknown[]) => void
  readonly insert: (index: number, ...items: unknown[]) => void
  readonly delete: (index: number, count?: number) => void
}

export function installListWriteOps<T extends object>(
  result: T,
  ctx: WritableContext,
  path: Path,
): asserts result is T & ListWriteOps {
  const ops = result as Mutable<ListWriteOps>

  ops.push = (...items: unknown[]): void => {
    const length = ctx.reader.arrayLength(path)
    const change = sequenceChange([
      { retain: length },
      { insert: items.map(item => own(item)) },
    ])
    ctx.dispatch(path, change)
  }

  ops.insert = (index: number, ...items: unknown[]): void => {
    ctx.dispatch(
      path,
      sequenceChange(at(index, { insert: items.map(item => own(item)) })),
    )
  }

  ops.delete = (index: number, count: number = 1): void => {
    ctx.dispatch(path, sequenceChange(at(index, { delete: count })))
  }
}

// ---------------------------------------------------------------------------
// installSequenceReadable — CALL slot (array snapshot) + .get(i)
// ---------------------------------------------------------------------------

/** Install the CALL slot (array snapshot) and `.get(i)` onto a sequence ref. */
export interface SequenceReadable {
  readonly [CALL]: () => unknown[]
  readonly get: (index: number) => unknown
}

export function installSequenceReadable<T extends object>(
  result: T,
  ctx: RefContext,
  path: Path,
): asserts result is T & SequenceReadable {
  // `.at` comes from `installSequenceNavigation`, one layer further in. Layers
  // describe each other with phantom brands rather than structurally, so it is
  // not visible in `T` — named here rather than hidden behind `any`.
  const navigable = result as NavigableCarrier<number>

  // Snapshot goes through result.at(i) — not the raw item closure —
  // to respect caching/addressing identity.
  Object.defineProperty(result, CALL, {
    value: (): unknown[] => {
      const len = ctx.reader.arrayLength(path)
      const snapshot: unknown[] = []
      for (let i = 0; i < len; i++) {
        const child: unknown = navigable.at(i)
        snapshot.push(
          typeof child === "function" ? (child as () => unknown)() : child,
        )
      }
      return snapshot
    },
    enumerable: true,
    configurable: true,
    writable: true,
  })

  Object.defineProperty(result, "get", {
    value: (index: number): unknown => {
      const child = navigable.at(index)
      return typeof child === "function"
        ? (child as () => unknown)()
        : undefined
    },
    enumerable: false,
    configurable: true,
  })
}

// ---------------------------------------------------------------------------
// installSequenceNavigation — .at(i), .length, [Symbol.iterator]
// ---------------------------------------------------------------------------

/** Install positional navigation (`.at(i)`, `.length`, `[Symbol.iterator]`) onto a sequence ref. */
export interface SequenceNavigation {
  readonly at: (index: number) => unknown
  readonly length: number
  readonly [Symbol.iterator]: () => IterableIterator<unknown>
}

export function installSequenceNavigation<T extends object>(
  result: T,
  ctx: RefContext,
  path: Path,
  item: (index: number) => unknown,
): asserts result is T & SequenceNavigation {
  // Iterate through the carrier's own `.at`, so a later caching or addressing
  // layer that overrides it is respected.
  const navigable = result as Mutable<SequenceNavigation>
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

  navigable[Symbol.iterator] = function* (): IterableIterator<unknown> {
    const len = ctx.reader.arrayLength(path)
    for (let i = 0; i < len; i++) {
      yield navigable.at(i)
    }
  }
}

// ---------------------------------------------------------------------------
// installSequenceCaching — address-table-backed .at() override
// ---------------------------------------------------------------------------

/** Override `.at()` with address-table-backed lookup for stable ref identity across mutations. */
export function installSequenceCaching(
  result: object,
  addressTableSym: symbol,
): void {
  // The symbol arrives as a parameter, so its slot cannot be named in a type.
  // This helper narrows rather than asserts for that reason.
  const slots = result as Record<symbol, unknown> & NavigableCarrier<number>
  const baseAt = slots.at

  Object.defineProperty(result, "at", {
    value: (index: number): unknown => {
      const addressTable = slots[addressTableSym] as
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
}
