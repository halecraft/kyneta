// sync — sync primitives for YjsSubstrate-backed documents.
//
// These functions provide version tracking, entirety export, and merge
// for documents created via `createYjsDoc` or
// `createYjsDocFromEntirety`. They discover the substrate via the
// module-scoped WeakMap in `create.ts`.
//
// Unlike PlainSubstrate's sync (which returns Op[] for deltas),
// YjsSubstrate's sync uses binary SubstratePayload for both entireties
// and deltas — these are Yjs's native state-as-update bytes.

import type { SubstratePayload } from "@kyneta/schema"
import { getSubstrate } from "./create.js"
import type { YjsVersion } from "./version.js"

// ---------------------------------------------------------------------------
// version — current YjsVersion
// ---------------------------------------------------------------------------

/**
 * Current version as a `YjsVersion` (wrapping a Yjs state vector).
 *
 * Use `.serialize()` to get a text-safe string for embedding in HTML
 * meta tags, URL parameters, etc.
 *
 * @param doc - A document created by `createYjsDoc` or `createYjsDocFromEntirety`.
 * @throws If `doc` was not created by `createYjsDoc` / `createYjsDocFromEntirety`.
 */
export function version(doc: object): YjsVersion {
  return getSubstrate(doc).version()
}

// ---------------------------------------------------------------------------
// exportEntirety — full state for reconstruction
// ---------------------------------------------------------------------------

/**
 * Export the full substrate entirety — sufficient for a new peer to
 * reconstruct an equivalent document via `createYjsDocFromEntirety()`.
 *
 * Returns a binary `SubstratePayload` (Yjs state-as-update bytes).
 *
 * @param doc - A document created by `createYjsDoc` or `createYjsDocFromEntirety`.
 * @throws If `doc` was not created by `createYjsDoc` / `createYjsDocFromEntirety`.
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
 * Returns a binary `SubstratePayload` (Yjs update bytes), or `null`
 * if the delta cannot be computed.
 *
 * ```ts
 * const v0 = version(docA)
 * change(docA, d => d.title.insert(0, "Hi"))
 * const delta = exportSince(docA, v0)
 * merge(docB, delta!)
 * ```
 *
 * @param doc - A document created by `createYjsDoc` or `createYjsDocFromEntirety`.
 * @param since - The version to diff from.
 * @throws If `doc` was not created by `createYjsDoc` / `createYjsDocFromEntirety`.
 */
export function exportSince(
  doc: object,
  since: YjsVersion,
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
 * @param doc - A document created by `createYjsDoc` or `createYjsDocFromEntirety`.
 * @param payload - The delta or entirety payload to merge.
 * @param origin - Optional provenance tag for the changeset.
 * @throws If `doc` was not created by `createYjsDoc` / `createYjsDocFromEntirety`.
 */
export function merge(
  doc: object,
  payload: SubstratePayload,
  origin?: string,
): void {
  getSubstrate(doc).merge(payload, origin)
}
