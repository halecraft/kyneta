// YjsVersion — Version wrapping a Yjs state vector + a bounded digest of
// the delete set.
//
// The Yjs state vector only tracks inserted items — it does NOT advance
// when items are deleted (tombstoned). A version based on the state vector
// alone cannot detect delete-only changes, causing the sync protocol to
// skip pushing deletes to peers.
//
// YjsVersion pairs the state vector with a fixed-size FNV-1a-128 digest of
// the full Yjs Snapshot (state vector + delete set) so that compare()
// faithfully distinguishes "same state" from "divergent deletes" as a
// tie-breaker equality check — never reconstructed from, only compared for
// equality. The state vector component is kept separately (and in full) for
// exportSince(), which uses it to compute the minimal update payload.
//
// Why a digest and not the raw snapshot bytes: Yjs's delete set only merges
// *adjacent* same-client deleted ranges (see Yjs's own `sortAndMergeDeleteSet`).
// Workloads with non-contiguous deletes — e.g. insert-then-correct cycles,
// as in STT partial corrections — accumulate new, never-merging delete
// ranges forever, so the raw encoded snapshot grows unboundedly with edit
// history rather than with peer count. A version vector's serialized size
// must scale with peer count alone (matching PlainVersion and LoroVersion);
// hashing the snapshot to a constant-size digest restores that invariant
// while preserving compare()'s exact equality semantics (a digest collision
// would incorrectly report "equal" for genuinely divergent deletes, but at
// 128 bits this is negligible — the same fixed-size-fingerprint tradeoff
// already accepted by @kyneta/schema's computeSchemaHash).
//
// Serialization format: base64(sv) + "." + deleteSetDigest (32-char hex).
// Legacy format (no "."): base64(sv) only — decoded as SV-only version
// for backward compatibility (the digest is then computed from the SV
// bytes themselves, distinct from any real snapshot's digest, still
// correctly yielding "concurrent" against a new-format peer's version).

import type { Version } from "@kyneta/schema"
import {
  base64ToUint8Array,
  DEFAULT_LINEAGE,
  uint8ArrayToBase64,
  versionVectorCompare,
  versionVectorMeet,
} from "@kyneta/schema"
import fnv1a from "@sindresorhus/fnv1a"
import {
  createSnapshot,
  type Doc,
  decodeStateVector,
  encodeSnapshot,
  encodeStateVector as yjsEncodeStateVector,
  snapshot as yjsSnapshot,
} from "yjs"

// ---------------------------------------------------------------------------
// State vector encoding — manual varint (unsigned LEB128)
// ---------------------------------------------------------------------------

/**
 * Encode a state vector map to Yjs's binary state vector format.
 *
 * Yjs does not export `encodeStateVector(map)` — only `Y.encodeStateVector(doc)`
 * which requires a full doc. This implements the same binary format directly:
 * `[entryCount: varint, (clientId: varint, clock: varint)*]`
 *
 * Each value is encoded as an unsigned LEB128 varint.
 */
function encodeStateVector(map: Map<number, number>): Uint8Array {
  const bytes: number[] = []

  function writeVarUint(value: number): void {
    while (value > 0x7f) {
      bytes.push((value & 0x7f) | 0x80)
      value >>>= 7
    }
    bytes.push(value & 0x7f)
  }

  writeVarUint(map.size)
  for (const [clientId, clock] of map) {
    writeVarUint(clientId)
    writeVarUint(clock)
  }

  return new Uint8Array(bytes)
}

// ---------------------------------------------------------------------------
// Delete-set digest — fixed-size FNV-1a-128 fingerprint of snapshot bytes
// ---------------------------------------------------------------------------

/**
 * 32-char hex digest of FNV-1a-128 over raw bytes. Used only for equality
 * comparison (a tie-breaker when state vectors already match) — never
 * reconstructed from. Bounds YjsVersion's serialized size to a constant,
 * regardless of how many (possibly non-contiguous) deleted ranges the
 * underlying delete set contains.
 */
