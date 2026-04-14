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

import { evaluateUnified as evaluate } from "../datalog/evaluator.js"
import { buildNativeResolution } from "./native-resolution.js"
import { type ProjectionResult, projectToFacts } from "./projection.js"
import { extractResolution, type ResolutionResult } from "./resolve.js"
import {
  computeActive,
  DEFAULT_RETRACTION_CONFIG,
  type RetractionConfig,
  type RetractionResult,
} from "./retraction.js"
import { extractRules, selectResolutionStrategy } from "./rule-detection.js"
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
  readonly enableDatalogEvaluation?: boolean
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

  /**
   * Whether the native solver fast path was used.
   *
   * true  = native solvers (§B.7 optimization — rules matched defaults)
   * false = Datalog evaluation (primary path — rules are custom or absent)
   * null  = Datalog was disabled via config (testing/benchmark mode)
   */
  readonly nativeFastPath: boolean | null
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
export function solveFull(
  store: ConstraintStore,
  config: PipelineConfig,
  version?: VersionVector,
): PipelineResult {
  const retractionConfig = config.retractionConfig ?? DEFAULT_RETRACTION_CONFIG
  const enableDatalog = config.enableDatalogEvaluation ?? true

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

  // Step 6: Resolution — Datalog primary, native fast path optional.
  let resolutionResult: ResolutionResult
  let nativeFastPath: boolean | null

  const rules = extractRules(retractionResult.active)
  const strategy = selectResolutionStrategy(
    enableDatalog,
    rules,
    retractionResult.active,
  )

  if (strategy === "native") {
    resolutionResult = buildNativeResolution(
      retractionResult.active,
      structureIndex,
    )
    nativeFastPath = enableDatalog ? true : null
  } else {
    // Custom or modified rules — use Datalog evaluation (primary path).
    const evalResult = evaluate(rules, projectionResult.facts)
    if (evalResult.ok) {
      resolutionResult = extractResolution(evalResult.value)
    } else {
      // Datalog evaluation failed (e.g., cyclic negation).
      // Fall back to native solvers as graceful degradation.
      resolutionResult = buildNativeResolution(
        retractionResult.active,
        structureIndex,
      )
    }
    nativeFastPath = false
  }

  // Step 7: Skeleton — build the reality tree from resolution result.
  const reality = buildSkeleton(
    structureIndex,
    retractionResult.active,
    resolutionResult,
  )

  return {
    reality,
    versionFiltered,
    validityResult,
    retractionResult,
    structureIndex,
    projectionResult,
    resolutionResult,
    nativeFastPath,
  }
}
