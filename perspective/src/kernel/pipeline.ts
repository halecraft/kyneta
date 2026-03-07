// === Solver Pipeline ===
// Composition root that wires the full solver pipeline from §7.2:
//
//   S → S_V → Valid(S_V) → { AllStructure(Valid(S_V)), Active(Valid(S_V)) }
//     → StructureIndex → Projection → Resolution → Skeleton → Reality
//
// Resolution follows the spec's architecture (§B.1, §B.4, §B.7):
//   - Datalog evaluation is the PRIMARY resolution path.
//   - Native solvers are an OPTIONAL optimization (§B.7) that activates
//     only when the active rules match known default patterns.
//   - If rules are retracted/replaced, the pipeline falls back to Datalog.
//
// The structure index is built from AllStructure(Valid(S_V)) — all valid
// structure constraints regardless of dominance (§7.2). Structure constraints
// are permanent and immune to retraction, so this is equivalent to building
// from Active(S_V), but the code matches the spec's two-path pipeline design.
//
// See unified-engine.md §7.1, §7.2, §B.1, §B.4, §B.7.

import type {
  Constraint,
  PeerID,
  VersionVector,
  Reality,
  RuleConstraint,
} from './types.js';
import type { ConstraintStore } from './store.js';
import { allConstraints } from './store.js';
import { filterByVersion } from './version-vector.js';
import { computeValid, type ValidityResult } from './validity.js';
import {
  computeActive,
  type RetractionConfig,
  DEFAULT_RETRACTION_CONFIG,
  type RetractionResult,
} from './retraction.js';
import { buildStructureIndex, type StructureIndex } from './structure-index.js';
import { projectToFacts, type ProjectionResult } from './projection.js';
import {
  extractResolution,
  nativeResolution,
  type ResolutionResult,
  type ResolvedWinner,
  type FugueBeforePair,
} from './resolve.js';
import { buildSkeleton } from './skeleton.js';
import { evaluate } from '../datalog/evaluate.js';
import type { Rule, Fact } from '../datalog/types.js';
import { Database } from '../datalog/types.js';
import { resolveLWW } from '../solver/lww.js';
import { cnIdKey } from './cnid.js';
import { buildFugueNodes, orderFugueNodes } from '../solver/fugue.js';
import type { StructureConstraint } from './types.js';

// ---------------------------------------------------------------------------
// Pipeline Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for the solver pipeline.
 */
export interface PipelineConfig {
  /** The PeerID of the reality creator (holds implicit Admin). */
  readonly creator: PeerID;

  /** Retraction depth configuration. Defaults to depth 2. */
  readonly retractionConfig?: RetractionConfig;

  /**
   * Whether to enable Datalog evaluation for resolution.
   *
   * When true (default), the pipeline uses Datalog evaluation as the
   * primary resolution path (§B.1). If the active rules match the known
   * default LWW/Fugue patterns and no custom rules exist, native solvers
   * are used as a fast path (§B.7).
   *
   * When false, only native solvers are used. This bypasses the rule
   * system entirely — useful for testing or benchmarking, but does NOT
   * respect rules-as-data (custom rules are ignored).
   */
  readonly enableDatalogEvaluation?: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline Result
// ---------------------------------------------------------------------------

/**
 * Detailed result of the solver pipeline, exposing intermediate stages
 * for debugging, introspection, and testing.
 */
export interface PipelineResult {
  /** The final reality tree. */
  readonly reality: Reality;

  /** Intermediate: constraints after version filtering (S_V). */
  readonly versionFiltered: readonly Constraint[];

  /** Intermediate: validity result (valid + invalid sets, authority state). */
  readonly validityResult: ValidityResult;

  /** Intermediate: retraction result (active + dominated sets). */
  readonly retractionResult: RetractionResult;

  /** Intermediate: the structure index built from valid structure constraints. */
  readonly structureIndex: StructureIndex;

  /** Intermediate: the projection result (facts + orphaned values). */
  readonly projectionResult: ProjectionResult;

  /**
   * The resolution result used to build the skeleton.
   * Contains LWW winners and Fugue ordering, plus metadata about
   * which resolution path was used.
   */
  readonly resolutionResult: ResolutionResult;

