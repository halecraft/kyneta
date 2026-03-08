// === Incremental Pipeline Composition Root ===
// Wires all incremental stages into the DAG:
//
//   insert(c) → store.insert → C^Δ (validity) → fan-out:
//     → X^Δ (structure index)
//     → A^Δ (retraction)
//       → P^Δ (projection, two-input: Δ_active × Δ_index)
//         → E^Δ (evaluation, two-input: Δ_facts × Δ_rules)
//           → K^Δ (skeleton, three-input: Δ_resolved × Δ_fuguePairs × Δ_index)
//             → RealityDelta
//
// The version filter (F^Δ) is identity — not a separate module.
//
// Plan 006 Phase 4 replaced the batch evaluator call + diffResolution shim
// with the IncrementalEvaluation stage. Phase 6 replaced the batch Datalog
// fallback with the incremental Datalog evaluator — all paths are now
// incremental. No batch evaluator calls remain in this pipeline.
//
// See .plans/006-incremental-datalog-evaluator.md § Phase 4, Phase 6.
// See theory/incremental.md §2–§6, §9.7.

import type {
  Constraint,
  Reality,
  PeerID,
} from '../types.js';
import type { PipelineConfig } from '../pipeline.js';
import { solve } from '../pipeline.js';
import type { ConstraintStore } from '../store.js';
import {
  createStore,
  insert as storeInsert,
  hasConstraint,
  allConstraints,
} from '../store.js';
import { cnIdKey } from '../cnid.js';
import { DEFAULT_RETRACTION_CONFIG } from '../retraction.js';

import type { ZSet } from '../../base/zset.js';
import {
  zsetEmpty,
  zsetSingleton,
  zsetIsEmpty,
} from '../../base/zset.js';

import type { RealityDelta } from './types.js';
import { realityDeltaEmpty, realityDeltaFrom } from './types.js';
import type { StructureIndexDelta } from './types.js';

import { createIncrementalValidity } from './validity.js';
import { createIncrementalStructureIndex } from './structure-index.js';
import { createIncrementalRetraction } from './retraction.js';
import { createIncrementalProjection } from './projection.js';
import { createIncrementalSkeleton } from './skeleton.js';
import {
  createIncrementalEvaluation,
  extractRuleDeltasFromActive,
} from './evaluation.js';

import type { BootstrapResult } from '../../bootstrap.js';

// ---------------------------------------------------------------------------
// IncrementalPipeline Interface
// ---------------------------------------------------------------------------

/**
 * An incremental pipeline that processes single-constraint insertions
 * and produces reality deltas.
 *
 * After each insertion, `current()` produces a `Reality` identical to
 * `solve(store, config)` for the same store — verified by differential
 * testing via `recompute()`.
 */
export interface IncrementalPipeline {
  /** Insert a single constraint. Returns what changed in the reality. */
  insert(constraint: Constraint): RealityDelta;

  /** Insert multiple constraints (batch). Returns combined delta. */
  insertMany(constraints: readonly Constraint[]): RealityDelta;

  /** The current full reality (accumulated from all deltas). */
  current(): Reality;

  /** Full batch recomputation for verification (differential testing). */
  recompute(): Reality;

  /** The underlying store (for sync, export, etc). */
  readonly store: ConstraintStore;

  /** The pipeline config. */
  readonly config: PipelineConfig;
}

// ---------------------------------------------------------------------------
// Pipeline Construction
// ---------------------------------------------------------------------------

/**
 * Create an incremental pipeline from a pipeline configuration.
 *
 * The pipeline starts empty. All constraints must be fed through
 * `insert()` or `insertMany()`.
 *
 * @param config - Pipeline configuration (creator, retraction depth, etc).
 * @param existingStore - Optional existing store to use. If not provided,
 *   a new empty store is created.
 * @returns A new IncrementalPipeline.
 */
