// reader — reading σ, and advancing it by a change.
//
// σ is a plain state object held in a `StateCell`. Every substrate reads it
// through `plainReader` and advances it through `applyChange`, which copies
// the nodes a read froze before changing them, so a read never changes.

import type { ChangeBase } from "./change.js"
import { mapPayload } from "./change.js"
import { freezeTree, thaw } from "./clone.js"
import { isNonNullObject } from "./guards.js"
import type { Path } from "./path.js"
import { childOf, withChild } from "./plain-access.js"
import { stepInPlace } from "./step.js"

// ---------------------------------------------------------------------------
// FlatTreeNodeTopology — topology projection without per-node data
// ---------------------------------------------------------------------------

/**
 * Tree topology without per-node data — what `Reader.forestTopology`
 * returns. The catamorphism iterates topology and walks each node's data
 * lazily; interpreters that only need shape (addressing prepare-time
 * tombstoning) can iterate this without forcing per-node interpretation.
 *
 * Re-exported from `forest.ts` for proximity to its sibling types.
 */
export interface FlatTreeNodeTopology {
  readonly id: string
  readonly parent: string | null
  readonly index: number
}

// ---------------------------------------------------------------------------
// PlainState type
// ---------------------------------------------------------------------------

/**
 * σ, the document as a plain JS object. Every substrate keeps one, and every
 * read of a ref is served from it.
 */
export type PlainState = Record<string, unknown>

/** σ's root. A write that copies a frozen root replaces `current`. */
export interface StateCell {
  current: PlainState
}

// ---------------------------------------------------------------------------
// Reader — abstract read interface for interpreter state access
// ---------------------------------------------------------------------------

/**
 * Abstract read interface over σ, for refs and interpreters.
 *
 * Interpreters read from state exclusively through this interface,
 * allowing substrates to provide their own read semantics. The plain
 * substrate wraps a `Record<string, unknown>` via `plainReader`;
 * a Loro substrate navigates the Loro container tree directly.
 */
export interface Reader {
  /** Read the value at the given path. */
  read(path: Path): unknown
  /** Length of the sequence at the given path. */
  arrayLength(path: Path): number
  /** Keys of the map/product at the given path. */
  keys(path: Path): string[]
  /** Whether the map/product at the given path contains the key. */
  hasKey(path: Path, key: string): boolean
  /**
   * Topology at a `Schema.tree` path — substrate-blind. The third reader
   * family (after value reads and length/keys) — kept here so the
   * catamorphism's `tree` case has a uniform topology source across
   * substrates. Returns `[]` for substrates that don't support trees.
   */
  forestTopology(path: Path): readonly FlatTreeNodeTopology[]
}

/**
 * A Reader over the state in `cell`. Each read starts at `cell.current`, so
 * the reader sees every write `applyChange` makes, including one that
 * replaced a frozen root.
 *
 * Other substrates may provide their own Reader over a different backing
 * structure.
 */
export function plainReader(cell: StateCell): Reader {
  return {
    read: path => path.read(cell.current),
    arrayLength: path => readArrayLength(cell.current, path),
    keys: path => readKeys(cell.current, path),
    hasKey: (path, key) => readHasKey(cell.current, path, key),
    forestTopology: path => readForestTopology(cell.current, path),
  }
}

function readForestTopology(
  state: unknown,
  path: Path,
): readonly FlatTreeNodeTopology[] {
  return forestTopologyOf(path.read(state))
}

/**
 * Project topology from the `stepTree` shadow shape. Defensive `[]`
 * fallback covers callers that hit a non-tree value with a tree-typed
 * reader (e.g. ill-formed test fixtures).
 */
export function forestTopologyOf(
  value: unknown,
): readonly FlatTreeNodeTopology[] {
  if (!Array.isArray(value)) return []
  const result: FlatTreeNodeTopology[] = []
  for (const n of value) {
    if (isNonNullObject(n) && typeof n.id === "string") {
      result.push({
        id: n.id as string,
        parent: (n.parent as string | null) ?? null,
        index: (n.index as number) ?? 0,
      })
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Read helpers (internal — used only by plainReader)
// ---------------------------------------------------------------------------

/**
 * Returns the length of the array at the given path.
 * Returns 0 if the value is not an array.
 */
function readArrayLength(state: unknown, path: Path): number {
  const arr = path.read(state)
  return Array.isArray(arr) ? arr.length : 0
}

/**
 * Returns the keys of the object at the given path.
 * Returns an empty array if the value is not a non-null object.
 */
function readKeys(state: unknown, path: Path): string[] {
  const obj = path.read(state)
  return isNonNullObject(obj) ? Object.keys(obj) : []
}

/**
 * Returns true if the object at the given path has the specified key.
 * Returns false if the value is not a non-null object or the key is missing.
 */
function readHasKey(state: unknown, path: Path, key: string): boolean {
  const obj = path.read(state)
  return isNonNullObject(obj) && Object.hasOwn(obj, key)
}

// ---------------------------------------------------------------------------
// Change application
// ---------------------------------------------------------------------------

/**
 * The change with its payload frozen in place, ready for the store to share.
 *
 * Precondition: the store owns the payload, so nobody else can change it.
 * Every path to the store does: the write helpers copy what a caller passes
 * (`own` in `change.ts`), wire payloads are decoded fresh, `diffOps` copies
 * what it carries, undo builds its own, and `applyChanges` takes ownership of
 * the ops it is handed.
 *
 * The op a subscriber receives and σ then share each value the change
 * carries (`mapPayload` says which). Neither can change it: the op because it
 * is frozen, σ because a write copies a frozen node before changing it
 * (`applyChange`).
 *
 * Takes a completed change (`completeChange` in `complete.ts`), so σ and the
 * op hold the completed value.
 */
export function freezePayload(change: ChangeBase): ChangeBase {
  return mapPayload(change, freezeTree)
}

/**
 * Advance σ at `path` by `change`.
 *
 * Copy-on-write: a frozen node is shared with readers, so the walk from the
 * root thaws each container on the path (`thaw`, a one-level copy of a frozen
 * node) and links the copy into its parent, which is unfrozen by then. A
 * frozen root's copy becomes `cell.current`. The target is thawed too, then
 * advanced in place (`stepInPlace`). A node nobody has read is unfrozen and
 * changes in place, at O(|change|); a node a reader froze is copied one level,
 * and only on the spine to the target.
 *
 * A missing intermediate container is created. A dead segment throws: a write
 * to a deleted ref fails.
 */
export function applyChange(
  cell: StateCell,
  path: Path,
  change: ChangeBase,
): void {
  const segments = path.segments
  for (const segment of segments) segment.resolve()
  const last = segments[segments.length - 1]
  if (last === undefined) {
    const next = stepInPlace(thaw(cell.current), change)
    if (isNonNullObject(next)) cell.current = next
    return
  }
  let parent: object = thaw(cell.current)
  cell.current = parent as PlainState
  for (const segment of segments.slice(0, -1)) {
    const child = childOf(parent, segment)
    const container = isNonNullObject(child) ? thaw(child) : {}
    if (container !== child && !withChild(parent, segment, container)) return
    parent = container
  }
  const target = childOf(parent, last)
  const next = stepInPlace(thaw(target), change)
  if (next !== target) withChild(parent, last, next)
}
