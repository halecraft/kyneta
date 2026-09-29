// === §B.7 LWW solver — TEST ORACLE ONLY ===
//
// This is a hand-written implementation of last-writer-wins value resolution, the same semantics the
// default rules in `bootstrap.ts` express as Datalog. It used to run in place
// of those rules whenever the store's rule set matched the known defaults —
// the "native fast path" spec §B.7 permits.
//
// It no longer ships. The performance argument for the fast path was measured
// and did not hold (the quadratic was a query-planner bug in `@kyneta/datalog`,
// not a property of the rules), and a second live implementation of resolution
// is a liability: two peers running different native code diverge silently from
// the same store, which is why §B.7 requires an engine version pinned in the
// creation constraint — a mechanism this package never built.
//
// It is kept **here**, outside `src/`, because it is worth more as an oracle
// than as an optimization. With the fast path gone the Datalog rules are the
// *only* implementation of last-writer-wins value resolution, and `tests/solver/lww-equivalence.test.ts`
// is what checks them: it runs the same inputs through `evaluate()` and through
// this file and asserts the answers match. Deleting this would have removed the
// independent implementation at exactly the moment it became the only
// cross-check.
//
// Nothing in `src/` may import it. See
// `.plans/008-retire-the-native-fast-path.md`.

import { cnIdKey } from "../../src/kernel/cnid.js"
import type { StructureIndex } from "../../src/kernel/structure-index.js"
import type {
  CnId,
  Lamport,
  PeerID,
  Value,
  ValueConstraint,
} from "../../src/kernel/types.js"

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
  let winner: LWWEntry | undefined
  for (const candidate of entries) {
    if (winner === undefined || lwwCompare(candidate, winner) > 0) {
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
