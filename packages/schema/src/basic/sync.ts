// basic/sync — sync primitives for PlainSubstrate-backed documents.
//
// These functions provide version tracking, delta extraction, and
// entirety export for documents created via `createDoc` or
// `createDocFromEntirety`. They discover the substrate via the
// module-scoped WeakMap in `create.ts`.

import type { Op } from "../changefeed.js"
import { RawPath } from "../path.js"
import type { SubstratePayload } from "../substrate.js"
import { PlainVersion } from "../substrates/plain.js"
import { getSubstrate } from "./create.js"

// ---------------------------------------------------------------------------
// version — current version as a plain integer
// ---------------------------------------------------------------------------

/**
 * Current version — monotonic integer, increments on each flush cycle
 * that produces at least one Op.
 *
 * @param doc - A document created by `createDoc` or `createDocFromEntirety`.
 * @throws If `doc` was not created by `createDoc` / `createDocFromEntirety`.
 */
export function version(doc: object): number {
  return getSubstrate(doc).version().value
}

// ---------------------------------------------------------------------------
// delta — ops since a version
// ---------------------------------------------------------------------------

/**
 * All ops applied since `fromVersion`. Returns `[]` if already up to date.
 *
 * This returns raw `Op[]` for wire compatibility — the live sync protocol
 * uses Op-level granularity. For bulk transfers (SSR, reconnection),
 * use `exportEntirety()` instead.
 *
 * @param doc - A document created by `createDoc` or `createDocFromEntirety`.
 * @param fromVersion - The version to diff from (inclusive lower bound).
 * @returns The ops applied between `fromVersion` and the current version.
 * @throws If `doc` was not created by `createDoc` / `createDocFromEntirety`.
 */
export function delta(doc: object, fromVersion: number): Op[] {
  const substrate = getSubstrate(doc)
  const since = new PlainVersion(fromVersion)
  const payload = substrate.exportSince(since)
  if (!payload) return []
  // Wire format is batched: SerializedOp[][] — one inner array per flush cycle.
  // Flatten to a single Op[] for the basic API consumer.
  const batches = JSON.parse(payload.data as string) as Array<
    Array<{
      path: Array<{ type: string; key?: string; index?: number }>
      change: Op["change"]
    }>
  >
  const raw = batches.flat()
  return raw.map(op => ({
    path: op.path.reduce(
      (p: RawPath, seg) =>
        seg.type === "key" ? p.field(seg.key!) : p.item(seg.index!),
      RawPath.empty,
    ),
    change: op.change,
  }))
}

// ---------------------------------------------------------------------------
// exportEntirety — full state for reconstruction
// ---------------------------------------------------------------------------

/**
 * Export the full substrate entirety — sufficient for a new peer to
 * reconstruct an equivalent document via `createDocFromEntirety()`.
 *
 * @param doc - A document created by `createDoc` or `createDocFromEntirety`.
 * @returns An opaque `SubstratePayload` (JSON-encoded for PlainSubstrate).
 * @throws If `doc` was not created by `createDoc` / `createDocFromEntirety`.
 */
export function exportEntirety(doc: object): SubstratePayload {
  return getSubstrate(doc).exportEntirety()
}
