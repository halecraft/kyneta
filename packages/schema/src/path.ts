// path — paths, segments and addresses.
//
// Two implementations of a single Path interface:
//
// - RawPath: external, serializable, positional. Segments are immutable
//   value objects (`{ type: "field" | "entry" | "index", ... }`). Every op
//   holds one, so the wire, the log and undo records do.
//
// - AddressedPath: internal, identity-stable, tombstone-aware. Its segments
//   are addresses, each a coordinate of a context's `CoordinateTrie`, with a
//   mutable index (list items) and liveness, and raw segments below the
//   trie's reach. Refs hold one, and `prepare` locates every op's path as
//   one.
//
// Consumers use the Path interface uniformly — field(), item(), key,
// read(), format(), slice(), concat(). They never branch on path kind.

import type { CoordinateTrie } from "./coordinate-trie.js"
import { childOf } from "./plain-access.js"
import type { Schema as SchemaNode } from "./schema.js"

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
   * The segment's identity, the unit `Path.key` is built from: an addressed
   * index's `id`, a number, since its position moves while its identity does
   * not, and the coordinate as a string for everything else. A raw index's
   * identity is a string, so it never equals an id in a map.
   */
  readonly identity: string | number

  /**
   * Whether the coordinate this segment names is gone. Only an `Address`
   * can die; a raw segment names a coordinate, not a live one.
   */
  readonly dead?: boolean
}

// ---------------------------------------------------------------------------
// RawSegment — positional, serializable segment
// ---------------------------------------------------------------------------

// A raw segment names a coordinate, not a live one, so `resolve` and `coord`
// coincide and neither throws. Both live on the prototype: a logged op keeps
// its path, and a closure per segment would be kept with it.

/** A declared product field. Identity-keyed at binding boundaries. */
export class RawField {
  readonly type = "field" as const
  readonly role = "field" as const
  readonly identity: string
  /** A raw segment names a coordinate, not a live one: never dead. */
  declare readonly dead?: undefined

  constructor(readonly field: string) {
    this.identity = field
  }

  resolve(): string {
    return this.field
  }

  coord(): string {
    return this.field
  }
}

/** A runtime string key: a map entry, set member or tree node id. */
export class RawEntry {
  readonly type = "entry" as const
  readonly role = "entry" as const
  readonly identity: string
  /** A raw segment names a coordinate, not a live one: never dead. */
  declare readonly dead?: undefined

  constructor(readonly entry: string) {
    this.identity = entry
  }

  resolve(): string {
    return this.entry
  }

  coord(): string {
    return this.entry
  }
}

/** A numeric position in a sequence or movable list. */
export class RawIndex {
  readonly type = "index" as const
  readonly role = "index" as const
  readonly identity: string
  /** A raw segment names a coordinate, not a live one: never dead. */
  declare readonly dead?: undefined

  constructor(readonly index: number) {
    this.identity = String(index)
  }

  resolve(): number {
    return this.index
  }

  coord(): number {
    return this.index
  }
}

/**
 * A raw path segment: positional and serializable. `type` is the wire-format
 * discriminant; `role`, `resolve()` and `coord()` are the `Segment` contract.
 */
export type RawSegment = RawField | RawEntry | RawIndex

/** Declared product field segment. Identity-keyed at binding boundaries. */
export function rawField(key: string): RawField {
  return new RawField(key)
}

/** Runtime string-key segment for map entries, set members, tree node ids. */
export function rawEntry(key: string): RawEntry {
  return new RawEntry(key)
}

/** Numeric position segment for sequences and movable lists. */
export function rawIndex(index: number): RawIndex {
  return new RawIndex(index)
}

// ---------------------------------------------------------------------------
// Address — identity-stable, tombstone-aware segment
// ---------------------------------------------------------------------------

/**
 * What a context's `CoordinateTrie` keeps for one coordinate. An address is
 * one (`AddressBase`), and the trie's root is one that is no segment: one
 * object per coordinate.
 *
 * Every coordinate of a class has one shape: each slot is declared, and
 * the children map is made with the first child.
 */
export abstract class Coordinate {
  /** Callbacks for a change of liveness, the `[DELETED]` feed's subscribers. */
  listeners: Set<() => void> | undefined = undefined
  /** The schema the ref here was made with, a sum's own schema at a sum.
   *  Kept current by the fates walk (`planAddressFates`). */
  schema: SchemaNode | undefined = undefined
  /** The canonical ref of a list item, record entry or tree node, held
   *  weakly: `.at` hands it back while something else holds it. */
  ref: WeakRef<object> | undefined = undefined
  /**
   * Live refs anchored here, counted up when one is made and down when one
   * is collected. A ref is anchored where its parent does not hold it: at the
   * root, a list item, a record entry or a tree node. A product's field refs
   * and a sum's variants are not counted: they and their parent ref hold each
   * other, so they live exactly as long as it does, and a field's coordinate
   * is held by the refs of the nearest anchor at or above it.
   */
  refs = 0
  #children: Map<string | number, Address> | undefined = undefined

