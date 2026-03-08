// === Native Incremental LWW Solver ===
// Per-slot winner tracking that receives `active_value` fact deltas and
// emits `ZSet<ResolvedWinner>` deltas. This is the O(1) fast path for
// LWW resolution described in theory/incremental.md §9.7.
//
// For each slot, maintains a Map of all competing entries and the current
// winner. On insertion, compares against the current winner in O(1). On
// retraction, recomputes the winner from remaining entries in O(entries).
//
// Delta contract (must match the skeleton's expectations from Plan 005):
// - New winner: emit {slotId: +1}
// - Changed winner (replacement): emit {slotId: +1} only (NOT −1 then +1,
//   because both would share the same Z-set key and annihilate)
// - Removed winner (no entries left): emit {slotId: −1}
// - No change: empty delta
//
// See Plan 005 Learnings: Resolution Diffing Must Not Emit Opposing Weights
// on the Same Key.

import type { Fact } from '../datalog/types.js';
import type { ResolvedWinner } from '../kernel/resolve.js';
import { parseLWWFact } from '../kernel/resolve.js';
import { cnIdKey } from '../kernel/cnid.js';
import { lwwCompare, type LWWEntry } from './lww.js';
import { ACTIVE_VALUE } from '../kernel/projection.js';
import type { ZSet } from '../base/zset.js';
import {
  zsetEmpty,
  zsetSingleton,
  zsetAdd,
  zsetForEach,
} from '../base/zset.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-slot state: all competing entries and the current winner. */
interface SlotState {
  /** All active entries for this slot, keyed by cnIdKey. */
  readonly entries: Map<string, LWWEntry>;
  /** The current winner, or null if no entries. */
  winner: LWWEntry | null;
}

/**
 * Incremental LWW solver.
 *
 * Maintains per-slot winner tracking and produces `ZSet<ResolvedWinner>`
 * deltas on each step. Follows the three shared conventions:
 *   1. step(deltaFacts) — process fact delta, return winner delta
 *   2. current() — return full materialized winners map
 *   3. reset() — return to empty state
 */
export interface IncrementalLWW {
  /** Process active_value fact deltas, return winner deltas. */
  step(deltaFacts: ZSet<Fact>): ZSet<ResolvedWinner>;

  /** Current winners map (slotId → ResolvedWinner). */
  current(): ReadonlyMap<string, ResolvedWinner>;

  /** Reset to empty state. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert an LWWEntry to a ResolvedWinner. */
function entryToWinner(entry: LWWEntry): ResolvedWinner {
  return {
    slotId: entry.slotId,
    winnerCnIdKey: cnIdKey(entry.id),
    content: entry.content,
  };
}

/**
 * Find the winner among all entries for a slot.
 * Returns null if the entries map is empty.
 */
function findWinner(entries: ReadonlyMap<string, LWWEntry>): LWWEntry | null {
  let best: LWWEntry | null = null;
  for (const entry of entries.values()) {
    if (best === null || lwwCompare(entry, best) > 0) {
      best = entry;
    }
  }
  return best;
}

/** Check if two winners are the same (by CnId key and content). */
function winnersEqual(
  a: ResolvedWinner | null,
  b: ResolvedWinner | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.winnerCnIdKey === b.winnerCnIdKey && a.content === b.content;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create a new incremental LWW solver.
 *
 * @returns An IncrementalLWW instance with empty state.
 */
export function createIncrementalLWW(): IncrementalLWW {
  // Per-slot state: slotId → SlotState
  let slots = new Map<string, SlotState>();

  function getOrCreateSlot(slotId: string): SlotState {
    let slot = slots.get(slotId);
    if (slot === undefined) {
      slot = { entries: new Map(), winner: null };
      slots.set(slotId, slot);
    }
    return slot;
  }

  function step(deltaFacts: ZSet<Fact>): ZSet<ResolvedWinner> {
    let delta = zsetEmpty<ResolvedWinner>();

    zsetForEach(deltaFacts, (entry, _key) => {
      const f = entry.element;
      const weight = entry.weight;

      // Only process active_value facts
      if (f.predicate !== ACTIVE_VALUE.predicate) return;

      const lwwEntry = parseLWWFact(f);
      const slotId = lwwEntry.slotId;
      const entryKey = cnIdKey(lwwEntry.id);
      const slot = getOrCreateSlot(slotId);

      // Capture old winner for comparison
      const oldWinner = slot.winner !== null
        ? entryToWinner(slot.winner)
        : null;

      if (weight > 0) {
        // --- Insertion ---
        slot.entries.set(entryKey, lwwEntry);

        // Compare against current winner
        if (slot.winner === null || lwwCompare(lwwEntry, slot.winner) > 0) {
          slot.winner = lwwEntry;
        }
      } else if (weight < 0) {
        // --- Retraction ---
        slot.entries.delete(entryKey);

        if (slot.winner !== null && cnIdKey(slot.winner.id) === entryKey) {
          // The winner was retracted — recompute from remaining entries
          slot.winner = findWinner(slot.entries);
        }
      }

      // Compute new winner
      const newWinner = slot.winner !== null
        ? entryToWinner(slot.winner)
        : null;

      // Emit delta if winner changed
      if (!winnersEqual(oldWinner, newWinner)) {
        if (newWinner !== null) {
          // New or changed winner: emit +1 only (skeleton handles replacement)
          delta = zsetAdd(delta, zsetSingleton(slotId, newWinner, 1));
        } else {
          // Winner removed entirely: emit −1 with the old winner
          delta = zsetAdd(delta, zsetSingleton(slotId, oldWinner!, -1));
        }
      }
    });

    return delta;
  }

  function current(): ReadonlyMap<string, ResolvedWinner> {
    const winners = new Map<string, ResolvedWinner>();
    for (const [slotId, slot] of slots) {
      if (slot.winner !== null) {
        winners.set(slotId, entryToWinner(slot.winner));
      }
    }
    return winners;
  }

  function reset(): void {
    slots = new Map();
  }

  return { step, current, reset };
}