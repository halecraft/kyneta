// LoroVersion — Version implementation wrapping Loro's VersionVector.
//
// VersionVector is the complete peer state used for sync diffing —
// matching the semantics of kyneta's Version interface. Not to be
// confused with Loro's Frontiers (DAG leaf ops for checkpoints).
//
// Serialization uses base64-encoded bytes from VersionVector.encode()
// for text-safe embedding in HTML meta tags, script tags, etc.

import type { Version } from "@kyneta/schema"
import { VersionVector } from "loro-crdt"

// ---------------------------------------------------------------------------
// Base64 helpers (platform-agnostic, no Node.js Buffer dependency)
// ---------------------------------------------------------------------------

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

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