  constructor(public dead: boolean) {}

  /**
   * The coordinates below this one, by coordinate: a field's or entry's key,
   * a list item's current index. A list's children are its address table.
   */
  get children(): ReadonlyMap<string | number, Address> {
    return this.#children ?? NO_CHILDREN
  }

  link(child: Address): void {
    this.#children ??= new Map()
    this.#children.set(child.coord(), child)
  }

  /** Unlink `child`, if it is the coordinate at its key. */
  unlink(child: Address): void {
    const key = child.coord()
    if (this.#children?.get(key) !== child) return
    this.#children.delete(key)
    if (this.#children.size === 0) this.#children = undefined
  }

  /** Key the children anew, after a list's items moved (`advance`). */
  relink(children: Iterable<Address>): void {
    this.#children = undefined
    for (const child of children) this.link(child)
  }
}

/** What a coordinate without children reads as its children. */
const NO_CHILDREN: ReadonlyMap<string | number, Address> = new Map()

/**
 * An address is the internal, identity-stable, tombstone-aware segment, and
 * its coordinate's node in the trie.
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
 * again (see `CoordinateTrie` and `planAddressFates`). Behaviour lives on the
 * prototype.
 */
export abstract class AddressBase extends Coordinate {}

/** Whether `value` is an address: a segment that is a coordinate. */
export function isAddress(value: unknown): value is Address {
  return value instanceof AddressBase
}

/** A declared product field's address. */
export class FieldAddress extends AddressBase {
  constructor(
    readonly key: string,
    dead: boolean,
  ) {
    super(dead)
  }

  get kind(): "field" {
    return "field"
  }

  get role(): "field" {
    return "field"
  }

  get identity(): string {
    return this.key
  }

  resolve(): string {
    if (this.dead) {
      throw new Error(
        `Ref access on deleted product field. The field "${this.key}" this ref pointed to has been removed.`,
      )
    }
    return this.key
  }

  coord(): string {
    return this.key
  }
}

/** A runtime key's address: a map entry, set member or tree node id. */
export class EntryAddress extends AddressBase {
  constructor(
    readonly key: string,
    dead: boolean,
  ) {
    super(dead)
  }

  get kind(): "entry" {
    return "entry"
  }

  get role(): "entry" {
    return "entry"
  }

  get identity(): string {
    return this.key
  }

  resolve(): string {
    if (this.dead) {
      throw new Error(
        `Ref access on deleted map entry. The entry "${this.key}" this ref pointed to has been removed.`,
      )
    }
    return this.key
  }

  coord(): string {
    return this.key
  }
}

/**
 * A list item's address: a mutable position, advanced as items are inserted
 * and deleted before it, and a stable identity.
 */
export class IndexAddress extends AddressBase {
  readonly id: number

  constructor(
    public index: number,
    dead: boolean,
  ) {
    super(dead)
    this.id = nextAddressId()
  }

  get identity(): number {
    return this.id
  }

  get kind(): "index" {
    return "index"
  }

  get role(): "index" {
    return "index"
  }

  resolve(): number {
    if (this.dead) {
      throw new Error(
        `Ref access on deleted list item. The item this ref pointed to has been removed.`,
      )
    }
    return this.index
  }

  coord(): number {
    return this.index
  }
}

export type Address = FieldAddress | EntryAddress | IndexAddress

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

/**
 * Field address for declared product fields and sums. Dead while the parent's
 * schema, with any sum resolved from the state, does not declare the field.
 */
export function fieldAddress(key: string, dead = false): FieldAddress {
  return new FieldAddress(key, dead)
}

/**
 * Entry address for runtime string keys (map entries, set members, tree
 * node ids). Tombstones on delete; subsequent `.resolve()` throws.
 */
export function entryAddress(key: string, dead = false): EntryAddress {
  return new EntryAddress(key, dead)
}

/** An index-based address, for a list item. */
export function indexAddress(index: number, dead = false): IndexAddress {
  return new IndexAddress(index, dead)
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
   * Addressed paths produce stable keys (a list item's as `@id`); raw paths
   * produce positional keys.
   */
  readonly key: string
  /**
   * Each segment's `identity`, in order: what the coordinate and subscriber
   * tries descend by. `key` joins them with a separator that a segment's own
   * text may contain, so cutting a key can invent a level that does not exist.
   */
  readonly segmentKeys: readonly (string | number)[]
  /** The segments of this path. */
  readonly segments: readonly Segment[]
  /** Number of segments. */
  readonly length: number
  /**
   * The longest prefix that names the same place whatever is inserted: up to
   * the first list index, since an index names another item once one goes in
   * before it, while a field or a key never moves. Undo footprints and
   * population marks are kept at it.
   */
  stablePrefix(): Path
  /** Slice to produce an ancestor path (same concrete type). */
  slice(start: number, end?: number): Path
  /** Concatenate two paths (same concrete type). Throws on type mismatch. */
  concat(other: Path): Path
  /** Resolve this path against a plain store object, returning the value at this path. */
  read(store: unknown): unknown
  /** Human-readable string for error messages (e.g. "todos[2].done"). */
  format(): string
  /** Create an empty path of the same concrete type. */
  root(): Path
  /**
   * Project to an immutable, liveness-agnostic `RawPath` — the value form
   * every `Op` holds, and so the op-log and the wire. Idempotent on `RawPath` (returns
   * `this`); on `AddressedPath` it reads each segment's `coord()` so the
   * result never aliases the live addressing trie. Its inverse is
   * `CoordinateTrie.locate`. Context: jj:mlurlzqt.
   */
  toRaw(): RawPath
}

// ---------------------------------------------------------------------------
// AbstractPath — shared implementation
// ---------------------------------------------------------------------------

/**
 * What `RawPath` and `AddressedPath` share: `read()`, `format()`, `key`
 * and `segmentKeys`.
 */
export abstract class AbstractPath implements Path {
  abstract readonly segments: readonly Segment[]
  abstract readonly length: number
  abstract field(key: string): Path
  abstract entry(key: string): Path
  abstract item(index: number): Path
  abstract slice(start: number, end?: number): Path
  abstract stablePrefix(): Path
  abstract concat(other: Path): Path
  abstract root(): Path
  abstract toRaw(): RawPath

  /** Sugar for `entry(id)`. */
  node(id: string): Path {
    return this.entry(id)
  }

  // Neither is memoized: a ref holds its path for as long as it lives, and
  // a slot per path for a key few callers ask for costs more than the join.
  get segmentKeys(): readonly (string | number)[] {
    return this.segments.map(segment => segment.identity)
  }

  get key(): string {
    return this.segmentKeys
      .map(key => (typeof key === "number" ? `@${key}` : key))
      .join("\0")
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

  get length(): number {
    return this.segments.length
  }

  field(key: string): RawPath {
    return new RawPath(this.segments.concat([rawField(key)]))
  }

  entry(key: string): RawPath {
    return new RawPath(this.segments.concat([rawEntry(key)]))
  }

  override node(id: string): RawPath {
    return this.entry(id)
  }

  item(index: number): RawPath {
    return new RawPath(this.segments.concat([rawIndex(index)]))
  }

  /** A raw segment's identity is its coordinate, always a string. */
  override get segmentKeys(): readonly string[] {
    return this.segments.map(segment => segment.identity)
  }

  stablePrefix(): RawPath {
    const at = firstIndex(this.segments)
    return at === this.length ? this : this.slice(0, at)
  }

  /** Already raw — identity projection. */
  toRaw(): RawPath {
    return this
  }

  slice(start: number, end?: number): RawPath {
    return new RawPath(this.segments.slice(start, end))
  }

  /** This path followed by `other`'s coordinates. */
  concat(other: Path): RawPath {
    return new RawPath(this.segments.concat(other.toRaw().segments))
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
 * A path into a context's `CoordinateTrie`: its addresses as far as the trie
 * has the coordinates, and raw segments below that (`CoordinateTrie.locate`).
 */
export type TrieSegment = Address | RawSegment

/**
 * An addressed path — the internal, identity-stable, tombstone-aware path.
 *
 * Segments are `Address` objects, for every coordinate the trie has, and raw
 * segments below the last one it has: an op's path through a coordinate no
 * ref was made for is located (`CoordinateTrie.locate`) without creating it.
 * `key` produces identity-stable strings (a list item's id, a field's or
 * entry's key). `field()`, `entry()`, and `item()` are **effectful** — they
 * ask the context's `CoordinateTrie` for the child's address, creating it on
 * first use. Only ref construction calls them. The effect is idempotent:
 * calling with the same arguments returns the same `Address` object while
 * the coordinate stays in the trie.
 *
 * A path is its parent path and its last segment, so a child shares its
 * parent's prefix: a ref holds its path for its life, and its parent's ref
 * holds the prefix already. `segments` builds an array on each call; `read`,
 * `dead`, an ancestor (`slice(0, n)`) and the trie's lookups walk the chain.
 */
export class AddressedPath extends AbstractPath {
  // Private, so a path does not carry the whole trie, or its addresses'
  // subtrees, into a `JSON.stringify` or anything else that walks its own
  // properties.
  readonly #trie: CoordinateTrie
  readonly #parent: AddressedPath | undefined
  readonly #last: TrieSegment | undefined
  readonly length: number

  private constructor(
    trie: CoordinateTrie,
    parent: AddressedPath | undefined,
    last: TrieSegment | undefined,
  ) {
    super()
    this.#trie = trie
    this.#parent = parent
    this.#last = last
    this.length = parent === undefined ? 0 : parent.length + 1
  }

  /** The empty path into `trie`. */
  static empty(trie: CoordinateTrie): AddressedPath {
    return new AddressedPath(trie, undefined, undefined)
  }

  /** The path into `trie` through `segments`. */
  static of(
    segments: readonly TrieSegment[],
    trie: CoordinateTrie,
  ): AddressedPath {
    let path = AddressedPath.empty(trie)
    for (const segment of segments) path = path.child(segment)
    return path
  }

  /** The coordinates this path's addresses belong to. */
  get trie(): CoordinateTrie {
    return this.#trie
  }

  /** The path this one extends; `undefined` for the empty path. */
  get parent(): AddressedPath | undefined {
    return this.#parent
  }

  /** The segment this path ends in; `undefined` for the empty path. */
  get last(): TrieSegment | undefined {
    return this.#last
  }

  get segments(): readonly TrieSegment[] {
    const out = new Array<TrieSegment>(this.length)
    for (let at: AddressedPath = this; at.#last !== undefined; ) {
      out[at.length - 1] = at.#last
      if (at.#parent === undefined) break
      at = at.#parent
    }
    return out
  }

  /** Whether a coordinate on this path is gone. */
  get dead(): boolean {
    for (let at: AddressedPath | undefined = this; at; at = at.#parent) {
      if (at.#last?.dead === true) return true
    }
    return false
  }

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

  /** This path extended by `segment`: an address the caller got from the
   *  trie, or a raw segment below the trie's reach. */
  child(segment: TrieSegment): AddressedPath {
    return new AddressedPath(this.#trie, this, segment)
  }

  stablePrefix(): AddressedPath {
    return this.slice(0, firstIndex(this.segments))
  }

  /** As `Array.prototype.slice`. From the start, it is an ancestor, and
   *  shares this path's prefix. */
  slice(start: number, end?: number): AddressedPath {
    const from = clampIndex(start, this.length)
    const to = end === undefined ? this.length : clampIndex(end, this.length)
    if (from === 0) return this.ancestor(Math.max(to, 0))
    return AddressedPath.of(this.segments.slice(from, to), this.#trie)
  }

  /** The ancestor of `length` segments: this path for `length` at least
   *  its own. */
  private ancestor(length: number): AddressedPath {
    let at: AddressedPath = this
    while (at.length > length && at.#parent !== undefined) at = at.#parent
    return at
  }

  /** This path followed by `other`: its segments if it is a path in the same
   *  trie, its coordinates otherwise. */
  concat(other: Path): AddressedPath {
    const tail =
      other instanceof AddressedPath && other.trie === this.trie
        ? other.segments
        : other.toRaw().segments
    let path: AddressedPath = this
    for (const segment of tail) path = path.child(segment)
    return path
  }

  root(): AddressedPath {
    return this.ancestor(0)
  }

  override read(store: unknown): unknown {
    if (this.#parent === undefined || this.#last === undefined) return store
    return childOf(this.#parent.read(store), this.#last)
  }

  /**
   * Freeze to an immutable `RawPath` by projecting each segment to its
   * coordinate via `coord()` (never `resolve()` — this must succeed even
   * for a `dead` address, e.g. an entry deleted after the op was authored).
   * The op-log and wire hold these values, so history never aliases the
   * mutable trie. Context: jj:mlurlzqt.
   */
  toRaw(): RawPath {
    return new RawPath(this.segments.map(rawOf))
  }
}

/** Where the first list index is in `segments`, or their length. */
function firstIndex(segments: readonly Segment[]): number {
  const at = segments.findIndex(segment => segment.role === "index")
  return at === -1 ? segments.length : at
}

/** A relative index into a list of `length`, as `Array.prototype.slice`
 *  reads it. */
function clampIndex(index: number, length: number): number {
  if (index < 0) return Math.max(length + index, 0)
  return Math.min(index, length)
}

/** `segment` as a raw segment of the same coordinate. */
export function rawOf(segment: Segment): RawSegment {
  switch (segment.role) {
    case "field":
      return rawField(String(segment.coord()))
    case "entry":
      return rawEntry(String(segment.coord()))
    case "index":
      return rawIndex(segment.coord() as number)
  }
}
