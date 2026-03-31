// YjsVersion — Version implementation wrapping Yjs state vectors.
//
// Yjs state vectors (`Y.encodeStateVector(doc)`) are the complete peer
// state used for sync diffing — matching the semantics of kyneta's
// Version interface.
//
// Serialization uses base64-encoded bytes for text-safe embedding in
// HTML meta tags, script tags, etc.
//
// Yjs does not export a state vector comparison function, so we
// implement standard version-vector partial-order comparison over
// decoded `Map<number, number>` (clientID → clock) maps ourselves.

import type { Version } from "@kyneta/schema"
import { decodeStateVector } from "yjs"

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
// YjsVersion
// ---------------------------------------------------------------------------

/**
 * A Version wrapping a Yjs state vector.
 *
 * State vectors track the complete peer state — which operations from
 * each client have been observed. This is the right abstraction for sync
 * diffing: `exportSince(version)` uses the state vector to compute the
 * minimal update payload via `Y.encodeStateAsUpdate(doc, sv)`.
 *
 * `serialize()` encodes to base64 for text-safe embedding.
 * `compare()` decodes both state vectors and performs standard
 * version-vector partial-order comparison over the client-clock maps.
 */
export class YjsVersion implements Version {
  readonly sv: Uint8Array

  constructor(sv: Uint8Array) {
    this.sv = sv
  }

  /**
   * Serialize the state vector to a base64 string.
   *
   * The encoding is: raw state vector bytes → base64.
   * This is text-safe for embedding in HTML meta tags, URL parameters, etc.
   */
  serialize(): string {
    return uint8ArrayToBase64(this.sv)
  }

  /**
   * Compare with another version using version-vector partial order.
   *
   * Decodes both state vectors via `Y.decodeStateVector()` to get
   * `Map<number, number>` (clientID → clock), then compares:
   *
   * - Collect the union of all client IDs from both maps.
   * - For each client, compare clocks (missing client = clock 0).
   * - If all clocks in `this` ≤ `other` and at least one strictly less → `"behind"`
   * - If all clocks in `this` ≥ `other` and at least one strictly greater → `"ahead"`
   * - If all clocks equal → `"equal"`
   * - Otherwise → `"concurrent"`
   *
   * Throws if `other` is not a `YjsVersion`.
   */
  compare(other: Version): "behind" | "equal" | "ahead" | "concurrent" {
    if (!(other instanceof YjsVersion)) {
      throw new Error("YjsVersion can only be compared with another YjsVersion")
    }

    const thisMap = decodeStateVector(this.sv)
    const otherMap = decodeStateVector(other.sv)

    // Collect the union of all client IDs
    const allClients = new Set<number>()
    for (const id of thisMap.keys()) allClients.add(id)
    for (const id of otherMap.keys()) allClients.add(id)

    let hasLess = false
    let hasGreater = false

    for (const clientId of allClients) {
      const thisClock = thisMap.get(clientId) ?? 0
      const otherClock = otherMap.get(clientId) ?? 0

      if (thisClock < otherClock) {
        hasLess = true
      }
      if (thisClock > otherClock) {
        hasGreater = true
      }

      // Early exit: if we've seen both less and greater, it's concurrent
      if (hasLess && hasGreater) {
        return "concurrent"
      }
    }

    if (hasLess && !hasGreater) return "behind"
    if (hasGreater && !hasLess) return "ahead"
    return "equal"
  }

  /**
   * Parse a serialized YjsVersion string back into a YjsVersion.
   *
   * The inverse of `serialize()`: base64 → `Uint8Array`.
   */
  static parse(serialized: string): YjsVersion {
    if (serialized === "") {
      throw new Error("Invalid YjsVersion value: (empty string)")
    }
    const bytes = base64ToUint8Array(serialized)
    return new YjsVersion(bytes)
  }
}
