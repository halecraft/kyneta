// path — typed path infrastructure for the interpreter stack.
//
// Two implementations of a single Path interface:
//
// - RawPath: external, serializable, positional. Segments are immutable
//   value objects ({ type: "key", key } | { type: "index", index }).
//   Used by wire formats, external ops, and non-addressing stacks.
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
//
// See .jj-plan/01-cursor-stable-refs.md §Phase 1 (path: cursor-stable-refs).

// ---------------------------------------------------------------------------
// Segment — the minimal contract for a path segment
// ---------------------------------------------------------------------------

/**
 * The minimal contract for a path segment. Both `RawSegment` and
 * `Address` implement this interface.
 *
 * Most consumers need only `resolve()` — the resolved `string | number`
 * is sufficient for container navigation, store reads, and writes.
 * `role` exists for `advanceSchema`, which is the single enforcement
 * point that validates segment-schema compatibility (key segment into
 * product/map, index segment into sequence). Backends trust the schema
 * invariant and dispatch on container kind instead.
 */
export interface Segment {
  /**
   * "key" for fields/map entries, "index" for sequence items.
   *
   * Only needed by `advanceSchema` (the schema-enforcement layer).
   * All other consumers — backends, store readers, changefeed routing —
   * use `resolve()` alone and dispatch on container kind, not segment role.
   */
  readonly role: "key" | "index"

  /**
   * Resolve this segment to a store-access key (string or number).
   *
   * For dead addresses, throws a descriptive error. This is the only
   * method most consumers need — tombstone checking is built in.
   */
  resolve(): string | number
}

// ---------------------------------------------------------------------------
// RawSegment — positional, serializable segment
// ---------------------------------------------------------------------------

/**
 * A raw path segment — the existing segment shape, now implementing
 * `Segment`. Created by `rawKey()` and `rawIndex()` factory functions.
 *
 * The `type`/`key`/`index` fields are retained for wire-format
 * compatibility (serialization boundaries construct `RawSegment` from
 * external data). `role` and `resolve()` are the `Segment` interface
 * contract; `type`/`key`/`index` are `RawSegment`-specific.
 */
export type RawSegment =
  | {
      readonly type: "key"
      readonly key: string
      readonly role: "key"
      resolve(): string
    }
  | {
      readonly type: "index"
      readonly index: number
      readonly role: "index"
      resolve(): number
    }

/**
 * Create a key-based raw segment (for product fields, map entries).
 */
export function rawKey(key: string): RawSegment {
  return { type: "key", key, role: "key", resolve: () => key }
}

/**
 * Create an index-based raw segment (for sequence items).
 */
export function rawIndex(index: number): RawSegment {
  return { type: "index", index, role: "index", resolve: () => index }
}

// ---------------------------------------------------------------------------
// Address — identity-stable, tombstone-aware segment
// ---------------------------------------------------------------------------

/**
 * An address is the internal, identity-stable, tombstone-aware segment.
 *
 * - `kind: "key"` serves products, maps, and sums. The key is the
 *   stable identity. `dead` is set true when a map entry is deleted.
 *   For product fields, `dead` is always false (schema-defined).
 *
 * - `kind: "index"` serves sequences. The address carries a mutable
 *   index that is advanced eagerly on structural change, and a stable
 *   `id` that never changes. `dead` is set true when the item is deleted.
 *
 * `resolve()` throws if `dead` is true — tombstone checking is built
 * into the segment, not the path or the caller.
 */
