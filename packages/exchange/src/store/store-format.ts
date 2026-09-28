// store-format — the store-level format-compatibility gate.
//
// A `Store`'s on-disk encoding is frozen the moment data exists on disk.
// Before a reader trusts the bytes in a store, it consults a small
// store-global header fact — the format version — to decide whether it
// understands them at all. This is a magic-number / file-header read, not
// a document: it is read on open, before the per-doc `Store` contract is
// trusted, and it never transits `append`/`currentMeta` (which presuppose
// the format is already valid and are typed around `StoreMeta`).
//
// This module is the shared *contract* — the version type, the typed error,
// the pure decision, and the parser. The version *value* and the physical
// store-metadata namespace (a table / object store / key-prefix) are owned
// per backend; the key names below are shared so tooling can locate them
// uniformly.
//
// The format decision is one half of opening a store; the other is taking a
// seat, from the same namespace at the same moment. `planStoreOpen`
// (`./store-open.ts`) makes both, and every backend opens through it.
//
// The gate is a compatibility gate, NOT a migration engine: it stamps,
// accepts, or refuses. It deliberately performs no migration. Context and
// rationale: jj:uvssotsy.

/**
 * The key, within a backend's store-metadata namespace, under which the
 * on-disk format version is recorded.
 */
export const STORE_META_FORMAT_KEY = "format"

/**
 * The key, within a backend's store-metadata namespace, under which the seat
 * pool is recorded (see `./seats.ts`).
 */
export const STORE_META_SEATS_KEY = "seats"

/**
 * A store's on-disk format revision.
 *
 * `major` gates compatibility — equality is required, a mismatch is refused.
 * `minor` advances for backward-compatible refinements and never gates.
 * Mirrors the wire protocol revision model (jj:yukrpnwm).
 */
export interface StoreFormatVersion {
  readonly major: number
  readonly minor: number
}

/** Why a store was refused on open. */
export type StoreFormatRefusal =
  // The stamped major differs from the running major — neither newer nor
  // older data can be read without a migration this gate does not perform.
  | "incompatible-major"
  // No format marker, but the store already holds documents — a foreign,
  // corrupt, or pre-marker store, not a brand-new one.
  | "unversioned-existing-data"
  // A marker is present but is not a well-formed {major, minor}.
  | "malformed-version"

/** The outcome of the pure gate decision; the shell executes it. */
export type StoreFormatDecision =
  | { readonly action: "ok" }
  | { readonly action: "stamp"; readonly value: StoreFormatVersion }
  | { readonly action: "refuse"; readonly reason: StoreFormatRefusal }

/**
 * Pure policy core (a bootstrap-time decision, no I/O).
 *
 * The imperative shell supplies the running version, the parsed stored
 * marker (or `null` if the store-metadata namespace has no format entry),
 * and whether the per-doc data is non-empty, then executes the returned
 * action: `ok` (proceed), `stamp` (write the version into a brand-new
 * store), or `refuse` (throw `StoreFormatVersionError`).
 */
export function decideStoreFormat(input: {
  readonly current: StoreFormatVersion
  readonly stored: StoreFormatVersion | null
  readonly storeHasData: boolean
}): StoreFormatDecision {
  const { current, stored, storeHasData } = input

  if (stored === null) {
    // No marker. A brand-new (empty) store gets stamped; a store that
    // already holds documents but carries no marker is foreign / pre-marker
    // and must not be silently adopted.
    return storeHasData
      ? { action: "refuse", reason: "unversioned-existing-data" }
      : { action: "stamp", value: current }
  }

  if (stored.major !== current.major) {
    return { action: "refuse", reason: "incompatible-major" }
  }

  // Same major: minor differences are backward-compatible by definition and
  // accepted silently. (A diagnostic hook can be added later additively,
  // without a format change.)
  return { action: "ok" }
}

/**
 * Parse a raw marker value into a `StoreFormatVersion`, or signal
 * `"malformed"`.
 *
 * Backends differ in how the marker arrives: a JSON string for sqlite and
 * leveldb, an already-parsed object for postgres (jsonb) and IndexedDB
 * (structured clone). `unknown` accepts both; a string is `JSON.parse`d
 * first.
 */
export function parseStoreFormat(
  raw: unknown,
): StoreFormatVersion | "malformed" {
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      return "malformed"
    }
  }

  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isInteger((value as { major?: unknown }).major) ||
    !Number.isInteger((value as { minor?: unknown }).minor)
  ) {
    return "malformed"
  }

  const { major, minor } = value as { major: number; minor: number }
  return { major, minor }
}

/**
 * Thrown on open when a store's format is incompatible with the running
 * code, or when an unversioned store already holds data. No migration is
 * attempted — the store is left untouched.
 */
export class StoreFormatVersionError extends Error {
  readonly reason: StoreFormatRefusal
  readonly backend: string
  readonly stored: StoreFormatVersion | null
  readonly current: StoreFormatVersion

  constructor(input: {
    reason: StoreFormatRefusal
    backend: string
    stored: StoreFormatVersion | null
    current: StoreFormatVersion
  }) {
    const { reason, backend, stored, current } = input
    const storedStr =
      stored === null ? "none" : `${stored.major}.${stored.minor}`
    super(
      `${backend} store: incompatible format (${reason}) — ` +
        `on disk ${storedStr}, this build ${current.major}.${current.minor}. ` +
        `No migration is performed.`,
    )
    this.name = "StoreFormatVersionError"
    this.reason = reason
    this.backend = backend
    this.stored = stored
    this.current = current
  }
}
