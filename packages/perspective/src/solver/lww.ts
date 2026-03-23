// === Native LWW Solver ===
// Resolves value conflicts using Last-Writer-Wins semantics:
// highest lamport wins; peer ID breaks ties (lexicographically greater wins).
//
// This is the native (host-language) optimization described in §B.7.
// It MUST produce identical results to the LWW Datalog rules from §B.4:
//
//   superseded(CnId, Slot) :-
//     active_value(CnId, Slot, _, L1, _),
//     active_value(CnId2, Slot, _, L2, _),
//     CnId ≠ CnId2, L2 > L1.
//
//   superseded(CnId, Slot) :-
//     active_value(CnId, Slot, _, L1, P1),
//     active_value(CnId2, Slot, _, L2, P2),
//     CnId ≠ CnId2, L2 == L1, P2 > P1.
//
//   winner(Slot, CnId, Value) :-
//     active_value(CnId, Slot, Value, _, _),
//     not superseded(CnId, Slot).
//
// See unified-engine.md §7.2, §8, §B.7.

import { cnIdKey } from "../kernel/cnid.js"
import type { StructureIndex } from "../kernel/structure-index.js"
import type {
  CnId,
  Lamport,
  PeerID,
  Value,
  ValueConstraint,
} from "../kernel/types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A value entry participating in LWW resolution.
 */
export interface LWWEntry {
  /** The value constraint's CnId. */
  readonly id: CnId
  /** The slot identity string (from the structure index). */
  readonly slotId: string
  /** The asserted content. */
  readonly content: Value
  /** Lamport timestamp for ordering. */
  readonly lamport: Lamport
  /** Peer ID for tiebreaking. */
  readonly peer: PeerID
}

/**
 * The winner for a given slot after LWW resolution.
 */
export interface LWWWinner {
  /** The slot identity string. */
  readonly slotId: string
  /** The winning value constraint's CnId. */
  readonly winnerId: CnId
  /** The resolved content value. */
  readonly content: Value
  /** Lamport of the winner. */
  readonly lamport: Lamport
  /** Peer of the winner. */
  readonly peer: PeerID
}

/**
 * The result of LWW resolution across all slots.
 */
export interface LWWResult {
  /** Winning value per slot. */
  readonly winners: ReadonlyMap<string, LWWWinner>
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve value conflicts across all slots using LWW.
 *
 * Groups active value constraints by their slot identity (derived from
 * the structure index), then picks the winner for each slot by
 * (lamport DESC, peer DESC).
 *
 * @param activeValueConstraints - Value constraints that are active.
 * @param structureIndex - The precomputed structure index for slot lookup.
 * @returns LWWResult with one winner per slot.
 */
export function resolveLWW(
  activeValueConstraints: Iterable<ValueConstraint>,
  structureIndex: StructureIndex,
): LWWResult {
  // Group entries by slot.
  const bySlot = new Map<string, LWWEntry>()

  for (const vc of activeValueConstraints) {
    const targetKey = cnIdKey(vc.payload.target)
    const sid = structureIndex.structureToSlot.get(targetKey)
    if (sid === undefined) {
      // Orphaned value — target structure not found. Skip.
      continue
    }

    const entry: LWWEntry = {
      id: vc.id,
      slotId: sid,
      content: vc.payload.content,
      lamport: vc.lamport,
      peer: vc.id.peer,
    }

    const existing = bySlot.get(sid)
    if (existing === undefined || lwwCompare(entry, existing) > 0) {
      bySlot.set(sid, entry)
    }
  }

  // Convert entries to winners.
  const winners = new Map<string, LWWWinner>()
  for (const [sid, entry] of bySlot) {
    winners.set(sid, {
      slotId: sid,
      winnerId: entry.id,
      content: entry.content,
      lamport: entry.lamport,
      peer: entry.peer,
    })
  }

  return { winners }
}

/**
 * Resolve value conflicts for a single slot.
 *
 * This is a convenience function for resolving a single slot without
 * building a full structure index. Useful for skeleton construction.
 *
 * @param entries - All value entries competing for this slot.
 * @returns The winning entry, or undefined if no entries.
 */
export function resolveLWWSlot(
  entries: readonly LWWEntry[],
): LWWEntry | undefined {
  if (entries.length === 0) return undefined

  let winner = entries[0]!
  for (let i = 1; i < entries.length; i++) {
    const candidate = entries[i]!
    if (lwwCompare(candidate, winner) > 0) {
      winner = candidate
    }
  }
  return winner
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compare two LWW entries for conflict resolution.
 *
 * Returns positive if `a` wins over `b`, negative if `b` wins, 0 if tied.
 *
 * Ordering: higher lamport wins. On lamport tie, lexicographically
 * greater peer ID wins. This matches the Datalog rules exactly:
 *   superseded if L2 > L1, or (L2 == L1 and P2 > P1).
 */
export function lwwCompare(a: LWWEntry, b: LWWEntry): number {
  if (a.lamport !== b.lamport) {
    return a.lamport - b.lamport
  }
  // Lamport tie — peer ID breaks it (greater peer wins).
  if (a.peer !== b.peer) {
    return a.peer > b.peer ? 1 : -1
  }
  // Same lamport AND same peer — compare by counter for determinism.
  return a.id.counter - b.id.counter
}
