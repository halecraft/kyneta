// path — typed path infrastructure for the interpreter stack.
//
// Two implementations of a single Path interface:
//
// - RawPath: external, serializable, positional. Segments are immutable
//   value objects (`{ type: "field" | "entry" | "index", ... }`). Used by
//   wire formats, external ops, and non-addressing stacks.
//
// - AddressedPath: internal, identity-stable, tombstone-aware. Segments
//   are Address objects with mutable indices (sequences) and liveness
//   flags, owned by a `CoordinateTrie`. Used by the interpreter stack when
//   withAddressing is composed in.
//
// Consumers use the Path interface uniformly — field(), item(), key,
// read(), format(), slice(), concat(). They never branch on path kind.
// The concrete type is determined by the root path (set on context by
// withAddressing or defaulting to RawPath.empty), inherited by all
// descendants via field()/item().

import type { CoordinateTrie } from "./coordinate-trie.js"
import { childOf } from "./plain-access.js"

// ---------------------------------------------------------------------------
// Segment — the minimal contract for a path segment
// ---------------------------------------------------------------------------

/**
 * The minimal contract for a path segment. Both `RawSegment` and
 * `Address` implement this interface.
 *
 * `role` is what makes identity-keying (`resolveContainer`) a segment-local
 * predicate — `binding && seg.role === "field"`. Without the role split,
 * identity-keying had to sniff the parent schema's kind to decide whether
 * a key belonged to a declared product field or a runtime container key.
 *
 *  - `"field"` — declared product field. Identity-keyed at binding boundaries.
 *  - `"entry"` — runtime string key (map / set / tree node id). Not identity-keyed.
 *  - `"index"` — runtime numeric position (sequence / movable).
 */
export interface Segment {
  /**
   * The functorial role. Construction sites pick the role from the kind
   * case that built the segment (`product` → "field"; `map`/`set`/`tree`
   * → "entry"; `sequence`/`movable` → "index").
   */
  readonly role: "field" | "entry" | "index"

  /**
   * Resolve this segment to a store-access key (string or number),
   * asserting liveness. For dead addresses, throws a descriptive error.
   *
   * Use `resolve()` only where a dead segment is a genuine bug that must
   * fail loudly — writing through a path (`applyChange`) or live ref
   * navigation. For coordinate-only reads (serialization, `format()`,
   * identity `key`, schema/position walks, `read()`), use `coord()` — a
   * since-deleted key is still a valid coordinate, and diagnostics must
   * never throw. Context: jj:mlurlzqt.
   */
  resolve(): string | number

  /**
   * Project this segment to its coordinate (key or index) — total, pure,
   * never throws, even for a dead address. The coordinate is an invariant
   * of the segment (`readonly key` / `index`); liveness is orthogonal
   * temporal state. This is the accessor for history, diagnostics, and
   * identity. Context: jj:mlurlzqt.
   */
  coord(): string | number

  /**
   * The segment's identity key, the unit `Path.key` is built from: `@${id}`
   * for an addressed index, whose position moves while its identity does
   * not, and the coordinate as a string for everything else.
   */
  readonly identity: string

  /**
   * Whether the coordinate this segment names is gone. Only an `Address`
   * can die; a raw segment names a coordinate, not a live one.
   */
  readonly dead?: boolean
}

// ---------------------------------------------------------------------------
// RawSegment — positional, serializable segment
// ---------------------------------------------------------------------------

/**
 * A raw path segment — the existing segment shape, now implementing
 * `Segment`. Created by `rawField()`, `rawEntry()`, and `rawIndex()`
 * factory functions.
 *
 * `type` is the wire-format discriminant; `role` and `resolve()` are the
 * `Segment` interface contract used by the interpreter stack.
 */
export type RawSegment =
  | {
      readonly type: "field"
      readonly field: string
      readonly role: "field"
      readonly identity: string
      resolve(): string
      coord(): string
    }
  | {
      readonly type: "entry"
      readonly entry: string
      readonly role: "entry"
      readonly identity: string
      resolve(): string
      coord(): string
    }
  | {
      readonly type: "index"
      readonly index: number
      readonly role: "index"
      readonly identity: string
      resolve(): number
      coord(): number
    }