export function createIncrementalPipeline(
  config: PipelineConfig,
  existingStore?: ConstraintStore,
): IncrementalPipeline {
  const store = existingStore ?? createStore();
  const retractionConfig = config.retractionConfig ?? DEFAULT_RETRACTION_CONFIG;

  // --- Create all incremental stages ---

  const validity = createIncrementalValidity(config.creator);
  const structureIndex = createIncrementalStructureIndex();
  const retraction = createIncrementalRetraction(retractionConfig);
  const projection = createIncrementalProjection(
    () => structureIndex.current(),
  );
  const skeleton = createIncrementalSkeleton(
    () => structureIndex.current(),
  );
  const evaluation = createIncrementalEvaluation();

  // --- DAG wiring ---

  /**
   * Run the full incremental pipeline for a single constraint delta.
   *
   * The constraint must already be in the store. This function
   * processes it through all stages and returns the reality delta.
   */
  function processConstraint(constraint: Constraint): RealityDelta {
    // Step 1: Version filter — identity (no version parameter).
    // Create a Z-set delta with the new constraint at weight +1.
    const inputDelta = zsetSingleton(
      cnIdKey(constraint.id),
      constraint,
      1,
    );

    // Step 2: C^Δ — Validity
    const validDelta = validity.step(inputDelta);

    // If nothing passed validity, check if we still need to evaluate
    // (authority changes can affect existing constraints).
    if (zsetIsEmpty(validDelta)) {
      return realityDeltaEmpty();
    }

    // Step 3: Fan-out — valid delta goes to both structure index
    // and retraction.

    // X^Δ — Structure Index (append-only, ignores non-structure)
    const indexDelta = structureIndex.step(validDelta);

    // A^Δ — Retraction (dominance cascade)
    const activeDelta = retraction.step(validDelta);

    // Step 4: P^Δ — Projection (two-input: Δ_active × Δ_index)
    const factsDelta = projection.step(activeDelta, indexDelta);

    // Step 5: E^Δ — Evaluation (two-input: Δ_facts × Δ_rules)
    // Extract rule deltas from the active-set delta (rule constraints
    // that became active or dominated).
    const ruleDeltas = extractRuleDeltasFromActive(activeDelta);

    const { deltaResolved, deltaFuguePairs } = evaluation.step(
      factsDelta,
      ruleDeltas,
      // Lazy getters — only called on strategy switches (bootstrapping
      // the new strategy from accumulated facts).
      () => projection.current(),
      () => retraction.current(),
    );

    // Step 6: K^Δ — Skeleton (three-input)
    const realityDelta = skeleton.step(
      deltaResolved,
      deltaFuguePairs,
      indexDelta,
    );

    return realityDelta;
  }

  // --- Public interface ---

  function insert(constraint: Constraint): RealityDelta {
    // Deduplication guard (Task 8.2a): if the constraint already
    // exists in the store, return empty delta without processing.
    if (hasConstraint(store, constraint.id)) {
      return realityDeltaEmpty();
    }

    // Insert into store
    const result = storeInsert(store, constraint);
    if (!result.ok) {
      // Store rejected the constraint (validation failure).
      // Return empty delta — the constraint is not in the system.
      return realityDeltaEmpty();
    }

    // Process through the DAG
    return processConstraint(constraint);
  }

  function insertManyFn(constraints: readonly Constraint[]): RealityDelta {
    if (constraints.length === 0) return realityDeltaEmpty();

    // Process each constraint sequentially through insert().
    // Accumulate all node deltas from each insertion.
    const allChanges: import('./types.js').NodeDelta[] = [];

    for (const c of constraints) {
      const delta = insert(c);
      if (!delta.isEmpty) {
        allChanges.push(...delta.changes);
      }
    }

    if (allChanges.length === 0) return realityDeltaEmpty();
    return realityDeltaFrom(allChanges);
  }

  function current(): Reality {
    return skeleton.current();
  }

  function recompute(): Reality {
    return solve(store, config);
  }

  return {
    insert,
    insertMany: insertManyFn,
    current,
    recompute,
    store,
    config,
  };
}

// ---------------------------------------------------------------------------
// Bootstrap Construction
// ---------------------------------------------------------------------------

/**
 * Create an incremental pipeline pre-populated with bootstrap constraints.
 *
 * The store from the BootstrapResult already contains the bootstrap
 * constraints. We create the pipeline with that store and replay
 * all existing constraints through the DAG to build up accumulated
 * state.
 *
 * @param result - The BootstrapResult from createReality().
 * @returns A new IncrementalPipeline with bootstrap state.
 */
export function createIncrementalPipelineFromBootstrap(
  result: BootstrapResult,
): IncrementalPipeline {
  // Create pipeline with the bootstrap store.
  // We pass a fresh store and manually insert+process each constraint
  // so the incremental stages build up their accumulated state.
  const pipeline = createIncrementalPipeline(result.config);

  // Replay all bootstrap constraints through the pipeline.
  // The order from allConstraints is the Map insertion order,
  // which matches the bootstrap insertion order (admin grant first,
  // then LWW rules, then Fugue rules).
  const constraints = allConstraints(result.store);
  for (const c of constraints) {
    pipeline.insert(c);
  }

  return pipeline;
}