  /**
   * Whether the native solver fast path was used.
   *
   * true  = native solvers (§B.7 optimization — rules matched defaults)
   * false = Datalog evaluation (primary path — rules are custom or absent)
   * null  = Datalog was disabled via config (testing/benchmark mode)
   */
  readonly nativeFastPath: boolean | null;
}

// ---------------------------------------------------------------------------
// Solve
// ---------------------------------------------------------------------------

/**
 * Execute the full solver pipeline: Store → Reality.
 *
 * This is the main entry point for computing the shared reality from
 * a constraint store.
 *
 * Pipeline stages (§7.2):
 * 1. **Version filter** (§7.1): If V is provided, filter to S_V.
 * 2. **Validity** (§5): Compute Valid(S_V).
 * 3. **Structure index** (§7.2, §8): Build from AllStructure(Valid(S_V)).
 * 4. **Retraction** (§6): Compute Active(Valid(S_V)).
 * 5. **Projection**: Convert active constraints → Datalog ground facts.
 * 6. **Resolution**: Datalog evaluation (primary) or native solvers (§B.7).
 * 7. **Skeleton**: Build the reality tree from resolution result.
 *
 * @param store - The constraint store.
 * @param config - Pipeline configuration.
 * @param version - Optional version vector for historical queries.
 * @returns The solved Reality tree.
 */
export function solve(
  store: ConstraintStore,
  config: PipelineConfig,
  version?: VersionVector,
): Reality {
  return solveFull(store, config, version).reality;
}

/**
 * Execute the full solver pipeline and return detailed intermediate results.
 *
 * Same as `solve()` but exposes every intermediate stage for debugging
 * and testing.
 */
export function solveFull(
  store: ConstraintStore,
  config: PipelineConfig,
  version?: VersionVector,
): PipelineResult {
  const retractionConfig = config.retractionConfig ?? DEFAULT_RETRACTION_CONFIG;
  const enableDatalog = config.enableDatalogEvaluation ?? true;

  // Step 1: Version filter (§7.1).
  const all = allConstraints(store);
  const versionFiltered: Constraint[] = version !== undefined
    ? filterByVersion(all, version)
    : all;

  // Step 2: Validity (§5).
  const validityResult = computeValid(versionFiltered, config.creator, version);

  // Step 3: Structure index (§7.2 — AllStructure(Valid(S_V))).
  // The spec's pipeline forks at Valid(S_V): one branch takes ALL valid
  // structure constraints for the skeleton, the other takes Active(Valid(S_V))
  // for value resolution. Structure constraints are immune to retraction,
  // so AllStructure(Valid(S_V)) == AllStructure(Active(Valid(S_V))) in
  // practice — but we build from the valid set to match the spec.
  const structureIndex = buildStructureIndex(validityResult.valid);

  // Step 4: Retraction (§6).
  const retractionResult = computeActive(validityResult.valid, retractionConfig);

  // Step 5: Projection — convert active constraints to Datalog ground facts.
  const projectionResult = projectToFacts(retractionResult.active, structureIndex);

  // Step 6: Resolution — Datalog primary, native fast path optional.
  let resolutionResult: ResolutionResult;
  let nativeFastPath: boolean | null;

  if (!enableDatalog) {
    // Datalog disabled — use native solvers directly (testing/benchmark).
    resolutionResult = buildNativeResolution(retractionResult.active, structureIndex);
    nativeFastPath = null;
  } else {
    const rules = extractRules(retractionResult.active);

    if (rules.length === 0) {
      // No rules in the store — use native solvers.
      // This is the case before bootstrap (Phase 5) injects rules.
      resolutionResult = buildNativeResolution(retractionResult.active, structureIndex);
      nativeFastPath = true;
    } else if (isDefaultRulesOnly(rules, retractionResult.active)) {
      // Rules match the known default LWW + Fugue patterns and no
      // custom Layer 2+ rules exist — native fast path (§B.7).
      resolutionResult = buildNativeResolution(retractionResult.active, structureIndex);
      nativeFastPath = true;
    } else {
      // Custom or modified rules — use Datalog evaluation (primary path).
      const evalResult = evaluate(rules, projectionResult.facts);
      if (evalResult.ok) {
        resolutionResult = extractResolution(evalResult.value);
      } else {
        // Datalog evaluation failed (e.g., cyclic negation).
        // Fall back to native solvers as graceful degradation.
        resolutionResult = buildNativeResolution(retractionResult.active, structureIndex);
      }
      nativeFastPath = false;
    }
  }

  // Step 7: Skeleton — build the reality tree from resolution result.
  const reality = buildSkeleton(structureIndex, retractionResult.active, resolutionResult);

  return {
    reality,
    versionFiltered,
    validityResult,
    retractionResult,
    structureIndex,
    projectionResult,
    resolutionResult,
    nativeFastPath,
  };
}

// ---------------------------------------------------------------------------
// Rule Extraction
// ---------------------------------------------------------------------------

/**
 * Extract Datalog rules from active rule constraints.
 *
 * Rule constraints carry their rules as data (head + body). This function
 * extracts them into the format the Datalog evaluator expects.
 *
 * Rules are sorted by layer to ensure deterministic evaluation order.
 */
function extractRules(activeConstraints: readonly Constraint[]): Rule[] {
  const ruleConstraints: RuleConstraint[] = [];

  for (const c of activeConstraints) {
    if (c.type === 'rule') {
      ruleConstraints.push(c);
    }
  }

  // Sort by layer (lower layers first) for predictable evaluation.
  ruleConstraints.sort((a, b) => a.payload.layer - b.payload.layer);

  return ruleConstraints.map((rc) => ({
    head: rc.payload.head,
    body: rc.payload.body,
  }));
}

// ---------------------------------------------------------------------------
// Native Solver Fast Path (§B.7)
// ---------------------------------------------------------------------------

/**
 * Build a ResolutionResult using native LWW and Fugue solvers.
 *
 * This produces the same data structure as the Datalog path but uses
 * host-language implementations directly.
 */
function buildNativeResolution(
  activeConstraints: readonly Constraint[],
  structureIndex: StructureIndex,
): ResolutionResult {
  // Native LWW: resolve all value constraints.
  const valueConstraints = activeConstraints.filter(
    (c): c is import('./types.js').ValueConstraint => c.type === 'value',
  );
  const lwwResult = resolveLWW(valueConstraints, structureIndex);

  const winners = new Map<string, ResolvedWinner>();
  for (const [slotId, winner] of lwwResult.winners) {
    winners.set(slotId, {
      slotId,
      winnerCnIdKey: cnIdKey(winner.winnerId),
      content: winner.content,
    });
  }

  // Native Fugue: compute ordering for all seq parents.
  const fuguePairs = buildNativeFuguePairs(activeConstraints, structureIndex);

  return nativeResolution(winners, fuguePairs);
}

/**
 * Build Fugue ordering pairs from native solver output.
 *
 * For each seq parent, runs the native Fugue solver and converts the
 * total order into (A, B) before-pairs that match the Datalog
 * `fugue_before(Parent, A, B)` relation shape.
 */
function buildNativeFuguePairs(
  activeConstraints: readonly Constraint[],
  structureIndex: StructureIndex,
): ReadonlyMap<string, FugueBeforePair[]> {
  const pairs = new Map<string, FugueBeforePair[]>();

  // Group seq constraints by parent.
  const seqByParent = new Map<string, StructureConstraint[]>();

  for (const c of activeConstraints) {
    if (c.type !== 'structure') continue;
    if (c.payload.kind !== 'seq') continue;
    const parentKey = cnIdKey(c.payload.parent);
    let group = seqByParent.get(parentKey);
    if (group === undefined) {
      group = [];
      seqByParent.set(parentKey, group);
    }
    group.push(c);
  }

  // For each parent, compute native Fugue ordering and emit before-pairs.
  for (const [parentKey, constraints] of seqByParent) {
    const nodes = buildFugueNodes(constraints);
    const ordered = orderFugueNodes(nodes);

    if (ordered.length <= 1) continue;

    const parentPairs: FugueBeforePair[] = [];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        parentPairs.push({
          parentKey,
          a: ordered[i]!.idKey,
          b: ordered[j]!.idKey,
        });
      }
    }