/** Declared product field segment. Identity-keyed at binding boundaries. */
export function rawField(key: string): RawSegment {
  // Raw segments are already liveness-agnostic, so `coord` and `resolve`
  // coincide (neither throws). The split matters only for `Address`.
  return {
    type: "field",
    field: key,
    role: "field",
    identity: key,
    resolve: () => key,
    coord: () => key,
  }
}

/** Runtime string-key segment for map entries, set members, tree node ids. */
export function rawEntry(key: string): RawSegment {
  return {
    type: "entry",
    entry: key,
    role: "entry",
    identity: key,
    resolve: () => key,
    coord: () => key,
  }
}

/** Numeric position segment for sequences and movable lists. */
export function rawIndex(index: number): RawSegment {
  return {
    type: "index",
    index,
    role: "index",
    identity: String(index),
    resolve: () => index,
    coord: () => index,
  }
}

// ---------------------------------------------------------------------------
// Address — identity-stable, tombstone-aware segment
// ---------------------------------------------------------------------------

/**
 * An address is the internal, identity-stable, tombstone-aware segment.
 *
 * Tombstone checking is built into the segment via `resolve()` rather
 * than the path or the caller — refs holding a stale address fail loudly
 * the moment they try to navigate, not later via silent undefined reads.
 *
 *  - `"field"` — declared product fields. Dies while its parent's schema, with
 *    any sum resolved from the state, does not declare it.
 *  - `"entry"` — map entries, set members, tree node ids. Dies while its key
 *    or id is absent.
 *  - `"index"` — sequences. Mutable `index` (advanced on structural change),
 *    stable `id`. Dies with its item, for good.
 *
 * A dead field or entry address comes back to life when its coordinate exists
 * again (see `CoordinateTrie` and `planAddressFates`).
 */
export type Address =
  | {
      readonly kind: "field"
      readonly key: string
      dead: boolean
      listeners?: Set<() => void>
      readonly role: "field"
      readonly identity: string
      resolve(): string
      coord(): string
    }
  | {
      readonly kind: "entry"
      readonly key: string
      dead: boolean
      listeners?: Set<() => void>
      readonly role: "entry"
      readonly identity: string
      resolve(): string
      coord(): string
    }
  | {
      readonly kind: "index"
      readonly id: number
      index: number
      dead: boolean
      listeners?: Set<() => void>
      readonly role: "index"
      readonly identity: string
      resolve(): number
      coord(): number
    }

// ---------------------------------------------------------------------------
// IndexAddress — the index variant of Address, extracted as a type
// ---------------------------------------------------------------------------

/**
 * The index variant of `Address` — an address with a mutable position
 * and stable identity, used for sequence items.
 *
 * This is not a separate interface but a type extraction from the
 * `Address` union. The `Address` member `{ kind: "index", id, index,
 * dead }` IS the index address — no separate indirection needed.
 */
export type IndexAddress = Address & { readonly kind: "index" }

// ---------------------------------------------------------------------------
// Address ID counter
// ---------------------------------------------------------------------------

let _nextAddressId = 1

/**
 * Allocate a globally unique address ID.
 */
export function nextAddressId(): number {
  return _nextAddressId++
}

/**
 * Reset the address ID counter. For testing only.
 */
export function resetAddressIdCounter(): void {
  _nextAddressId = 1
}

// ---------------------------------------------------------------------------
// Address factory functions
// ---------------------------------------------------------------------------

/**
 * Field address for declared product fields and sums. Dead while the parent's
 * schema, with any sum resolved from the state, does not declare the field.
 */
export function fieldAddress(key: string, dead = false): Address {
  return {
    kind: "field",
    key,
    dead,
    role: "field",
    identity: key,
    resolve() {
      if (this.dead) {
        throw new Error(
          `Ref access on deleted product field. The field "${this.key}" this ref pointed to has been removed.`,
        )
      }
      return this.key
    },
    coord() {
      return this.key
    },
  }
}