export type Address =
  | {
      readonly kind: "key"
      readonly key: string
      dead: boolean
      readonly role: "key"
      resolve(): string
    }
  | {
      readonly kind: "index"
      readonly id: number
      index: number
      dead: boolean
      readonly role: "index"
      resolve(): number
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
 * Create a key-based address (for products, maps, sums).
 */
export function keyAddress(key: string, dead = false): Address {
  return {
    kind: "key",
    key,
    dead,
    role: "key",
    resolve() {
      if (this.dead) {
        throw new Error(
          `Ref access on deleted map entry. The entry "${this.key}" this ref pointed to has been removed.`,
        )
      }
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
 * Consumers use `Path` uniformly — `field()`, `item()`, `key`,
 * `read()`, `format()`, `slice()`, `concat()`. They never branch
 * on path kind.
 */
export interface Path {
  /** Append a field (key-based) segment, returning a new Path of the same concrete type. */
  field(key: string): Path
  /** Append an item (index-based) segment, returning a new Path of the same concrete type. */
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
  abstract item(index: number): Path
  abstract slice(start: number, end?: number): Path
  abstract concat(other: Path): Path
  abstract root(): Path

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
      current = (current as Record<string | number, unknown>)[seg.resolve()]
    }
    return current
  }

  format(): string {
    if (this.segments.length === 0) return "root"
    let result = ""
    for (const seg of this.segments) {
      if (seg.role === "key") {
        if (result.length > 0) result += "."
        result += String(seg.resolve())
      } else {
        result += `[${seg.resolve()}]`
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
    return new RawPath([...this.segments, rawKey(key)])
  }

  item(index: number): RawPath {
    return new RawPath([...this.segments, rawIndex(index)])
  }

  protected computeKey(): string {
    return this.segments.map(s => String(s.resolve())).join("\0")
  }

  slice(start: number, end?: number): RawPath {
    return new RawPath(this.segments.slice(start, end))
  }

  concat(other: Path): RawPath {
    if (other.isAddressed) {
      throw new Error("Cannot concat AddressedPath onto RawPath")
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
   * Key addresses keyed by `parentPathKey + "\0" + childKey`.
   * Ensures idempotency: same parent + key → same Address object.
   */
  private readonly keyAddresses = new Map<string, Address>()

  /**
   * Sequence address tables keyed by parent path key.
   */
  private readonly sequenceTables = new Map<string, SequenceAddressTable>()

  /**
   * Map address tables keyed by parent path key.
   */
  private readonly mapTables = new Map<string, MapAddressTable>()

  /**
   * Get or create a key-based address for a field/map entry at the
   * given parent path key.
   *
   * Idempotent: calling with the same arguments returns the same
   * Address object.
   */
  getOrCreateKeyAddress(parentKey: string, childKey: string): Address {
    const lookupKey = parentKey + "\0" + childKey
    let addr = this.keyAddresses.get(lookupKey)
    if (!addr) {
      addr = keyAddress(childKey)
      this.keyAddresses.set(lookupKey, addr)
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
   * Get a key address by parent path key and child key.
   * Returns undefined if no address exists.
   */
  getKeyAddress(parentKey: string, childKey: string): Address | undefined {
    return this.keyAddresses.get(parentKey + "\0" + childKey)
  }
}

// ---------------------------------------------------------------------------
// AddressedPath — internal, identity-stable, tombstone-aware
// ---------------------------------------------------------------------------

/**
 * An addressed path — the internal, identity-stable, tombstone-aware path.
 *
 * Segments are `Address` objects. `key` produces identity-stable strings
 * (address.id for sequences, key string for fields/maps). `field()` and
 * `item()` are **effectful** — they call `registry.getOrCreate*()` which
 * mutates the address table. The effect is idempotent: calling with the
 * same arguments returns the same `Address` object.
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
    const address = this.registry.getOrCreateKeyAddress(this.key, key)
    return new AddressedPath([...this.segments, address], this.registry)
  }

  item(index: number): AddressedPath {
    const address = this.registry.getOrCreateSequenceAddress(this.key, index)
    return new AddressedPath([...this.segments, address], this.registry)
  }

  protected computeKey(): string {
    return this.segments
      .map(seg => (seg.kind === "index" ? "@" + seg.id : seg.key))
      .join("\0")
  }

  slice(start: number, end?: number): AddressedPath {
    return new AddressedPath(this.segments.slice(start, end), this.registry)
  }

  concat(other: Path): AddressedPath {
    if (!other.isAddressed) {
      throw new Error("Cannot concat RawPath onto AddressedPath")
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
    if (seg.role === "key") {
      current = current.field(seg.resolve() as string) as AddressedPath
    } else {
      current = current.item(seg.resolve() as number) as AddressedPath
    }
  }
  return current
}
