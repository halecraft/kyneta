// === Incremental Pipeline Types ===
// Shared types for the incremental kernel pipeline.
//
// This module defines the output types of the incremental pipeline:
// - StructureIndexDelta: monotone output of the structure index stage
// - NodeDelta: a single change to the reality tree
// - RealityDelta: a collection of changes from a single insertion
//
// Each stage is a concrete module with its own specific step signature
// (see Plan 005 § Operator Conventions). All stages follow three shared
// conventions:
//   1. step(...deltas) — process input delta(s), return output delta
//   2. current() — return full materialized output
//   3. reset() — return to empty state
//
// See theory/incremental.md §10 for the theoretical foundation.
// See .plans/005-incremental-kernel-pipeline.md § Operator Conventions.

import type { SlotGroup } from "../structure-index.js"
import type { RealityNode, Value } from "../types.js"

// ---------------------------------------------------------------------------
// Structure Index Delta
// ---------------------------------------------------------------------------

/**
 * Output of the incremental structure index stage.
 *
 * Structure is monotone (append-only, never retracted), so this is NOT a
 * Z-set. A Z-set would be wrong here: SlotGroups have stable identity
 * (slotId) but mutable contents (the structures array grows when a second
 * peer creates the same map child). Emitting {old: −1, new: +1} for the
 * same slotId key would annihilate to zero under zsetAdd, and emitting
 * only +1 would inflate weights on accumulation. Neither is correct.
 *
 * Instead, this is a plain map of slot groups that were created or modified
 * in this step. Consumers treat each entry as "latest state for this slotId"
 * (upsert semantics). This is the correct model: the structure index is a
 * monotone operator on a semilattice, not a group operator on Z-sets.
 *
 * See .plans/005-incremental-kernel-pipeline.md § Structure Index Delta.
 * See .plans/005-incremental-kernel-pipeline.md § Learnings: Z-Sets Are the
 * Wrong Abstraction for Monotone Stages.
 */
export interface StructureIndexDelta {
  /** Slot groups that were created or modified in this step, keyed by slotId. */
  readonly updates: ReadonlyMap<string, SlotGroup>
  /** True if nothing changed. */
  readonly isEmpty: boolean
}

// ---------------------------------------------------------------------------
// Structure Index Delta Constructors
// ---------------------------------------------------------------------------

/** The shared empty structure index delta (safe because it's readonly). */
const EMPTY_STRUCTURE_INDEX_DELTA: StructureIndexDelta = {
  updates: new Map(),
  isEmpty: true,
}

/**
 * Create an empty StructureIndexDelta (no changes).
 *
 * Returns a shared singleton — safe because the type is readonly.
 */
export function structureIndexDeltaEmpty(): StructureIndexDelta {
  return EMPTY_STRUCTURE_INDEX_DELTA
}

/**
 * Create a StructureIndexDelta from a map of updated slot groups.
 *
 * If the map is empty, returns the shared empty delta.
 */
export function structureIndexDeltaFrom(
  updates: ReadonlyMap<string, SlotGroup>,
): StructureIndexDelta {
  if (updates.size === 0) return EMPTY_STRUCTURE_INDEX_DELTA
  return { updates, isEmpty: false }
}

// ---------------------------------------------------------------------------
// Node Delta
// ---------------------------------------------------------------------------

/**
 * A single change to the reality tree.
 *
 * Discriminated union on `kind`. Each variant describes one atomic
 * mutation to the tree structure or a node's value.
 *
 * The `path` field identifies the node in the tree as a sequence of
 * child keys from the synthetic root. For example, `['profile', 'name']`
 * refers to the 'name' child of the 'profile' container.
 */
export type NodeDelta =
  | {
      readonly kind: "nodeAdded"
      readonly path: readonly string[]
      readonly node: RealityNode
    }
  | {
      readonly kind: "nodeRemoved"
      readonly path: readonly string[]
    }
  | {
      readonly kind: "valueChanged"
      readonly path: readonly string[]
      readonly oldValue: Value | undefined
      readonly newValue: Value | undefined
    }
  | {
      readonly kind: "childAdded"
      readonly path: readonly string[]
      readonly key: string
      readonly child: RealityNode
    }
  | {
      readonly kind: "childRemoved"
      readonly path: readonly string[]
      readonly key: string
    }
  | {
      readonly kind: "childrenReordered"
      readonly path: readonly string[]
      readonly keys: readonly string[]
    }

/** All possible NodeDelta kind discriminants. */
export type NodeDeltaKind = NodeDelta["kind"]

// ---------------------------------------------------------------------------
// Reality Delta
// ---------------------------------------------------------------------------

/**
 * The output of a single incremental pipeline step: a collection of
 * changes to the reality tree.
 *
 * Produced by `IncrementalPipeline.insert()` and consumed by downstream
 * observers (UI, sync, etc.).
 */
export interface RealityDelta {
  /** The individual changes, in the order they were applied. */
  readonly changes: readonly NodeDelta[]

  /** True if no changes occurred (the insertion was a no-op). */
  readonly isEmpty: boolean
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** The shared empty delta instance (safe because RealityDelta is readonly). */
const EMPTY_DELTA: RealityDelta = {
  changes: [],
  isEmpty: true,
}

/**
 * Create an empty RealityDelta (no changes).
 *
 * Returns a shared singleton — safe because the type is readonly.
 */
export function realityDeltaEmpty(): RealityDelta {
  return EMPTY_DELTA
}

/**
 * Create a RealityDelta from an array of NodeDelta changes.
 *
 * If the array is empty, returns the shared empty delta.
 */
export function realityDeltaFrom(changes: readonly NodeDelta[]): RealityDelta {
  if (changes.length === 0) return EMPTY_DELTA
  return {
    changes,
    isEmpty: false,
  }
}