    if (parentPairs.length > 0) {
      pairs.set(parentKey, parentPairs);
    }
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Default Rule Detection (§B.7)
//
// The native fast path is safe ONLY when:
//   1. The active rules are exactly the known default LWW + Fugue rules.
//   2. No additional Layer 2+ rules exist that could interact.
//
// Detection is STRUCTURAL — we compare rule head/body shapes, not CnIds
// or timestamps. A bootstrap LWW rule from Alice is semantically identical
// to one from Bob.
// ---------------------------------------------------------------------------

/**
 * Check whether the active rules are exactly the defaults (LWW + Fugue)
 * with no additional custom rules.
 *
 * @param rules - The extracted Datalog rules from active rule constraints.
 * @param activeConstraints - All active constraints (to check for Layer 2+ rules).
 * @returns true if native fast path is safe, false if Datalog should be used.
 */
function isDefaultRulesOnly(
  rules: readonly Rule[],
  activeConstraints: readonly Constraint[],
): boolean {
  // Check if any rule constraints are at Layer 2+.
  // The presence of Layer 2+ rules means custom/configurable rules exist,
  // which might interact with the defaults — use Datalog to be safe.
  for (const c of activeConstraints) {
    if (c.type === 'rule' && c.payload.layer >= 2) {
      return false;
    }
  }

  // Check if the rules structurally match the default LWW + Fugue patterns.
  return hasDefaultLWWRules(rules) && hasDefaultFugueRules(rules);
}

/**
 * Check if the rules contain the default LWW pattern.
 *
 * Default LWW consists of 3 rules:
 *   - superseded(CnId, Slot) :- ... L2 > L1 ...
 *   - superseded(CnId, Slot) :- ... L2 == L1, P2 > P1 ...
 *   - winner(Slot, CnId, Value) :- active_value(...), not superseded(...)
 *
 * We detect by looking for:
 *   - A head predicate 'superseded' (at least one rule)
 *   - A head predicate 'winner' with a negation of 'superseded' in body
 */
function hasDefaultLWWRules(rules: readonly Rule[]): boolean {
  let hasSuperseded = false;
  let hasWinner = false;

  for (const r of rules) {
    if (r.head.predicate === 'superseded') {
      // Check that it reads from 'active_value'.
      const hasActiveValue = r.body.some(
        (b) => b.kind === 'atom' && b.atom.predicate === 'active_value',
      );
      if (hasActiveValue) {
        hasSuperseded = true;
      }
    }

    if (r.head.predicate === 'winner') {
      // Check that it reads from 'active_value' and negates 'superseded'.
      const hasActiveValue = r.body.some(
        (b) => b.kind === 'atom' && b.atom.predicate === 'active_value',
      );
      const negatesSuperseded = r.body.some(
        (b) => b.kind === 'negation' && b.atom.predicate === 'superseded',
      );
      if (hasActiveValue && negatesSuperseded) {
        hasWinner = true;
      }
    }
  }

  return hasSuperseded && hasWinner;
}

/**
 * Check if the rules contain the default Fugue pattern.
 *
 * Default Fugue consists of 2 rules:
 *   - fugue_child(Parent, CnId, ...) :- active_structure_seq(...), constraint_peer(...)
 *   - fugue_before(Parent, A, B) :- fugue_child(...), fugue_child(...), A ≠ B, PeerA < PeerB
 *
 * We detect by looking for:
 *   - A head predicate 'fugue_child' reading from 'active_structure_seq'
 *   - A head predicate 'fugue_before' reading from 'fugue_child'
 */
function hasDefaultFugueRules(rules: readonly Rule[]): boolean {
  let hasFugueChild = false;
  let hasFugueBefore = false;

  for (const r of rules) {
    if (r.head.predicate === 'fugue_child') {
      const hasSeqStructure = r.body.some(
        (b) => b.kind === 'atom' && b.atom.predicate === 'active_structure_seq',
      );
      if (hasSeqStructure) {
        hasFugueChild = true;
      }
    }

    if (r.head.predicate === 'fugue_before') {
      const hasFugueChildBody = r.body.some(
        (b) => b.kind === 'atom' && b.atom.predicate === 'fugue_child',
      );
      if (hasFugueChildBody) {
        hasFugueBefore = true;
      }
    }
  }

  return hasFugueChild && hasFugueBefore;
}