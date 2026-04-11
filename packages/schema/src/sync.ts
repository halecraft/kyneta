// sync — generic sync functions for any substrate.
//
// These functions provide version tracking, entirety export, delta export,
// and merge for documents created via `createDoc()` or `exchange.get()`.
// They discover the substrate via the `[SUBSTRATE]` symbol property on
// the root ref — no WeakMaps needed.

import { SUBSTRATE } from "./native.js"
import type { Substrate, SubstratePayload, Version } from "./substrate.js"

// ---------------------------------------------------------------------------
// getSubstrate — internal helper
// ---------------------------------------------------------------------------

/**
 * Recover the Substrate from a root ref via [SUBSTRATE].
 *
 * @throws If the ref does not have a [SUBSTRATE] property (e.g. child refs,
 *   or refs not created by createDoc/exchange.get).
 */
function getSubstrate(ref: object): Substrate<any> {
  const substrate = (ref as any)[SUBSTRATE]
  if (!substrate) {
    throw new Error(
      "Sync functions (version, exportEntirety, exportSince, merge) require " +
        "a root ref created by createDoc() or exchange.get().",
    )
  }
  return substrate
}

// ---------------------------------------------------------------------------
// version — current version
// ---------------------------------------------------------------------------

/**
 * Current version of the document.
 *
 * The returned `Version` type is substrate-specific:
 * - Plain: `PlainVersion` (monotonic integer)
 * - Loro: `LoroVersion` (wrapping a VersionVector)
 * - Yjs: `YjsVersion` (wrapping a state vector)
 *
 * @param ref - A root ref created by `createDoc()` or `exchange.get()`
 * @throws If the ref has no `[SUBSTRATE]`
 */
export function version(ref: object): Version {
  return getSubstrate(ref).version()
}

// ---------------------------------------------------------------------------
// exportEntirety — full state for reconstruction
// ---------------------------------------------------------------------------

/**
 * Export the full substrate state — sufficient for a new peer to
 * reconstruct an equivalent document via `createDoc(bound, payload)`.
 *
 * @param ref - A root ref created by `createDoc()` or `exchange.get()`
 * @throws If the ref has no `[SUBSTRATE]`
 */
export function exportEntirety(ref: object): SubstratePayload {
  return getSubstrate(ref).exportEntirety()
}

// ---------------------------------------------------------------------------
// exportSince — delta since a version
// ---------------------------------------------------------------------------

/**
 * Export a delta payload containing changes since the given version.
 *
 * Returns `null` if the delta cannot be computed (e.g. the version
 * is too old and has been compacted).
 *
 * @param ref - A root ref created by `createDoc()` or `exchange.get()`
 * @param since - The version to diff from
 * @throws If the ref has no `[SUBSTRATE]`
 */
export function exportSince(
  ref: object,
  since: Version,
): SubstratePayload | null {
  return getSubstrate(ref).exportSince(since)
}

// ---------------------------------------------------------------------------
// merge — apply a delta from another peer
// ---------------------------------------------------------------------------

/**
 * Import a delta or snapshot payload into a live document.
 *
 * After import, the changefeed fires for all subscribers — the event
 * bridge handles this automatically.
 *
 * @param ref - A root ref created by `createDoc()` or `exchange.get()`
 * @param payload - The delta or snapshot payload to import
 * @param origin - Optional provenance tag for the changeset
 * @throws If the ref has no `[SUBSTRATE]`
 */
export function merge(
  ref: object,
  payload: SubstratePayload,
  origin?: string,
): void {
  getSubstrate(ref).merge(payload, origin)
}
