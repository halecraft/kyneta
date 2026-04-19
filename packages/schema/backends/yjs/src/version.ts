// YjsVersion — Version wrapping a Yjs snapshot (state vector + delete set).
//
// The Yjs state vector only tracks inserted items — it does NOT advance
// when items are deleted (tombstoned). A version based on the state vector
// alone cannot detect delete-only changes, causing the sync protocol to
// skip pushing deletes to peers.
//
// YjsVersion wraps the full Yjs Snapshot (state vector + delete set) so
// that compare() faithfully distinguishes "same state" from "divergent
// deletes." The state vector component is kept separately for exportSince(),
// which uses it to compute the minimal update payload.
//
// Serialization format: base64(sv) + "." + base64(snapshotBytes).
// Legacy format (no "."): base64(sv) only — decoded as SV-only version
// for backward compatibility. When a legacy version is compared against
// a new-format version with matching SVs, the differing snapshot bytes
// yield "concurrent", triggering a (redundant but safe) sync push.

import type { Version } from "@kyneta/schema"
import {
  base64ToUint8Array,
  uint8ArrayToBase64,
  versionVectorCompare,
  versionVectorMeet,
} from "@kyneta/schema"
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
// Byte-level equality
// ---------------------------------------------------------------------------

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// YjsVersion
// ---------------------------------------------------------------------------

/**
 * A Version wrapping a Yjs snapshot (state vector + delete set).
 *
 * The state vector tracks which insertions from each client have been
 * observed. The delete set tracks which of those items have been
 * tombstoned. Together they fully describe a Yjs document's state.
 *
 * - `sv` is used by `exportSince()` to compute the minimal update payload
 *   via `Y.encodeStateAsUpdate(doc, sv)`.
 * - `snapshotBytes` is the encoded Yjs `Snapshot` (SV + delete set),
 *   used for equality comparison: two documents are "equal" only when
 *   both their inserts and deletes match.
 *
 * `compare()` first performs standard version-vector partial-order
 * comparison on the state vectors. If the SVs are equal, it falls
 * through to a byte-level comparison of the snapshot bytes — if they
 * differ (same inserts, different deletes), the result is "concurrent",
 * ensuring the sync protocol pushes the divergent deletes.
 */
export class YjsVersion implements Version {
  /** Encoded state vector — used by exportSince(). */
  readonly sv: Uint8Array

  /**
   * Encoded Yjs snapshot (state vector + delete set) — used for equality
   * comparison. Two documents are "equal" only if both their inserts
   * (state vector) and deletes (delete set) match.
   */
  readonly snapshotBytes: Uint8Array

  constructor(sv: Uint8Array, snapshotBytes?: Uint8Array) {
    this.sv = sv
    // If no snapshot provided, use sv as snapshot (backward compat / SV-only).
    this.snapshotBytes = snapshotBytes ?? sv
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
   * Format: `base64(sv) + "." + base64(snapshotBytes)`.
   * The "." separator is unambiguous since base64 never contains ".".
   */
  serialize(): string {
    const svB64 = uint8ArrayToBase64(this.sv)
    const snapB64 = uint8ArrayToBase64(this.snapshotBytes)
    return svB64 + "." + snapB64
  }

  /**
   * Compare with another version using version-vector partial order,
   * extended with delete-set equality checking.
   *
   * 1. Decode both state vectors and compare via `versionVectorCompare`.
   * 2. If the SV comparison yields anything other than "equal", return it.
   * 3. If the SVs are equal, compare snapshot bytes for byte equality.
   *    If they differ (same inserts, different deletes), return "concurrent"
   *    — both sides may have tombstones the other lacks.
   * 4. "equal" is returned only when BOTH the state vector AND the
   *    delete set match.
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
    // State vectors are equal — check if delete sets match via snapshot bytes.
    return arraysEqual(this.snapshotBytes, other.snapshotBytes)
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
   * New format: `base64(sv) + "." + base64(snapshotBytes)`.
   * Legacy format (no "."): `base64(sv)` only — constructed with
   * `snapshotBytes` equal to the SV bytes. When compared against a
   * new-format version with matching SVs, the differing snapshot bytes
   * yield "concurrent", triggering a safe redundant sync push.
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
    const snapshotBytes = base64ToUint8Array(serialized.slice(dotIndex + 1))
    return new YjsVersion(sv, snapshotBytes)
  }
}
