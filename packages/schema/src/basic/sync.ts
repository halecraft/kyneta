// basic/sync — sync primitives for PlainSubstrate-backed documents.
//
// These functions provide version tracking, delta extraction, and
// snapshot export for documents created via `createDoc` or
// `createDocFromSnapshot`. They discover the substrate via the
// module-scoped WeakMap in `create.ts`.

import type { Op } from "../changefeed.js"
import type { SubstratePayload } from "../substrate.js"
import { PlainFrontier } from "../substrates/plain.js"
import { getSubstrate } from "./create.js"

// ---------------------------------------------------------------------------
// version — current frontier as a plain integer
// ---------------------------------------------------------------------------

/**
 * Current frontier — monotonic integer, increments on each flush cycle
 * that produces at least one Op.
 *
 * @param doc - A document created by `createDoc` or `createDocFromSnapshot`.
 * @throws If `doc` was not created by `createDoc` / `createDocFromSnapshot`.
 */
export function version(doc: object): number {
  return getSubstrate(doc).frontier().value
}

// ---------------------------------------------------------------------------
// delta — ops since a version
// ---------------------------------------------------------------------------

/**
 * All ops applied since `fromVersion`. Returns `[]` if already up to date.
 *
 * This returns raw `Op[]` for wire compatibility — the live sync protocol
 * uses Op-level granularity. For bulk transfers (SSR, reconnection),
 * use `exportSnapshot()` instead.
 *
 * @param doc - A document created by `createDoc` or `createDocFromSnapshot`.
 * @param fromVersion - The version to diff from (inclusive lower bound).
 * @returns The ops applied between `fromVersion` and the current frontier.
 * @throws If `doc` was not created by `createDoc` / `createDocFromSnapshot`.
 */
export function delta(doc: object, fromVersion: number): Op[] {
  const substrate = getSubstrate(doc)
  const since = new PlainFrontier(fromVersion)
  const payload = substrate.exportSince(since)
  if (!payload) return []
  const ops = JSON.parse(payload.data as string) as Op[]
  return ops
}

// ---------------------------------------------------------------------------
// exportSnapshot — full state for reconstruction
// ---------------------------------------------------------------------------

/**
 * Export the full substrate snapshot — sufficient for a new peer to
 * reconstruct an equivalent document via `createDocFromSnapshot()`.
 *
 * @param doc - A document created by `createDoc` or `createDocFromSnapshot`.
 * @returns An opaque `SubstratePayload` (JSON-encoded for PlainSubstrate).
 * @throws If `doc` was not created by `createDoc` / `createDocFromSnapshot`.
 */
export function exportSnapshot(doc: object): SubstratePayload {
  return getSubstrate(doc).exportSnapshot()
}
