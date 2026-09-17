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

import type { Host, StratificationError } from "@kyneta/datalog"
import { evaluate } from "@kyneta/datalog"
import { type ProjectionResult, projectToFacts } from "./projection.js"
import { extractResolution, type ResolutionResult } from "./resolve.js"
import {
  computeActive,
  DEFAULT_RETRACTION_CONFIG,
  type RetractionConfig,
  type RetractionResult,
} from "./retraction.js"
import { extractRules } from "./rules.js"
import { buildSkeleton } from "./skeleton.js"
import type { ConstraintStore } from "./store.js"
import { allConstraints } from "./store.js"
import { buildStructureIndex, type StructureIndex } from "./structure-index.js"
import type { Constraint, PeerID, Reality, VersionVector } from "./types.js"
import { computeValid, type ValidityResult } from "./validity.js"
import { filterByVersion } from "./version-vector.js"

// ---------------------------------------------------------------------------
// Pipeline Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for the solver pipeline.
 */
export interface PipelineConfig {
  /** The PeerID of the reality creator (holds implicit Admin). */
  readonly creator: PeerID

  /** Retraction depth configuration. Defaults to depth 2. */
  readonly retractionConfig?: RetractionConfig

  /**
   * Host-computed relations and point functions that rules may reference by
   * name (see `@kyneta/datalog`). This changes results: it is the
   * per-relation form of the engine-version pin
   * in spec §B.7, and a reality that uses it must have every peer register
   * the same names with the same behaviour. The engine checks presence, not
   * agreement.
   */
  readonly host?: Host
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
  readonly reality: Reality

  /** Intermediate: constraints after version filtering (S_V). */
  readonly versionFiltered: readonly Constraint[]

  /** Intermediate: validity result (valid + invalid sets, authority state). */
  readonly validityResult: ValidityResult

  /** Intermediate: retraction result (active + dominated sets). */
  readonly retractionResult: RetractionResult

  /** Intermediate: the structure index built from valid structure constraints. */
  readonly structureIndex: StructureIndex

  /** Intermediate: the projection result (facts + orphaned values). */
  readonly projectionResult: ProjectionResult

  /**
   * The resolution result used to build the skeleton.
   * Contains LWW winners and Fugue ordering, plus metadata about
   * which resolution path was used.
   */
  readonly resolutionResult: ResolutionResult
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
  return solveFull(store, config, version).reality
}

/**
 * Execute the full solver pipeline and return detailed intermediate results.
 *
 * Same as `solve()` but exposes every intermediate stage for debugging
 * and testing.
 */
/**
 * One line describing why a rule set could not be stratified.
 *
 * Stratification is the check that negation never loops: a rule may only negate
 * a relation computed *before* it, so `a :- not b.` and `b :- not a.` have no
 * least model and the evaluator refuses them. The other cases are a rule naming
 * host code the engine was not given.
 */
function describeRuleSetError(error: StratificationError): string {
  switch (error.kind) {
    case "cyclicNegation":
      return `negation forms a cycle through ${error.cycle.join(" → ")}`
    case "unknownHostFunction":
      return `rule for "${error.rule.head.predicate}" names host function "${error.fn}", which is not registered`
    case "foreignPredicateDerived":
      return `a rule derives "${error.predicate}", which is a host-computed relation`
    case "foreignArityMismatch":
      return `rule for "${error.rule.head.predicate}" matches host-computed relation "${error.predicate}" with ${error.found} terms, but it holds ${error.declared}-tuples`
    case "unboundComputeArgument":
      return `rule for "${error.rule.head.predicate}" passes unbound variable "${error.variable}" to host function "${error.fn}"`
  }
}

export function solveFull(
  store: ConstraintStore,
  config: PipelineConfig,
  version?: VersionVector,
): PipelineResult {
  const retractionConfig = config.retractionConfig ?? DEFAULT_RETRACTION_CONFIG

  // Step 1: Version filter (§7.1).
  const all = allConstraints(store)
  const versionFiltered: Constraint[] =
    version !== undefined ? filterByVersion(all, version) : all

  // Step 2: Validity (§5).
  const validityResult = computeValid(versionFiltered, config.creator, version)

  // Step 3: Structure index (§7.2 — AllStructure(Valid(S_V))).
  // The spec's pipeline forks at Valid(S_V): one branch takes ALL valid
  // structure constraints for the skeleton, the other takes Active(Valid(S_V))
  // for value resolution. Structure constraints are immune to retraction,
  // so AllStructure(Valid(S_V)) == AllStructure(Active(Valid(S_V))) in
  // practice — but we build from the valid set to match the spec.
  const structureIndex = buildStructureIndex(validityResult.valid)

  // Step 4: Retraction (§6).
  const retractionResult = computeActive(validityResult.valid, retractionConfig)

  // Step 5: Projection — convert active constraints to Datalog ground facts.
  const projectionResult = projectToFacts(
    retractionResult.active,
    structureIndex,
  )

  // Step 6: Resolution — the Datalog rules in the store, and nothing else.
  //
  // There used to be a second path here: hand-written LWW and Fugue solvers
  // that ran whenever the store's rules matched the known defaults (spec §B.7).
  // They existed on a performance argument that was measured and did not hold
  // — the quadratic they were avoiding turned out to be a query-planner bug in
  // `@kyneta/datalog`, not a property of the rules. See
  // `.plans/008-retire-the-native-fast-path.md`.
  //
  // A store with no rule constraints therefore resolves to an empty reality
  // rather than to LWW-by-default. That is the honest reading of "rules are
  // data": resolution semantics live in the store, so a store that does not
  // carry them does not have them.
  const rules = extractRules(retractionResult.active)
  const evalResult = evaluate(rules, projectionResult.facts, config.host)

  // A rule set that cannot be stratified is a defect in the store, not a
  // condition to route around. Resolving it with some other rule set would
  // compute a reality that this peer's own constraints do not describe, and
  // would do it silently — which is worse than refusing, because the caller
  // has no way to notice. (The previous behaviour was exactly that: fall back
  // to the native solvers and return a reality under the default rules.)
  if (!evalResult.ok) {
    throw new Error(
      `cannot solve: the store's rule set cannot be evaluated — ${describeRuleSetError(evalResult.error)}`,
    )
  }
  const resolutionResult = extractResolution(evalResult.value)

  // Step 7: Skeleton — build the reality tree from resolution result.
  const reality = buildSkeleton(structureIndex, resolutionResult)

  return {
    reality,
    versionFiltered,
    validityResult,
    retractionResult,
    structureIndex,
    projectionResult,
    resolutionResult,
  }
}
