// LoroVersion — Version implementation wrapping Loro's VersionVector.
//
// VersionVector is the complete peer state used for sync diffing —
// matching the semantics of kyneta's Version interface. Not to be
// confused with Loro's Frontiers (DAG leaf ops for checkpoints).
//
// Serialization uses base64-encoded bytes from VersionVector.encode()
// for text-safe embedding in HTML meta tags, script tags, etc.

import type { Version } from "@kyneta/schema"
import {
  base64ToUint8Array,
  uint8ArrayToBase64,
  versionVectorMeet,
} from "@kyneta/schema"
import { VersionVector } from "loro-crdt"

// ---------------------------------------------------------------------------
// LoroVersion
// ---------------------------------------------------------------------------

/**
 * A Version wrapping Loro's VersionVector.
 *
 * VersionVector tracks the complete peer state — which operations from
 * each peer have been observed. This is the right abstraction for sync
 * diffing: `exportSince(version)` uses the VV to compute the minimal
 * update payload.
 *
 * `serialize()` encodes to base64 for text-safe embedding.
 * `compare()` delegates to `VersionVector.compare()` and maps the
 * result to kyneta's partial order vocabulary.
 */
export class LoroVersion implements Version {
  readonly vv: VersionVector

  constructor(vv: VersionVector) {
    this.vv = vv
  }

  /**
   * Serialize the version vector to a base64 string.
   *
   * The encoding is: `VersionVector.encode()` → `Uint8Array` → base64.
   * This is text-safe for embedding in HTML meta tags, URL parameters, etc.
   */
  serialize(): string {
    return uint8ArrayToBase64(this.vv.encode())
  }

  /**
   * Compare with another version.
   *
   * Delegates to `VersionVector.compare()` which returns:
   * - `-1` → this is strictly behind other → `"behind"`
   * - `0`  → same version → `"equal"`
   * - `1`  → this is strictly ahead of other → `"ahead"`
   * - `undefined` → concurrent (neither ahead nor behind) → `"concurrent"`
   *
   * Throws if `other` is not a `LoroVersion`.
   */
  compare(other: Version): "behind" | "equal" | "ahead" | "concurrent" {
    if (!(other instanceof LoroVersion)) {
      throw new Error(
        "LoroVersion can only be compared with another LoroVersion",
      )
    }
    const result = this.vv.compare(other.vv)
    if (result === undefined) return "concurrent"
    if (result < 0) return "behind"
    if (result > 0) return "ahead"
    return "equal"
  }

  /**
   * Greatest lower bound (lattice meet) of two Loro versions.
   *
   * Computes the component-wise minimum of the two version vectors.
   * The result is ≤ both `this` and `other`.
   *
   * @throws If `other` is not a `LoroVersion`.
   */
  meet(other: Version): LoroVersion {
    if (!(other instanceof LoroVersion)) {
      throw new Error("LoroVersion can only be meet'd with another LoroVersion")
    }
    const result = versionVectorMeet(this.vv.toJSON(), other.vv.toJSON())
    return new LoroVersion(new VersionVector(result))
  }

  /**
   * Parse a serialized LoroVersion string back into a LoroVersion.
   *
   * The inverse of `serialize()`: base64 → `Uint8Array` → `VersionVector.decode()`.
   */
  static parse(serialized: string): LoroVersion {
    if (serialized === "") {
      throw new Error("Invalid LoroVersion value: (empty string)")
    }
    const bytes = base64ToUint8Array(serialized)
    return new LoroVersion(VersionVector.decode(bytes))
  }
}
