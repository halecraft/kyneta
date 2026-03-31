// sync — sync primitives for LoroSubstrate-backed documents.
//
// These functions provide version tracking, entirety export, and merge
// for documents created via `createLoroDoc` or
// `createLoroDocFromEntirety`. They discover the substrate via the
// module-scoped WeakMap in `create.ts`.
//
// Unlike PlainSubstrate's sync (which returns Op[] for deltas),
// LoroSubstrate's sync uses binary SubstratePayload for both entireties
// and deltas — these are Loro's native oplog/snapshot bytes.

import type { SubstratePayload } from "@kyneta/schema"
import { getSubstrate } from "./create.js"
import type { LoroVersion } from "./version.js"

// ---------------------------------------------------------------------------
// version — current LoroVersion
// ---------------------------------------------------------------------------

/**
 * Current version as a `LoroVersion` (wrapping a `VersionVector`).
 *
 * Use `.serialize()` to get a text-safe string for embedding in HTML
 * meta tags, URL parameters, etc.
 *
 * @param doc - A document created by `createLoroDoc` or `createLoroDocFromEntirety`.
 * @throws If `doc` was not created by `createLoroDoc` / `createLoroDocFromEntirety`.
 */
export function version(doc: object): LoroVersion {
  return getSubstrate(doc).version()
}

// ---------------------------------------------------------------------------
// exportEntirety — full state for reconstruction
// ---------------------------------------------------------------------------

/**
 * Export the full substrate entirety — sufficient for a new peer to
 * reconstruct an equivalent document via `createLoroDocFromEntirety()`.
 *
 * Returns a binary `SubstratePayload` (Loro snapshot bytes).
 *
 * @param doc - A document created by `createLoroDoc` or `createLoroDocFromEntirety`.
 * @throws If `doc` was not created by `createLoroDoc` / `createLoroDocFromEntirety`.
 */
export function exportEntirety(doc: object): SubstratePayload {
  return getSubstrate(doc).exportEntirety()
}

// ---------------------------------------------------------------------------
// exportSince — delta since a version
// ---------------------------------------------------------------------------

/**
 * Export a delta payload containing all changes since the given version.
 *
 * Returns a binary `SubstratePayload` (Loro update bytes), or `null`
 * if the delta cannot be computed.
 *
 * ```ts
 * const v0 = version(docA)
 * change(docA, d => d.title.insert(0, "Hi"))
 * const delta = exportSince(docA, v0)
 * merge(docB, delta!)
 * ```
 *
 * @param doc - A document created by `createLoroDoc` or `createLoroDocFromEntirety`.
 * @param since - The version to diff from.
 * @throws If `doc` was not created by `createLoroDoc` / `createLoroDocFromEntirety`.
 */
export function exportSince(
  doc: object,
  since: LoroVersion,
): SubstratePayload | null {
  return getSubstrate(doc).exportSince(since)
}

// ---------------------------------------------------------------------------
// merge — apply a delta from another peer
// ---------------------------------------------------------------------------

/**
 * Import a delta payload into a live document.
 *
 * The payload must have been produced by `exportSince()` or
 * `exportEntirety()` on a compatible document.
 *
 * After import, the changefeed fires for all subscribers — the event
 * bridge handles this automatically.
 *
 * ```ts
 * const delta = exportSince(docA, sinceVersion)
 * merge(docB, delta!, "sync")
 * ```
 *
 * @param doc - A document created by `createLoroDoc` or `createLoroDocFromEntirety`.
 * @param payload - The delta or snapshot payload to import.
 * @param origin - Optional provenance tag for the changeset.
 * @throws If `doc` was not created by `createLoroDoc` / `createLoroDocFromEntirety`.
 */
export function merge(
  doc: object,
  payload: SubstratePayload,
  origin?: string,
): void {
  getSubstrate(doc).merge(payload, origin)
}