/**
 * Entry address for runtime string keys (map entries, set members, tree
 * node ids). Tombstones on delete; subsequent `.resolve()` throws.
 */
export function entryAddress(key: string, dead = false): Address {
  return {
    kind: "entry",
    key,
    dead,
    role: "entry",
    identity: key,
    resolve() {
      if (this.dead) {
        throw new Error(
          `Ref access on deleted map entry. The entry "${this.key}" this ref pointed to has been removed.`,
        )
      }
      return this.key
    },
    coord() {
      return this.key
    },
  }
}

/**
 * Create an index-based address (for sequences).
 */
export function indexAddress(index: number, dead = false): Address {
  const id = nextAddressId()
  return {
    kind: "index",
    id,
    index,
    dead,
    role: "index",
    identity: `@${id}`,
    resolve() {
      if (this.dead) {
        throw new Error(
          `Ref access on deleted list item. The item this ref pointed to has been removed.`,
        )
      }
      return this.index
    },
    coord() {
      return this.index
    },
  }
}

/**
 * Set an address's liveness, calling its death listeners when it changes.
 * The one way an address dies or comes back, so `[DELETED]` subscribers
 * always hear.
 */
export function setDead(address: Address, dead: boolean): void {
  if (address.dead === dead) return
  address.dead = dead
  if (address.listeners) {
    for (const callback of [...address.listeners]) callback()
  }
}

// ---------------------------------------------------------------------------
// Path — the uniform interface
// ---------------------------------------------------------------------------

/**
 * A typed path through the schema tree. Two implementations:
 *
 * - `RawPath`: external, serializable, positional.
 * - `AddressedPath`: internal, identity-stable, tombstone-aware.
 *
 * Consumers use `Path` uniformly and never branch on path kind. The
 * three structural appenders mirror `Segment.role`:
 * `field(key)`, `entry(key)`, `item(index)`. `node(id)` is sugar for
 * `entry(id)` — preferred at tree-node call sites for clarity.
 */
export interface Path {
  /** Declared product field. Identity-keyed at binding boundaries. */
  field(key: string): Path
  /** Runtime string key — map entries, set members, tree node ids. */
  entry(key: string): Path
  /** Sugar for `entry(id)` at tree-node call sites. */
  node(id: string): Path
  /** Numeric position — sequence / movable list items. */
  item(index: number): Path
  /**
   * Identity-stable string key for routing, caching, subscription maps.
   *
   * Addressed paths produce stable keys ("@address.id"); raw paths
   * produce positional keys. Memoized on first access.
   */
  readonly key: string
  /**
   * Each segment's `identity`, in order: what the coordinate and subscriber
   * tries descend by. `key` joins them with a separator that a segment's own
   * text may contain, so cutting a key can invent a level that does not exist.
   */
  readonly segmentKeys: readonly string[]
  /** The segments of this path. */
  readonly segments: readonly Segment[]
  /** Number of segments. */
  readonly length: number
  /** Slice to produce an ancestor path (same concrete type). */
  slice(start: number, end?: number): Path
  /** Concatenate two paths (same concrete type). Throws on type mismatch. */
  concat(other: Path): Path
  /** Resolve this path against a plain store object, returning the value at this path. */
  read(store: unknown): unknown
  /** Whether this is an addressed (live-handle) path vs raw (location-description). */
  readonly isAddressed: boolean
  /** Human-readable string for error messages (e.g. "todos[2].done"). */
  format(): string
  /** Create an empty path of the same concrete type. */
  root(): Path
  /**
   * Project to an immutable, liveness-agnostic `RawPath` — the value form
   * every `Op` holds, and so the op-log and the wire. Idempotent on `RawPath` (returns
   * `this`); on `AddressedPath` it reads each segment's `coord()` so the
   * result never aliases the live addressing trie. The named inverse
   * of `resolveToAddressed`. Context: jj:mlurlzqt.
   */
  toRaw(): RawPath
}

// ---------------------------------------------------------------------------
// AbstractPath — shared implementation
// ---------------------------------------------------------------------------

