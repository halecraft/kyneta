// === Incremental Pipeline Types ===
// Shared types for the incremental kernel pipeline.
//
// This module defines the output types of the incremental pipeline:
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

import type { Value, RealityNode } from '../types.js';

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
      readonly kind: 'nodeAdded';
      readonly path: readonly string[];
      readonly node: RealityNode;
    }
  | {
      readonly kind: 'nodeRemoved';
      readonly path: readonly string[];
    }
  | {
      readonly kind: 'valueChanged';
      readonly path: readonly string[];
      readonly oldValue: Value | undefined;
      readonly newValue: Value | undefined;
    }
  | {
      readonly kind: 'childAdded';
      readonly path: readonly string[];
      readonly key: string;
      readonly child: RealityNode;
    }
  | {
      readonly kind: 'childRemoved';
      readonly path: readonly string[];
      readonly key: string;
    }
  | {
      readonly kind: 'childrenReordered';
      readonly path: readonly string[];
      readonly keys: readonly string[];
    };

/** All possible NodeDelta kind discriminants. */
export type NodeDeltaKind = NodeDelta['kind'];

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
  readonly changes: readonly NodeDelta[];

  /** True if no changes occurred (the insertion was a no-op). */
  readonly isEmpty: boolean;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** The shared empty delta instance (safe because RealityDelta is readonly). */
const EMPTY_DELTA: RealityDelta = {
  changes: [],
  isEmpty: true,
};

/**
 * Create an empty RealityDelta (no changes).
 *
 * Returns a shared singleton — safe because the type is readonly.
 */
export function realityDeltaEmpty(): RealityDelta {
  return EMPTY_DELTA;
}

/**
 * Create a RealityDelta from an array of NodeDelta changes.
 *
 * If the array is empty, returns the shared empty delta.
 */
export function realityDeltaFrom(changes: readonly NodeDelta[]): RealityDelta {
  if (changes.length === 0) return EMPTY_DELTA;
  return {
    changes,
    isEmpty: false,
  };
}
