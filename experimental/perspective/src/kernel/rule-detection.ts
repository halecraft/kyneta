// === Rule Detection & Strategy Selection ===
// Shared utilities for extracting Datalog rules from active constraints,
// detecting whether the default LWW/Fugue rule patterns are present, and
// selecting the resolution strategy (native fast path vs Datalog).
//
// These functions were duplicated in both `kernel/pipeline.ts` and
// `kernel/incremental/pipeline.ts`. Extracted here as the single source
// of truth (Plan 006, Phase 1).
//
// See unified-engine.md §B.4 (default solver rules), §B.7 (native solver
// optimization), §14 (stratification layers).

import type { Rule } from "../datalog/types.js"
import type { Constraint, RuleConstraint } from "./types.js"

// ---------------------------------------------------------------------------
// Resolution Strategy
// ---------------------------------------------------------------------------

/** The resolution path the pipeline should use. */
export type ResolutionStrategy = "native" | "datalog"

/**
 * Select the resolution strategy based on config and active rules.
 *
 * This is the pure decision function that both the batch and incremental
 * pipelines use. It encapsulates the identical if/else chain that was
 * previously duplicated in both pipeline composition roots.
 *
 * @param enableDatalog - Whether Datalog evaluation is enabled in the config.
 *   When false, always returns 'native' (testing/benchmark mode).
 * @param rules - Extracted Datalog rules from active rule constraints.
 * @param activeConstraints - All active constraints (to check for Layer 2+).
 * @returns 'native' if the native fast path is safe, 'datalog' otherwise.
 */
export function selectResolutionStrategy(
  enableDatalog: boolean,
  rules: readonly Rule[],
  activeConstraints: readonly Constraint[],
): ResolutionStrategy {
  if (!enableDatalog) {
    return "native"
  }

  if (rules.length === 0) {
    // No rules in the store — use native solvers.
    // This is the case before bootstrap injects rules.
    return "native"
  }

  if (isDefaultRulesOnly(rules, activeConstraints)) {
    // Rules match the known default LWW + Fugue patterns and no
    // custom Layer 2+ rules exist — native fast path (§B.7).
    return "native"
  }

  // Custom or modified rules — use Datalog evaluation (primary path).
  return "datalog"
}

// ---------------------------------------------------------------------------
// Rule Extraction
// ---------------------------------------------------------------------------

/**
 * Extract Datalog rules from active constraints.
 *
 * Rule constraints carry their rules as data (head + body). This function
 * extracts them into the format the Datalog evaluator expects.
 *
 * Rules are sorted by layer to ensure deterministic evaluation order.
 */
export function extractRules(activeConstraints: readonly Constraint[]): Rule[] {
  const ruleConstraints: RuleConstraint[] = []

  for (const c of activeConstraints) {
    if (c.type === "rule") {
      ruleConstraints.push(c)
    }
  }

  // Sort by layer (lower layers first) for predictable evaluation.
  ruleConstraints.sort((a, b) => a.payload.layer - b.payload.layer)

  return ruleConstraints.map(rc => ({
    head: rc.payload.head,
    body: rc.payload.body,
  }))
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
export function isDefaultRulesOnly(
  rules: readonly Rule[],
  activeConstraints: readonly Constraint[],
): boolean {
  // Check if any rule constraints are at Layer 2+.
  // The presence of Layer 2+ rules means custom/configurable rules exist,
  // which might interact with the defaults — use Datalog to be safe.
  for (const c of activeConstraints) {
    if (c.type === "rule" && c.payload.layer >= 2) {
      return false
    }
  }

  // Check if the rules structurally match the default LWW + Fugue patterns.
  return hasDefaultLWWRules(rules) && hasDefaultFugueRules(rules)
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
 *   - A head predicate 'superseded' reading from 'active_value'
 *   - A head predicate 'winner' with a negation of 'superseded' in body
 */
export function hasDefaultLWWRules(rules: readonly Rule[]): boolean {
  let hasSuperseded = false
  let hasWinner = false

  for (const r of rules) {
    if (r.head.predicate === "superseded") {
      const hasActiveValue = r.body.some(
        b => b.kind === "atom" && b.atom.predicate === "active_value",
      )
      if (hasActiveValue) {
        hasSuperseded = true
      }
    }

    if (r.head.predicate === "winner") {
      const hasActiveValue = r.body.some(
        b => b.kind === "atom" && b.atom.predicate === "active_value",
      )
      const negatesSuperseded = r.body.some(
        b => b.kind === "negation" && b.atom.predicate === "superseded",
      )
      if (hasActiveValue && negatesSuperseded) {
        hasWinner = true
      }
    }
  }

  return hasSuperseded && hasWinner
}

/**
 * Check if the rules contain the default Fugue pattern.
 *
 * Default Fugue consists of 8 rules across 3 predicates. We detect by
 * looking for the structural anchors:
 *   - A head predicate 'fugue_child' reading from 'active_structure_seq'
 *   - A head predicate 'fugue_before' reading from 'fugue_child'
 */
export function hasDefaultFugueRules(rules: readonly Rule[]): boolean {
  let hasFugueChild = false
  let hasFugueBefore = false

  for (const r of rules) {
    if (r.head.predicate === "fugue_child") {
      const hasSeqStructure = r.body.some(
        b => b.kind === "atom" && b.atom.predicate === "active_structure_seq",
      )
      if (hasSeqStructure) {
        hasFugueChild = true
      }
    }

    if (r.head.predicate === "fugue_before") {
      const hasFugueChildBody = r.body.some(
        b => b.kind === "atom" && b.atom.predicate === "fugue_child",
      )
      if (hasFugueChildBody) {
        hasFugueBefore = true
      }
    }
  }

  return hasFugueChild && hasFugueBefore
}