/**
 * Base class with shared `read()`, `format()`, and memoized `key`
 * getter. `RawPath` and `AddressedPath` extend this.
 */
export abstract class AbstractPath implements Path {
  abstract readonly segments: readonly Segment[]
  abstract readonly isAddressed: boolean
  abstract field(key: string): Path
  abstract entry(key: string): Path
  abstract item(index: number): Path
  abstract slice(start: number, end?: number): Path
  abstract concat(other: Path): Path
  abstract root(): Path
  abstract toRaw(): RawPath

  /** Sugar for `entry(id)`. */
  node(id: string): Path {
    return this.entry(id)
  }

  get length(): number {
    return this.segments.length
  }

  /**
   * Memoized, like `key`. Safe because segments are
   * readonly and a segment's key uses only stable identities (`address.id`,
   * not `address.index`).
   */
  private _segmentKeys: readonly string[] | undefined
  get segmentKeys(): readonly string[] {
    this._segmentKeys ??= this.segments.map(segment => segment.identity)
    return this._segmentKeys
  }

  private _key: string | undefined
  get key(): string {
    this._key ??= this.segmentKeys.join("\0")
    return this._key
  }

  read(store: unknown): unknown {
    let current = store
    for (const seg of this.segments) current = childOf(current, seg)
    return current
  }

  format(): string {
    if (this.segments.length === 0) return "root"
    let result = ""
    for (const seg of this.segments) {
      // `coord()`, not `resolve()`: `format()` feeds error messages, so it
      // must be total — a dead segment must not throw here and mask the real
      // error being reported. jj:mlurlzqt
      if (seg.role === "field" || seg.role === "entry") {
        if (result.length > 0) result += "."
        result += String(seg.coord())
      } else {
        result += `[${seg.coord()}]`
      }
    }
    return result
  }
}

// ---------------------------------------------------------------------------
// RawPath — external, serializable, positional
// ---------------------------------------------------------------------------

/**
 * A raw path — the external, serializable, positional path.
 *
 * Segments are immutable `RawSegment` value objects. `key` produces
 * positional strings (same behavior as the old `pathKey()` free
 * function). `field()` and `item()` are pure — no side effects.
 */
export class RawPath extends AbstractPath {
  constructor(readonly segments: readonly RawSegment[]) {
    super()
  }

  readonly isAddressed = false as const

  field(key: string): RawPath {
    return new RawPath([...this.segments, rawField(key)])
  }

  entry(key: string): RawPath {
    return new RawPath([...this.segments, rawEntry(key)])
  }

  override node(id: string): RawPath {
    return this.entry(id)
  }

  item(index: number): RawPath {
    return new RawPath([...this.segments, rawIndex(index)])
  }

  /** Already raw — identity projection. */
  toRaw(): RawPath {
    return this
  }

  slice(start: number, end?: number): RawPath {
    return new RawPath(this.segments.slice(start, end))
  }

  concat(other: Path): Path {
    if (other.isAddressed) {
      // The other path is addressed — promote this RawPath to addressed
      // using the other's trie, then concat as AddressedPaths.
      const addressed = other as AddressedPath
      const selfAsAddressed = resolveToAddressed(this, addressed.trie)
      return selfAsAddressed.concat(addressed)
    }
    return new RawPath([...this.segments, ...(other as RawPath).segments])
  }

  root(): RawPath {
    return RawPath.empty
  }

  static readonly empty: RawPath = new RawPath([])
}

// ---------------------------------------------------------------------------
// AddressedPath — internal, identity-stable, tombstone-aware
// ---------------------------------------------------------------------------

/**
 * An addressed path — the internal, identity-stable, tombstone-aware path.
 *
 * Segments are `Address` objects. `key` produces identity-stable strings
 * (address.id for sequences, key string for fields/entries). `field()`,
 * `entry()`, and `item()` are **effectful** — they ask the context's
 * `CoordinateTrie` for the child's address, creating its node on first use.
 * The effect is idempotent: calling with the same arguments returns the same
 * `Address` object while the coordinate stays in the trie.
 */