function digestBytes(bytes: Uint8Array): string {
  return fnv1a(bytes, { size: 128 }).toString(16).padStart(32, "0")
}

// ---------------------------------------------------------------------------
// YjsVersion
// ---------------------------------------------------------------------------

/**
 * A Version wrapping a Yjs state vector plus a bounded digest of the
 * delete set.
 *
 * The state vector tracks which insertions from each client have been
 * observed. The delete set tracks which of those items have been
 * tombstoned. Together they fully describe a Yjs document's state — but
 * only the state vector is kept in full; the delete set is reduced to a
 * fixed-size digest (see `digestBytes`).
 *
 * - `sv` is used by `exportSince()` to compute the minimal update payload
 *   via `Y.encodeStateAsUpdate(doc, sv)`.
 * - `deleteSetDigest` is a 32-char hex FNV-1a-128 digest of the encoded
 *   Yjs `Snapshot` (SV + delete set), used for equality comparison: two
 *   documents are "equal" only when both their inserts and deletes match.
 *
 * `compare()` first performs standard version-vector partial-order
 * comparison on the state vectors. If the SVs are equal, it falls
 * through to a digest comparison — if the digests differ (same inserts,
 * different deletes), the result is "concurrent", ensuring the sync
 * protocol pushes the divergent deletes.
 */
export class YjsVersion implements Version {
  /** Encoded state vector — used by exportSince(). */
  readonly sv: Uint8Array

  /**
   * Fixed-size (32-char hex) FNV-1a-128 digest of the encoded Yjs snapshot
   * (state vector + delete set) — used for equality comparison. Two
   * documents are "equal" only if both their inserts (state vector) and
   * deletes (delete-set digest) match. Not reassigned after construction;
   * not `readonly` only so `#fromDigest` can set it directly without a
   * redundant re-hash when reconstructing from an already-serialized digest.
   */
  #deleteSetDigest: string

  get deleteSetDigest(): string {
    return this.#deleteSetDigest
  }

  constructor(sv: Uint8Array, snapshotBytes?: Uint8Array) {
    this.sv = sv
    // If no snapshot provided, digest the SV bytes themselves (backward
    // compat / SV-only) — distinct from any real snapshot's digest, still
    // correctly yielding "concurrent" against a new-format peer's version.
    this.#deleteSetDigest = digestBytes(snapshotBytes ?? sv)
  }

