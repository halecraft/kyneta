// select — pure projections over the live world-model views.
//
// Selector discipline: read group MEMBERSHIP from a `SecondaryIndex`'s
// `.current` (a `Map<groupKey, Set<entryKey>>`) and resolve VALUES from the
// base store. Never call `SecondaryIndex.get(key)` from a selector — it
// allocates a fresh ReactiveMap + a subscription retained until index dispose
// on every call (a leak under repeated rendering). `.get()` is for a renderer
// that genuinely holds one group's live subscription. Context: jj:qwzkmzvy.
//
// Ordering note: per-peer order is exact (the bus `seq` is monotonic per
// peer); there is no cross-peer clock, so a merged timeline is ordered
// (peerId, seq) — a stable per-peer interleave, never a claimed global total
// order. Context: jj:pusmrzuy.

import type { ObsEvent } from "@kyneta/exchange"
import type { DocView, SyncEntry, WorldModel } from "./model.js"

/**
 * The per-peer sync entries for a doc. Membership comes from the `syncByDoc`
 * grouping (incrementally maintained); current values from `syncStates`.
 */
export function syncFor(
  model: WorldModel,
  docId: string,
): readonly SyncEntry[] {
  const entryKeys = model.syncByDoc.current.get(docId)
  if (entryKeys === undefined) return []
  const out: SyncEntry[] = []
  for (const key of entryKeys) {
    const entry = model.syncStates.get(key)
    if (entry !== undefined) out.push(entry)
  }
  return out
}

/** Order events per-peer (exact, by `seq`); peers ordered by id (stable). */
function byPeerSeq(a: ObsEvent, b: ObsEvent): number {
  if (a.peerId !== b.peerId) return a.peerId < b.peerId ? -1 : 1
  return a.seq - b.seq
}

/** A composed per-document view assembled from the live collections. */
export interface DocViewComposite {
  readonly docId: string
  readonly doc: DocView | undefined
  readonly sync: readonly SyncEntry[]
  readonly activity: readonly ObsEvent[]
}

/** Compose a doc's directory entry + per-peer sync status + cross-peer activity. */
export function docView(model: WorldModel, docId: string): DocViewComposite {
  return {
    docId,
    doc: model.documents.get(docId),
    sync: syncFor(model, docId),
    activity: docActivity(model, docId),
  }
}

/** All doc-scoped events for a doc, per-peer-ordered. */
export function docActivity(
  model: WorldModel,
  docId: string,
): readonly ObsEvent[] {
  const entryKeys = model.byDoc.current.get(docId)
  if (entryKeys === undefined) return []
  const out: ObsEvent[] = []
  for (const key of entryKeys) {
    const event = model.events.get(key)
    if (event !== undefined) out.push(event)
  }
  return out.sort(byPeerSeq)
}

/** The full event log, per-peer-ordered. */
export function timeline(model: WorldModel): readonly ObsEvent[] {
  return [...model.events.current.values()].sort(byPeerSeq)
}

/**
 * The convergence rollup — egocentric to the observed peer.
 *
 * - `pending`: `syncStates` entries with `state === "pending"`.
 * - `pendingDocs`: docs with ≥1 pending peer (a fact).
 * - `stuckDocs`: pending docs that also carry an `error` diagnostic for that doc.
 * - `errors` / `diagnostics`: diagnostics with `severity === "error"` / total.
 * - `state`: `pending === 0 ? "converged" : errors > 0 ? "stuck" : "syncing"`.
 */
export interface ConvergenceState {
  readonly state: "converged" | "syncing" | "stuck"
  readonly pending: number
  readonly pendingDocs: readonly string[]
  readonly stuckDocs: readonly string[]
  readonly errors: number
  readonly diagnostics: number
}

/**
 * Convergence — a pure, clock-free, fact-first projection. `pending` counts
 * ONLY `state === "pending"` (`synced`/`vacant` are terminal/non-blocking;
 * `vacant` is the settled "peer isn't syncing this"). `stuck` gates on `error`
 * severity (the convergence-preventing mismatches — schema-hash / replica-type
 * / sync-mode — are `error`, jj:nztkqwpm; protocol minor-skew is a `warning`
 * and does NOT gate). Per-doc attribution: `stuckDocs` = pending docs that also
 * carry an `error` diagnostic keyed to that `docId`. A peer/protocol error
 * (`self-connection`/`protocol-mismatch`, no `docId`) still
 * produces a *global* `stuck` with an empty `stuckDocs` — honest: the failure
 * is peer-scoped, not doc-scoped.
 *
 * Reads `syncStates`/`diagnostics` `.current` directly — both `severity` and
 * `docId` live on `DiagnosticEntry`, so there is no join back to `events` for
 * the structured `code` (that is only the log formatter's concern). Quiescence
 * ("wedged") is the clock-INJECTED `stalledDocs`, kept out of this projection.
 */
export function convergence(model: WorldModel): ConvergenceState {
  const pendingDocs = new Set<string>()
  let pending = 0
  for (const entry of model.syncStates.current.values()) {
    if (entry.state === "pending") {
      pending++
      pendingDocs.add(entry.docId)
    }
  }

  const errorDocs = new Set<string>()
  let errors = 0
  let diagnostics = 0
  for (const diag of model.diagnostics.current.values()) {
    diagnostics++
    if (diag.severity === "error") {
      errors++
      if (diag.docId !== undefined) errorDocs.add(diag.docId)
    }
  }

  const stuckDocs = [...pendingDocs]
    .filter(docId => errorDocs.has(docId))
    .sort()
  const state = pending === 0 ? "converged" : errors > 0 ? "stuck" : "syncing"

  return {
    state,
    pending,
    pendingDocs: [...pendingDocs].sort(),
    stuckDocs,
    errors,
    diagnostics,
  }
}

/**
 * Staleness — the clock-INJECTED counterpart to the clock-free `convergence`.
 * Returns the pending docs whose latest observed event `t` is older than
 * `now - quietMs`. The shell supplies `now`, so this is testable with a fixed
 * clock and `convergence` itself keeps no clock (clean FC/IS).
 *
 * `ObsEvent.t` is the EMITTER's wall-clock — pass `Date.now()` for a live
 * in-process tap, and the latest observed `t` (or disable the hint) for a
 * recorded/remote stream where wall-clock isn't comparable. A pending doc with
 * no surviving activity (events evicted by the FIFO cap) is skipped — staleness
 * can't be proven without a `t`.
 */
export function stalledDocs(
  model: WorldModel,
  opts: { now: number; quietMs: number },
): readonly string[] {
  const threshold = opts.now - opts.quietMs

  const pendingDocs = new Set<string>()
  for (const entry of model.syncStates.current.values()) {
    if (entry.state === "pending") pendingDocs.add(entry.docId)
  }

  const out: string[] = []
  for (const docId of pendingDocs) {
    const activity = docActivity(model, docId)
    if (activity.length === 0) continue
    // Latest `t` via a loop, not `Math.max(...spread)` — a high-volume stream
    // can make the activity array large enough to overflow the call stack.
    let latest = Number.NEGATIVE_INFINITY
    for (const e of activity) if (e.t > latest) latest = e.t
    if (latest < threshold) out.push(docId)
  }
  return out.sort()
}