export class AddressedPath extends AbstractPath {
  // Private, so a path does not carry the whole trie into a `JSON.stringify`
  // of an op, or anything else that walks its own properties.
  readonly #trie: CoordinateTrie

  constructor(
    readonly segments: readonly Address[],
    trie: CoordinateTrie,
  ) {
    super()
    this.#trie = trie
  }

  /** The coordinates this path's addresses belong to. */
  get trie(): CoordinateTrie {
    return this.#trie
  }

  readonly isAddressed = true as const

  field(key: string): AddressedPath {
    return this.child(this.trie.fieldAddress(this, key))
  }

  entry(key: string): AddressedPath {
    return this.child(this.trie.entryAddress(this, key))
  }

  override node(id: string): AddressedPath {
    return this.entry(id)
  }

  item(index: number): AddressedPath {
    return this.child(this.trie.itemAddress(this, index))
  }

  /** This path extended by `address`, which the caller got from the trie. */
  child(address: Address): AddressedPath {
    return new AddressedPath([...this.segments, address], this.trie)
  }

  slice(start: number, end?: number): AddressedPath {
    return new AddressedPath(this.segments.slice(start, end), this.trie)
  }

  concat(other: Path): AddressedPath {
    if (!other.isAddressed) {
      // The other path is raw — resolve it to addressed using our trie,
      // then concat as AddressedPaths.
      const otherAddressed = resolveToAddressed(other as RawPath, this.trie)
      return new AddressedPath(
        [...this.segments, ...otherAddressed.segments],
        this.trie,
      )
    }
    return new AddressedPath(
      [...this.segments, ...(other as AddressedPath).segments],
      this.trie,
    )
  }

  root(): AddressedPath {
    return new AddressedPath([], this.trie)
  }

  /**
   * Freeze to an immutable `RawPath` by projecting each `Address` to its
   * coordinate via `coord()` (never `resolve()` — this must succeed even
   * for a `dead` address, e.g. an entry deleted after the op was authored).
   * The named inverse of `resolveToAddressed`. The op-log and wire hold
   * these values, so history never aliases the mutable trie.
   * Context: jj:mlurlzqt.
   */
  toRaw(): RawPath {
    let raw = RawPath.empty
    for (const seg of this.segments) {
      if (seg.role === "field") raw = raw.field(seg.coord() as string)
      else if (seg.role === "entry") raw = raw.entry(seg.coord() as string)
      else raw = raw.item(seg.coord() as number)
    }
    return raw
  }

  /**
   * Access the last segment as an Address (for ref registration).
   */
  lastAddress(): Address | undefined {
    return this.segments[this.segments.length - 1]
  }
}

// ---------------------------------------------------------------------------
// resolveToAddressed — convert a RawPath to an AddressedPath
// ---------------------------------------------------------------------------

/**
 * Resolve a path to an `AddressedPath` in the given trie.
 *
 * - If the path is already addressed in this trie, return it as-is
 *   (idempotent).
 * - Otherwise walk its coordinates from the root, taking (or creating) each
 *   coordinate's address from the trie. A path addressed in another
 *   document's trie is walked too: its addresses say nothing about which
 *   coordinates are alive here. Returns an `AddressedPath` whose
 *   `.key` matches the keys used by changefeed listeners and the trie.
 *
 * This is the single point where raw→addressed translation happens. The
 * prepare pipeline calls it once per op, before any stage runs, so
 * `path.key` on an incoming external change matches the identity-stable
 * keys used internally. The inverse — addressed→raw, for freezing history —
 * is `AddressedPath.toRaw()`.
 */
export function resolveToAddressed(
  path: Path,
  trie: CoordinateTrie,
): AddressedPath {
  if (path instanceof AddressedPath && path.trie === trie) return path

  let current = new AddressedPath([], trie)
  for (const seg of path.segments) {
    if (seg.role === "field") {
      current = current.field(seg.coord() as string)
    } else if (seg.role === "entry") {
      current = current.entry(seg.coord() as string)
    } else {
      current = current.item(seg.coord() as number)
    }
  }
  return current
}