  /**
   * Construct directly from an already-computed digest — used by `parse()`,
   * which reads the digest as a plain hex string off the wire and must not
   * re-hash it (there are no raw snapshot bytes to hash on the receiving
   * end).
   */
  static #fromDigest(sv: Uint8Array, deleteSetDigest: string): YjsVersion {
    const v = new YjsVersion(sv)
    v.#deleteSetDigest = deleteSetDigest
    return v
  }

  /**
   * Yjs is a collaborative (CRDT) substrate — lineages are never minted
   * automatically. `lineage` is always `DEFAULT_LINEAGE` for the document's
   * lifetime; new lineages require an explicit developer-invoked migration
   * primitive (T3 migrations, not implemented here).
   */
  get lineage(): string {
    return DEFAULT_LINEAGE
  }

  /**
   * Construct a version from a live `Y.Doc` by snapshotting its full state.
   *
   * Walks the struct store to derive the delete set — O(n) in the number
   * of items. Use {@link fromDeleteSet} for the incremental path.
   */
  static fromDoc(doc: Doc): YjsVersion {
    const sv = yjsEncodeStateVector(doc)
    const snap = encodeSnapshot(yjsSnapshot(doc))
    return new YjsVersion(sv, snap)
  }

  /**
   * Construct a version from a `Y.Doc`'s state vector and an externally
   * maintained delete set — the incremental path that avoids a struct
   * store walk.
   *
   * @param doc  The live Y.Doc (for the state vector).
   * @param ds   An accumulated delete set, kept in sync by merging
   *             `transaction.deleteSet` on each transaction.
   */
  static fromDeleteSet(
    doc: Doc,
    ds: ReturnType<typeof import("yjs").createDeleteSet>,
  ): YjsVersion {
    const sv = yjsEncodeStateVector(doc)
    const svMap = decodeStateVector(sv)
    const snap = encodeSnapshot(createSnapshot(ds, svMap))
    return new YjsVersion(sv, snap)
  }

  /**
   * Serialize to a text-safe string.
   *
   * Format: `base64(sv) + "." + deleteSetDigest`. The digest is already a
   * compact hex string, so only `sv` needs base64 wrapping. The "."
   * separator is unambiguous since base64 never contains ".".
   */
  serialize(): string {
    const svB64 = uint8ArrayToBase64(this.sv)
    return svB64 + "." + this.deleteSetDigest
  }

  /**
   * Compare with another version using version-vector partial order,
   * extended with delete-set equality checking.
   *
   * 1. Decode both state vectors and compare via `versionVectorCompare`.
   * 2. If the SV comparison yields anything other than "equal", return it.
   * 3. If the SVs are equal, compare delete-set digests for equality.
   *    If they differ (same inserts, different deletes), return "concurrent"
   *    — both sides may have tombstones the other lacks.
   * 4. "equal" is returned only when BOTH the state vector AND the
   *    delete-set digest match.
   *
   * @throws If `other` is not a `YjsVersion`.
   */
  compare(other: Version): "behind" | "equal" | "ahead" | "concurrent" {
    if (!(other instanceof YjsVersion)) {
      throw new Error("YjsVersion can only be compared with another YjsVersion")
    }
    const svResult = versionVectorCompare(
      decodeStateVector(this.sv),
      decodeStateVector(other.sv),
    )
    if (svResult !== "equal") return svResult
    // State vectors are equal — check if delete sets match via digest.
    return this.deleteSetDigest === other.deleteSetDigest
      ? "equal"
      : "concurrent"
  }

  /**
   * Greatest lower bound (lattice meet) of two Yjs versions.
   *
   * Decodes both state vectors, computes the component-wise minimum
   * via `versionVectorMeet`, and encodes the result back to a Yjs
   * state vector.
   *
   * The meet snapshot uses the meet SV with no delete-set information
   * (conservative lower bound). meet() feeds into advance(), which Yjs
   * does not support incrementally, so this is safe.
   *
   * @throws If `other` is not a `YjsVersion`.
   */
  meet(other: Version): YjsVersion {
    if (!(other instanceof YjsVersion)) {
      throw new Error("YjsVersion can only be meet'd with another YjsVersion")
    }
    const thisMap = decodeStateVector(this.sv)
    const otherMap = decodeStateVector(other.sv)
    const result = versionVectorMeet(thisMap, otherMap)
    const meetSv = encodeStateVector(result)
    // Conservative: meet snapshot uses only the meet SV (no delete set).
    return new YjsVersion(meetSv)
  }

  /**
   * Parse a serialized YjsVersion string back into a YjsVersion.
   *
   * New format: `base64(sv) + "." + deleteSetDigest` (32-char hex, read
   * as-is — no re-hashing, since the digest is already the wire value).
   * Legacy format (no "."): `base64(sv)` only — constructed with the
   * digest of the SV bytes themselves. When compared against a
   * new-format version with matching SVs, the differing digest yields
   * "concurrent", triggering a safe redundant sync push.
   */
  static parse(serialized: string): YjsVersion {
    if (serialized === "") {
      throw new Error("Invalid YjsVersion value: (empty string)")
    }
    const dotIndex = serialized.indexOf(".")
    if (dotIndex === -1) {
      // Legacy format: SV-only (no delete set).
      const bytes = base64ToUint8Array(serialized)
      return new YjsVersion(bytes)
    }
    const sv = base64ToUint8Array(serialized.slice(0, dotIndex))
    const deleteSetDigest = serialized.slice(dotIndex + 1)
    return YjsVersion.#fromDigest(sv, deleteSetDigest)
  }
}
