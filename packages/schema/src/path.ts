/**
 * Recognize the `stepTree` shadow shape (`{id, parent, index, data}[]`)
 * structurally, so `path.node(id)` can step into a node's data without
 * a schema lookup. The role-`"entry"` guard at the call site keeps this
 * heuristic from misfiring on user data that happens to have `id`/`data`
 * keys but isn't a `Schema.tree` shadow.
 */
function isFlatForestArray(arr: readonly unknown[]): boolean {
  if (arr.length === 0) return false
  const first = arr[0]
  return (
    typeof first === "object" &&
    first !== null &&
    typeof (first as { id?: unknown }).id === "string" &&
    "data" in (first as object)
  )
}

// path — typed path infrastructure for the interpreter stack.
//
// Two implementations of a single Path interface:
//
// - RawPath: external, serializable, positional. Segments are immutable
//   value objects (`{ type: "field" | "entry" | "index", ... }`). Used by
//   wire formats, external ops, and non-addressing stacks.
//
// - AddressedPath: internal, identity-stable, tombstone-aware. Segments
//   are Address objects with mutable indices (sequences) or tombstone
//   flags (maps). Used by the interpreter stack when withAddressing is
//   composed in.
//
// Consumers use the Path interface uniformly — field(), item(), key,
// read(), format(), slice(), concat(). They never branch on path kind.
// The concrete type is determined by the root path (set on context by
// withAddressing or defaulting to RawPath.empty), inherited by all
// descendants via field()/item().

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
   * fail loudly — writing through a path (`writeByPath`) or live ref
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
      resolve(): string
      coord(): string
    }
  | {
      readonly type: "entry"
      readonly entry: string
      readonly role: "entry"
      resolve(): string
      coord(): string
    }
  | {
      readonly type: "index"
      readonly index: number
      readonly role: "index"
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
 *  - `"field"` — declared product fields and sums. Schema-defined; never dies.
 *  - `"entry"` — map entries, set members, tree node ids. Dies per-key.
 *  - `"index"` — sequences. Mutable `index` (advanced on structural change),
 *    stable `id`. Dies per-item.
 */
export type Address =
  | {
      readonly kind: "field"
      readonly key: string
      dead: boolean
      listeners?: Set<() => void>
      readonly role: "field"
      resolve(): string
      coord(): string
    }
  | {
      readonly kind: "entry"
      readonly key: string
      dead: boolean
      listeners?: Set<() => void>
      readonly role: "entry"
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
 * Field address for declared product fields and sums. The `dead` flag
 * is shape parity with `entryAddress` / `indexAddress` — product fields
 * are schema-defined and never tombstoned in normal operation.
 */
export function fieldAddress(key: string, dead = false): Address {
  return {
    kind: "field",
    key,
    dead,
    role: "field",
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
   * used by the op-log and the wire. Idempotent on `RawPath` (returns
   * `this`); on `AddressedPath` it reads each segment's `coord()` so the
   * result never aliases the live addressing registry. The named inverse
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
   * Memoized — computed once on first access. Safe because segments
   * are readonly and key computation uses only stable identities
   * (address.id, not address.index).
   */
  private _key: string | undefined
  get key(): string {
    if (this._key === undefined) {
      this._key = this.computeKey()
    }
    return this._key
  }
  protected abstract computeKey(): string

  read(store: unknown): unknown {
    let current = store
    for (const seg of this.segments) {
      if (current == null) return undefined
      // `coord()`, not `resolve()`: a since-deleted key reads as the absent
      // value (undefined via the `current[key]` miss), not a throw — a deleted
      // key is absent, not a bug. Writes still guard (see `writeByPath`). jj:mlurlzqt
      const key = seg.coord()
      // Flat-forest navigation: when traversing an `entry` segment
      // over an array of `{id, parent, index, data}` nodes (the canonical
      // shadow shape produced by `stepTree`), look the node up by id and
      // step into its `.data`. This makes `path.node(id)` reads work over
      // the flat shadow without requiring schema-aware readers.
      if (
        seg.role === "entry" &&
        Array.isArray(current) &&
        isFlatForestArray(current)
      ) {
        const node = (
          current as ReadonlyArray<{ id: string; data: unknown }>
        ).find(n => n != null && n.id === key)
        current = node === undefined ? undefined : node.data
        continue
      }
      current = (current as Record<string | number, unknown>)[key]
    }
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

  protected computeKey(): string {
    // `coord()`: identity is a coordinate projection, not a live read.
    return this.segments.map(s => String(s.coord())).join("\0")
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
      // using the other's registry, then concat as AddressedPaths.
      const addressed = other as AddressedPath
      const selfAsAddressed = resolveToAddressed(this, addressed.registry)
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
// AddressTableRegistry — per-composite-node address management
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Address table types — per-composite-node data structures
// ---------------------------------------------------------------------------

/**
 * Address table for sequence nodes. Tracks index addresses and their
 * associated refs, enabling identity-preserving `.at(i)` lookups and
 * bulk address advancement on structural changes.
 */
export interface SequenceAddressTable {
  /** Stable ID → { address, ref } for all live and dead addresses. */
  byId: Map<number, { address: Address; ref: unknown }>
  /** Current index → address for index-based lookup (.at(i)). Rebuilt after advancement. */
  byIndex: Map<number, Address>
}

/**
 * Address table for map nodes. Tracks key addresses and their
 * associated refs, enabling identity-preserving `.at(key)` lookups
 * and tombstone detection on key deletion.
 */
export interface MapAddressTable {
  /** Key string → { address, ref } for all live and dead addresses. */
  byKey: Map<string, { address: Address; ref: unknown }>
}

/**
 * Manages per-node address tables. Internal to the addressing system.
 *
 * `AddressedPath` holds a reference to this registry (received via the
 * root path) and calls `getOrCreateKeyAddress` / `getOrCreateSequenceAddress`
 * from its `field()` / `item()` methods.
 *
 * The registry is NOT exposed on the context — it's threaded through
 * path derivation.
 */
export class AddressTableRegistry {
  /**
   * Field addresses (declared product fields) keyed by
   * `parentPathKey + "\0" + childKey`. Idempotent.
   */
  private readonly fieldAddresses = new Map<string, Address>()

  /**
   * Entry addresses (map / set / tree node ids — runtime keys) keyed
   * by `parentPathKey + "\0" + childKey`. Idempotent; tombstone-aware.
   */
  private readonly entryAddresses = new Map<string, Address>()

  /**
   * Sequence address tables keyed by parent path key.
   */
  private readonly sequenceTables = new Map<string, SequenceAddressTable>()

  /**
   * Map address tables keyed by parent path key.
   */
  private readonly mapTables = new Map<string, MapAddressTable>()

  /**
   * Get or create a field address for a declared product field at the
   * given parent path key. Field addresses never tombstone (schema-defined
   * existence).
   *
   * Idempotent: same arguments → same Address object.
   */
  getOrCreateFieldAddress(parentKey: string, childKey: string): Address {
    const lookupKey = `${parentKey}\0${childKey}`
    let addr = this.fieldAddresses.get(lookupKey)
    if (!addr) {
      addr = fieldAddress(childKey)
      this.fieldAddresses.set(lookupKey, addr)
    }
    return addr
  }

  /**
   * Get or create an entry address for a map entry, set member, or
   * tree node id at the given parent path key.
   *
   * Idempotent: same arguments → same Address object.
   */
  getOrCreateEntryAddress(parentKey: string, childKey: string): Address {
    const lookupKey = `${parentKey}\0${childKey}`
    let addr = this.entryAddresses.get(lookupKey)
    if (!addr) {
      addr = entryAddress(childKey)
      this.entryAddresses.set(lookupKey, addr)
    }
    return addr
  }

  /**
   * Get or create an index-based address for a sequence item at the
   * given parent path key and index.
   *
   * Idempotent per index: calling with the same parent + index returns
   * the same Address object (via the byIndex reverse map).
   */
  getOrCreateSequenceAddress(parentKey: string, index: number): Address {
    let table = this.sequenceTables.get(parentKey)
    if (!table) {
      table = { byId: new Map(), byIndex: new Map() }
      this.sequenceTables.set(parentKey, table)
    }

    // Check if we already have an address at this index
    let addr = table.byIndex.get(index)
    if (addr) return addr

    // Create a new index address
    addr = indexAddress(index)
    table.byId.set((addr as { id: number }).id, {
      address: addr,
      ref: undefined,
    })
    table.byIndex.set(index, addr)
    return addr
  }

  /**
   * Register a ref for a sequence item address. Called by `onRefCreated`
   * after `interpretImpl` creates the child ref.
   */
  registerSequenceRef(parentKey: string, address: Address, ref: unknown): void {
    const table = this.sequenceTables.get(parentKey)
    if (!table) return
    const id = (address as { id: number }).id
    const entry = table.byId.get(id)
    if (entry) entry.ref = ref
  }

  /**
   * Get or create a map address table for the given parent path key,
   * and ensure the key address is tracked in it.
   */
  ensureMapEntry(parentKey: string, childKey: string, address: Address): void {
    let table = this.mapTables.get(parentKey)
    if (!table) {
      table = { byKey: new Map() }
      this.mapTables.set(parentKey, table)
    }
    if (!table.byKey.has(childKey)) {
      table.byKey.set(childKey, { address, ref: undefined })
    }
  }

  /**
   * Register a ref for a map entry address. Called by `onRefCreated`
   * after `interpretImpl` creates the child ref.
   */
  registerMapRef(parentKey: string, childKey: string, ref: unknown): void {
    const table = this.mapTables.get(parentKey)
    if (!table) return
    const entry = table.byKey.get(childKey)
    if (entry) entry.ref = ref
  }

  /**
   * Get the sequence address table for a given parent path key.
   * Returns undefined if no table exists (no items accessed yet).
   */
  getSequenceTable(parentKey: string): SequenceAddressTable | undefined {
    return this.sequenceTables.get(parentKey)
  }

  /**
   * Get the map address table for a given parent path key.
   * Returns undefined if no table exists (no entries accessed yet).
   */
  getMapTable(parentKey: string): MapAddressTable | undefined {
    return this.mapTables.get(parentKey)
  }

  /**
   * Get a field address by parent path key and child key.
   * Returns undefined if no address exists.
   */
  getFieldAddress(parentKey: string, childKey: string): Address | undefined {
    return this.fieldAddresses.get(`${parentKey}\0${childKey}`)
  }

  /**
   * Get an entry address by parent path key and child key.
   * Returns undefined if no address exists.
   */
  getEntryAddress(parentKey: string, childKey: string): Address | undefined {
    return this.entryAddresses.get(`${parentKey}\0${childKey}`)
  }
}

// ---------------------------------------------------------------------------
// AddressedPath — internal, identity-stable, tombstone-aware
// ---------------------------------------------------------------------------

/**
 * An addressed path — the internal, identity-stable, tombstone-aware path.
 *
 * Segments are `Address` objects. `key` produces identity-stable strings
 * (address.id for sequences, key string for fields/entries). `field()`,
 * `entry()`, and `item()` are **effectful** — they call
 * `registry.getOrCreate*()` which mutates the address table. The effect
 * is idempotent: calling with the same arguments returns the same
 * `Address` object.
 */
export class AddressedPath extends AbstractPath {
  constructor(
    readonly segments: readonly Address[],
    readonly registry: AddressTableRegistry,
  ) {
    super()
  }

  readonly isAddressed = true as const

  field(key: string): AddressedPath {
    const address = this.registry.getOrCreateFieldAddress(this.key, key)
    return new AddressedPath([...this.segments, address], this.registry)
  }

  entry(key: string): AddressedPath {
    const address = this.registry.getOrCreateEntryAddress(this.key, key)
    return new AddressedPath([...this.segments, address], this.registry)
  }

  override node(id: string): AddressedPath {
    return this.entry(id)
  }

  item(index: number): AddressedPath {
    const address = this.registry.getOrCreateSequenceAddress(this.key, index)
    return new AddressedPath([...this.segments, address], this.registry)
  }

  protected computeKey(): string {
    return this.segments
      .map(seg => (seg.kind === "index" ? `@${seg.id}` : seg.key))
      .join("\0")
  }

  slice(start: number, end?: number): AddressedPath {
    return new AddressedPath(this.segments.slice(start, end), this.registry)
  }

  concat(other: Path): AddressedPath {
    if (!other.isAddressed) {
      // The other path is raw — resolve it to addressed using our registry,
      // then concat as AddressedPaths.
      const otherAddressed = resolveToAddressed(other as RawPath, this.registry)
      return new AddressedPath(
        [...this.segments, ...otherAddressed.segments],
        this.registry,
      )
    }
    return new AddressedPath(
      [...this.segments, ...(other as AddressedPath).segments],
      this.registry,
    )
  }

  root(): AddressedPath {
    return new AddressedPath([], this.registry)
  }

  /**
   * Freeze to an immutable `RawPath` by projecting each `Address` to its
   * coordinate via `coord()` (never `resolve()` — this must succeed even
   * for a `dead` address, e.g. an entry deleted after the op was authored).
   * The named inverse of `resolveToAddressed`. The op-log and wire hold
   * these values, so history never aliases the mutable registry.
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
 * Resolve a path to an `AddressedPath` using the given registry.
 *
 * - If the path is already addressed, return it as-is (idempotent).
 * - If raw, walk the segments and look up (or create) addresses in the
 *   registry at each level. Returns an `AddressedPath` whose `.key`
 *   matches the keys used by changefeed listeners and cache handlers.
 *
 * This is the single point where raw→addressed translation happens.
 * Called in the prepare pipeline so that `path.key` on incoming
 * external mutations matches the identity-stable keys used internally.
 * The inverse — addressed→raw, for freezing history — is `AddressedPath.toRaw()`.
 */
export function resolveToAddressed(
  path: Path,
  registry: AddressTableRegistry,
): AddressedPath {
  if (path.isAddressed) return path as AddressedPath

  // Walk the raw segments, building an AddressedPath by calling
  // the registry's getOrCreate* methods at each level.
  let current = new AddressedPath([], registry)
  for (const seg of path.segments) {
    // `coord()` for consistency; input is always raw here (addressed returns
    // early), so this is a pure coordinate read either way.
    if (seg.role === "field") {
      current = current.field(seg.coord() as string) as AddressedPath
    } else if (seg.role === "entry") {
      current = current.entry(seg.coord() as string) as AddressedPath
    } else {
      current = current.item(seg.coord() as number) as AddressedPath
    }
  }
  return current
}
