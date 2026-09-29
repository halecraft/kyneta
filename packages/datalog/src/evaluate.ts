// === Datalog Evaluation Core ===
// Per-rule evaluation functions used by both the unified evaluator
// (evaluator.ts) and the naive test utility below.
//
// Weight semantics (Plan 006.1, extended by Plan 006.2):
// - Substitutions carry weights through evaluation.
// - Positive atom join: weight = sub.weight × tuple.weight (provenance product).
// - Negation/guard: weight preserved on pass, substitution dropped on fail.
// - Compute: a host function of bound values binds its result; weight preserved.
// - Differential negation: weight = sub.weight × (-deltaWeight) (sign inversion).
// - Aggregation: output weight = 1 (group-by boundary resets provenance).
// - groundHead: duplicate facts sum weights (Z-set addition).
// - evaluateRule returns WeightedFact[] with summed weights per fact.
// - In batch mode, all input weights are 1, so all derived weights are 1.
//   The weight infrastructure is invisible to batch consumers.
//
// Stratum-level evaluation and the public `evaluate()`/`evaluatePositive()`
// entry points live in `evaluator.ts` (the unified weighted evaluator).
// This module provides only the rule-level building blocks and
// `evaluateNaive()` (a test utility for correctness oracle comparisons).
//
// References:
// - `packages/perspective/theory/unified-engine.md` §B.3 (evaluator requirements)
// - Ullman, "Principles of Database and Knowledge-Base Systems" Vol 1, Ch 3
// - DBSP (Budiu & McSherry, 2023) §3.2 (Z-set joins)

import { evaluateAggregation } from "./aggregate.js"
import type { Host, HostFunction } from "./host.js"
import { hostFunctions, NO_FUNCTIONS } from "./host.js"
import type {
  AggregationClause,
  Atom,
  BodyElement,
  ComputeElement,
  Fact,
  GuardElement,
  ReadonlyDatabase,
  Rule,
  Substitution,
  Term,
  Value,
} from "./types.js"
import { Database, serializeTuple, valuesEqual } from "./types.js"
import {
  EMPTY_SUBSTITUTION,
  evaluateGuard,
  extendSubstitution,
  groundAtom,
  knownPositions,
  matchAtomWithTuple,
  probeFor,
  resolveGuardTerm,
} from "./unify.js"

// ---------------------------------------------------------------------------
// Weighted Fact type
// ---------------------------------------------------------------------------

/**
 * A fact with an associated Z-set weight.
 *
 * In batch evaluation, all weights are 1. In incremental evaluation,
 * weights encode provenance multiplicity: +1 for derived, −1 for
 * retracted, and sums for multiple derivation paths.
 */
export interface WeightedFact {
  readonly fact: Fact
  readonly weight: number
  /**
   * `serializeTuple(fact.values)`, computed once here and carried so the
   * evaluator never re-serializes a fact it already holds. This is the
   * *tuple* key (identity within one relation), not the fact key.
   */
  readonly tupleKey: string
}

// ---------------------------------------------------------------------------
// Test utility
// ---------------------------------------------------------------------------

/**
 * Evaluate rules naively (recompute everything each iteration until fixed point).
 *
 * This is less efficient than semi-naive but useful for correctness testing:
 * both approaches must produce the same result.
 *
 * @param rules  Positive Datalog rules.
 * @param facts  Ground facts.
 * @returns      The complete database.
 */
export function evaluateNaive(
  rules: readonly Rule[],
  facts: readonly Fact[],
  host?: Host,
): Database {
  const functions = hostFunctions(host)
  const db = new Database()
  for (const f of facts) {
    db.addFact(f)
  }

  if (rules.length === 0) {
    return db
  }

  // Iterate until fixed point
  let changed = true
  while (changed) {
    changed = false
    for (const rule of rules) {
      const derived = evaluateRule(rule, db, db, functions)
      for (const wf of derived) {
        if (wf.weight > 0 && db.addFact(wf.fact)) {
          changed = true
        }
      }
    }
  }

  return db
}

// ---------------------------------------------------------------------------
// The rule evaluation plan
//
// Evaluating a rule body used to interleave four *decisions* with the actual
// work: which database each element reads from, which element is driven by the
// delta, which of an atom's positions are already known, and what order to
// visit the elements in. None of those decisions needs to look at a single
// tuple — they follow from the rule's shape and, for ordering, from relation
// sizes.
//
// So they are lifted out into a plan. GATHER (relation sizes) → PLAN
// (`EvalStep[]`) → EXECUTE (a fold over the steps). The executor below makes
// no decisions; it dispatches. The planner is a pure function you can test
// without constructing a `Database` at all, which matters most for the one
// decision that is a genuine judgement call: join order.
// ---------------------------------------------------------------------------

/**
 * Which database a body element draws its tuples from.
 *
 * - `"delta"` — only the facts that changed. The element being driven.
 * - `"new"` — the post-update database (P_new).
 * - `"old"` — the pre-update database (P_old = P_new − Δ).
 *
 * The old/new split is the DBSP asymmetric join. See `planRuleEvaluation`.
 */
export type StepSource = "delta" | "new" | "old"

/** One body element, with every decision about it already made. */
export interface EvalStep {
  readonly element: BodyElement
  readonly source: StepSource
  /** True for the element the delta drives (at most one per plan). */
  readonly isDeltaSource: boolean
  /**
   * Bitmask of this element's atom positions whose values are already known
   * when the step runs — constants, plus variables bound by earlier steps.
   * Feeds the join index; `0` means "nothing known", i.e. a full scan.
   *
   * Filled in for negations as well as positive atoms: a negated atom's lookup
   * is the same indexed probe, and leaving it to be re-derived at execution
   * time from `subs[0]` put one of the executor's decisions back in the
   * executor. Elements with no atom (guards, computes) carry `0`.
   */
  readonly mask: number
}

/** Shared empty set — the non-delta path has no changed predicates. */
const EMPTY_PREDICATES: ReadonlySet<string> = new Set<string>()

/**
 * Decide how to evaluate one rule body: source database, delta source, known
 * positions, and order.
 *
 * **Ordering — smallest first.** An atom with no known position has to
 * enumerate its whole relation; one with a known position is an indexed
 * lookup. So the planner repeatedly takes whichever element is cheapest
 * *right now*, because each choice binds variables that make the remaining
 * elements cheaper. Given
 * `exploded(X, Y) :- lit(X, Y), spores(X, Y)` and a tick that inserts one
 * `spores` fact, source order would scan all 3,000 `lit` tuples to find the
 * one that matters; smallest-first starts from the single-fact delta and turns
 * `lit` into a lookup.
 *
 * Neither fixed order wins on its own: driving the delta first is right for a
 * small tick but wrong during a batch seed, where the "delta" is the entire
 * ground fact set and hoisting it puts the largest relation first. The greedy
 * rule gets both, and subsumes either fixed order as a special case.
 *
 * Without `sizes` the plan keeps source order — cost estimates are the only
 * thing ordering needs, so a caller that has none still gets a valid plan.
 *
 * **Why reordering is safe.** A rule body is a conjunction, so the set of
 * derived facts does not depend on the order its elements are evaluated in.
 * Weights multiply, and multiplication commutes. Moving an element earlier
 * only *adds* bindings earlier, so negation and guard safety can only improve.
 * What does change is the order in which facts are derived, and therefore the
 * insertion order of the relations they land in — set-level results are
 * identical, array-level orderings may differ.
 *
 * The exception is aggregation, which is a group-by boundary that resets
 * provenance weight to 1. It does not commute with joins, so a body
 * containing one keeps source order entirely.
 *
 * **The asymmetric join** (`step.source`). For a self-join `P ⋈ P`, the
 * correct incremental update is `ΔP ⋈ P_new + P_old ⋈ ΔP` — using `P_new` on
 * both sides would count every pair where both elements are in ΔP twice. So
 * elements *before* the delta source on the same predicate read `P_new`, and
 * those *after* read `P_old`. Note this is keyed on the element's **original
 * body index**, not its position in the plan: the asymmetry is about which
 * tuples participate, not about what runs first. Conflating the two would
 * quietly reintroduce the double-counting.
 *
 * **Precondition on masks.** A mask computed here is static, so it is correct
 * only if every substitution arriving at a step has the same set of bound
 * variables. That holds because binding is structural: a positive atom binds
 * all of its variables or the substitution is discarded, a guard binds nothing,
 * a negation binds nothing unless the delta drives it — in which case it binds
 * all of its variables, on the same all-or-discard terms as a positive atom —
 * aggregation binds its `groupBy` variables plus `result`, and a
 * compute element binds its result variable for every row or drops the row.
 * Nothing in the evaluator can produce two substitutions at the same step with
 * different domains. This was always true and never written down; the planner
 * is where it now has to hold explicitly.
 *
 * @param deltaIdx  Index of the delta-driven body element, or `-1` for the
 *                  non-delta path (`evaluateRule`), where nothing is driven by
 *                  a delta and every element reads the current database.
 */
export function planRuleEvaluation(
  rule: Rule,
  deltaIdx: number,
  deltaPreds: ReadonlySet<string>,
  sizes?: PlanSizes,
): readonly EvalStep[] {
  const order = planOrder(rule, deltaIdx, sizes)

  const steps: EvalStep[] = []
  const bound = new Set<string>()

  for (const { element, index: i } of order) {
    steps.push({
      element,
      source: sourceFor(element, i, deltaIdx, deltaPreds),
      isDeltaSource: i === deltaIdx,
      mask:
        element.kind === "atom" || element.kind === "negation"
          ? knownPositions(element.atom, bound)
          : 0,
    })

    bindVariables(element, bound, i === deltaIdx)
  }

  return steps
}

/**
 * Relation sizes for cost estimation.
 *
 * Deliberately the *post-delta* database and the delta, never a
 * `DatabaseView`: asking a view for a relation forces it to materialise
 * `base − delta`, and the planner might not even choose to read that
 * predicate. Planning must not do work the plan then discards.
 */
export interface PlanSizes {
  readonly current: ReadonlyDatabase
  readonly delta: ReadonlyDatabase
}

/** Cost of an element that is a pure filter — run these as early as possible. */
const COST_FILTER = 0
/** Cost of an atom with a known position: an indexed lookup, not a scan. */
const COST_LOOKUP = 1

/** A body element and its position in the rule as written. */
interface Positioned {
  readonly element: BodyElement
  readonly index: number
}

/** Body elements, in the order they should be evaluated. */
function planOrder(
  rule: Rule,
  deltaIdx: number,
  sizes: PlanSizes | undefined,
): readonly Positioned[] {
  const elements = rule.body.map((element, index) => ({ element, index }))

  // No estimates, or an aggregation in the body (which cannot move): the
  // order is the order it was written in.
  if (sizes === undefined) return elements
  if (rule.body.some(b => b.kind === "aggregation")) return elements

  const order: Positioned[] = []
  const pending = [...elements]
  const bound = new Set<string>()

  while (pending.length > 0) {
    let best: Positioned | undefined
    let bestCost = Number.POSITIVE_INFINITY

    for (const candidate of pending) {
      const cost = estimateCost(
        candidate.element,
        candidate.index === deltaIdx,
        bound,
        sizes,
      )
      if (cost < bestCost) {
        bestCost = cost
        best = candidate
      }
    }

    // Nothing left is safely evaluable — a negation or guard whose variables
    // nothing binds. Fall back to source order for the remainder and let
    // evaluation handle it exactly as it did before.
    if (best === undefined) {
      order.push(...pending)
      return order
    }

    pending.splice(pending.indexOf(best), 1)
    order.push(best)
    bindVariables(best.element, bound, best.index === deltaIdx)
  }

  return order
}

/** How many tuples this element would have to visit if evaluated next. */
function estimateCost(
  element: BodyElement,
  isDeltaSource: boolean,
  bound: ReadonlySet<string>,
  sizes: PlanSizes,
): number {
  const db = isDeltaSource ? sizes.delta : sizes.current

  switch (element.kind) {
    case "atom":
      return knownPositions(element.atom, bound) !== 0
        ? COST_LOOKUP
        : // `allEntryCount` is the O(1) Map size; `size` counts present tuples
          // by iterating, which would make planning cost more than it saves.
          db.getRelation(element.atom.predicate).allEntryCount

    case "negation":
      // A delta-driven negation must read the delta and can bind through it,
      // so it is priced like an atom. An ordinary negation is a filter, and is
      // only evaluable once its variables are bound.
      if (isDeltaSource) {
        return knownPositions(element.atom, bound) !== 0
          ? COST_LOOKUP
          : db.getRelation(element.atom.predicate).allEntryCount
      }
      return allBound(element.atom.terms, bound)
        ? COST_FILTER
        : Number.POSITIVE_INFINITY

    case "guard":
      return guardBound(element, bound) ? COST_FILTER : Number.POSITIVE_INFINITY

    case "compute":
      // A guard that binds: a filter once its arguments are known.
      return allBound(element.args, bound)
        ? COST_FILTER
        : Number.POSITIVE_INFINITY

    case "aggregation":
      // Unreachable — a body with an aggregation keeps source order.
      return Number.POSITIVE_INFINITY
  }
}

function allBound(terms: readonly Term[], bound: ReadonlySet<string>): boolean {
  return terms.every(t => t.kind !== "var" || bound.has(t.name))
}

function guardBound(guard: GuardElement, bound: ReadonlySet<string>): boolean {
  return allBound([guard.left, guard.right], bound)
}

/** Which database this element reads, per the asymmetric-join rule. */
function sourceFor(
  element: BodyElement,
  index: number,
  deltaIdx: number,
  deltaPreds: ReadonlySet<string>,
): StepSource {
  if (index === deltaIdx) return "delta"

  // The non-delta path (deltaIdx = -1) has no old/new split to make: there is
  // no delta, so P_old and P_new are the same database.
  if (deltaIdx < 0) return "new"

  // Guards and compute elements read no relation, and aggregation keeps
  // source order anyway.
  if (element.kind !== "atom" && element.kind !== "negation") return "new"

  return index < deltaIdx && deltaPreds.has(element.atom.predicate)
    ? "new"
    : "old"
}

/**
 * Record the variables this element binds for subsequent steps.
 *
 * `isDeltaSource` is what separates the two negations. An ordinary negation is
 * a boolean filter and binds nothing (`evaluateNegation`). A negation the delta
 * drives runs through `evaluateDifferentialNegation`, which matches the negated
 * atom against each delta tuple and carries the resulting bindings forward —
 * exactly like a positive atom. Pricing already says so (`estimateCost`); this
 * is where the plan has to agree, or every element after it plans as though
 * nothing were bound and falls back to a scan.
 */
function bindVariables(
  element: BodyElement,
  bound: Set<string>,
  isDeltaSource: boolean,
): void {
  switch (element.kind) {
    case "atom":
      for (const term of element.atom.terms) {
        if (term.kind === "var") bound.add(term.name)
      }
      break
    case "aggregation":
      for (const v of element.agg.groupBy) bound.add(v)
      bound.add(element.agg.result)
      break
    case "compute":
      if (element.result.kind === "var") bound.add(element.result.name)
      break
    // A delta-driven negation binds through the delta tuples it matched;
    // an ordinary one is a pure filter.
    case "negation":
      if (isDeltaSource) {
        for (const term of element.atom.terms) {
          if (term.kind === "var") bound.add(term.name)
        }
      }
      break

    // Guards filter; they never bind.
    case "guard":
      break
  }
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a single rule against the database, producing weighted derived facts.
 *
 * Substitutions carry weights through body element evaluation. The head
 * is grounded with each surviving substitution, producing weighted facts.
 * Duplicate facts (same predicate + values) have their weights summed.
 *
 * This is the non-delta path — everything reads the current database. It backs
 * `evaluateNaive` (the correctness oracle), rules with no atoms in the body,
 * and aggregation strata, which still wipe and recompute. It plans with
 * `deltaIdx = -1` so those paths get indexed lookups too; skipping it would
 * leave the slowest remaining path on a full scan.
 *
 * @param rule       The rule to evaluate.
 * @param fullDb     The full database (for general matching and negation).
 * @param matchDb    The database to match positive atoms against
 *                   (could be delta for semi-naive).
 * @param functions  The host's point functions, for compute elements.
 * @returns          Weighted derived facts from this rule.
 */
export function evaluateRule(
  rule: Rule,
  fullDb: ReadonlyDatabase,
  matchDb: ReadonlyDatabase,
  functions: ReadonlyMap<string, HostFunction> = NO_FUNCTIONS,
): WeightedFact[] {
  const plan = planRuleEvaluation(rule, -1, EMPTY_PREDICATES, {
    current: matchDb,
    delta: matchDb,
  })

  // Start with a single empty substitution (weight 1)
  let subs: Substitution[] = [EMPTY_SUBSTITUTION]

  for (const step of plan) {
    if (subs.length === 0) break

    const element = step.element
    switch (element.kind) {
      case "atom":
        subs = evaluatePositiveAtom(
          element.atom,
          matchDb,
          subs,
          false,
          step.mask,
        )
        break
      case "negation":
        subs = evaluateNegation(element.atom, fullDb, subs, step.mask)
        break
      case "aggregation":
        subs = evaluateAggregationElement(element.agg, fullDb, subs)
        break
      case "guard":
        subs = evaluateGuardElement(element, subs)
        break
      case "compute":
        subs = evaluateComputeElement(element, functions, subs)
        break
    }
  }

  // Ground the head atom with each surviving substitution
  return groundHead(rule.head, subs)
}

/**
 * Evaluate a single rule in delta-driven mode with asymmetric join support.
 *
 * One specific body element (at `deltaIdx`) matches against the `delta`
 * database, while other body elements match against `fullDbOld` or
 * `fullDbNew` depending on their position relative to `deltaIdx`. The
 * body element at `deltaIdx` knows its own kind (`atom` vs `negation`),
 * so no separate `deltaKind` parameter is needed.
 *
 * **Asymmetric join (DBSP incremental join):**
 * For a binary join `A ⋈ B` where A = B = P (self-join), the correct
 * incremental update is `ΔA ⋈ B_new + A_old ⋈ ΔB`. Standard semi-naive
 * uses `A_new` for both, double-counting pairs where both elements are
 * in ΔP. The asymmetry ensures each (a, b) pair is counted exactly once.
 *
 * For non-delta positive atoms:
 * - Positions `j < deltaIdx` on the same predicate as the delta: use
 *   `fullDbNew` (post-update state, = P_new).
 * - Positions `j > deltaIdx`, or on different predicates: use `fullDbOld`
 *   (pre-update state, = P_old).
 *
 * For the delta element itself:
 * - `case 'atom'`: evaluate against `delta` with `allEntries: true`
 *   (sees negative-weight entries for retraction propagation).
 * - `case 'negation'`: evaluate via `evaluateDifferentialNegation`
 *   against `delta` (sign inversion for negation semantics).
 *
 * Non-delta negations evaluate against `fullDbNew` (the current state
 * of the negated relation matters for boolean negation-as-failure).
 *
 * @param rule       The rule to evaluate.
 * @param fullDbOld  Pre-update database (P_old). For predicates not in
 *                   the delta, this is identical to fullDbNew.
 * @param fullDbNew  Post-update database (P_new = P_old + delta).
 * @param delta      The delta database (changed entries only).
 * @param deltaIdx   Index of the body element driven by the delta.
 * @param functions  The host's point functions, for compute elements.
 * @returns          Weighted derived facts with duplicate-summing.
 *
 * See Plan 006.2, Phase 1, Task 1.2.
 * See DBSP (Budiu & McSherry, 2023) §3.2.
 */
export function evaluateRuleDelta(
  rule: Rule,
  fullDbOld: ReadonlyDatabase,
  fullDbNew: ReadonlyDatabase,
  delta: ReadonlyDatabase,
  deltaIdx: number,
  functions: ReadonlyMap<string, HostFunction> = NO_FUNCTIONS,
): WeightedFact[] {
  // Collect predicates present in the delta for asymmetric join dispatch.
  const deltaPreds = new Set<string>(delta.predicates())
  const plan = planRuleEvaluation(rule, deltaIdx, deltaPreds, {
    current: fullDbNew,
    delta,
  })

  const dbFor = (source: StepSource): ReadonlyDatabase =>
    source === "delta" ? delta : source === "new" ? fullDbNew : fullDbOld

  let subs: Substitution[] = [EMPTY_SUBSTITUTION]

  for (const step of plan) {
    if (subs.length === 0) break

    const element = step.element
    switch (element.kind) {
      case "atom": {
        // The delta source reads with allEntries = true so it sees
        // negative-weight entries — that is how retractions propagate.
        subs = evaluatePositiveAtom(
          element.atom,
          dbFor(step.source),
          subs,
          step.isDeltaSource,
          step.mask,
        )
        break
      }
      case "negation": {
        if (step.isDeltaSource) {
          // Differential negation: process the delta entries with
          // sign inversion (appearance blocks, disappearance unblocks).
          subs = evaluateDifferentialNegation(
            element.atom,
            delta,
            subs,
            step.mask,
          )
        } else {
          // Non-delta negation: boolean negation-as-failure against
          // the current (post-update) state.
          subs = evaluateNegation(
            element.atom,
            dbFor(step.source),
            subs,
            step.mask,
          )
        }
        break
      }
      case "aggregation":
        subs = evaluateAggregationElement(element.agg, dbFor(step.source), subs)
        break
      case "guard":
        subs = evaluateGuardElement(element, subs)
        break
      case "compute":
        subs = evaluateComputeElement(element, functions, subs)
        break
    }
  }

  return groundHead(rule.head, subs)
}

// ---------------------------------------------------------------------------
// Body element evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a positive atom: for each current substitution, match the atom
 * against all tuples in the database and collect extended substitutions.
 *
 * Weight multiplication (provenance semiring product): the extended
 * substitution's weight is `sub.weight × tuple.weight`. This is the
 * core of Z-set join semantics. In batch evaluation where all weights
 * are 1, this is a no-op multiplication.
 *
 * We iterate tuples directly so that we have access to each tuple for
 * weight lookup. This avoids re-grounding the atom — which would fail
 * for atoms containing wildcards.
 *
 * @param a          The atom to match.
 * @param db         The database to match against.
 * @param subs       Current substitutions to extend.
 * @param allEntries When `true`, uses `allWeightedTuples()` which includes
 *                   negative-weight entries (for delta databases). When
 *                   `false` (default), uses `weightedTuples()` which returns
 *                   only clampedWeight > 0 entries with weight = 1
 *                   (preventing weight explosion in recursive joins).
 *                   See Plan 006.2, Phase 1, Task 1.4.
 * @param mask       Bitmask of atom positions whose values are already known,
 *                   from `planRuleEvaluation`. Turns the scan into an indexed
 *                   lookup. Optional, and `0` — the default — is the correct
 *                   degenerate answer: scan everything. A caller without a plan
 *                   therefore still gets right answers, just unindexed.
 */
export function evaluatePositiveAtom(
  a: Atom,
  db: ReadonlyDatabase,
  subs: readonly Substitution[],
  allEntries: boolean = false,
  mask: number = 0,
): Substitution[] {
  const relation = db.getRelation(a.predicate)

  // With no known positions there is nothing to key on, so hoist the one scan
  // out of the substitution loop as before.
  const scanned =
    mask === 0
      ? allEntries
        ? relation.allWeightedTuples()
        : relation.weightedTuples()
      : null

  const results: Substitution[] = []
  for (const sub of subs) {
    // Ask the relation only for tuples that agree with what this substitution
    // already knows — ~4 adjacency tuples instead of ~12k. Candidates are a
    // superset, so `matchAtomWithTuple` below still decides every match.
    const entries =
      scanned ?? relation.candidates(probeFor(a, mask, sub), allEntries)

    for (const { tuple, weight: tupleWeight } of entries) {
      const extended = matchAtomWithTuple(a, tuple, sub)
      if (extended === null) continue

      if (tupleWeight === 1) {
        // Common case (batch evaluation) — no multiplication needed.
        results.push(extended)
      } else {
        // Weight multiplication: sub.weight × tuple.weight (provenance product).
        results.push({
          bindings: extended.bindings,
          weight: extended.weight * tupleWeight,
        })
      }
    }
  }
  return results
}

/**
 * Evaluate a negated atom: keep only substitutions for which the atom
 * has NO match in the database.
 *
 * Negation-as-failure with safety: all variables in the negated atom
 * that are not grouping variables must already be bound in the substitution.
 * We check each substitution against the full database — if ANY tuple
 * matches (weight > 0, which is what tuples() returns), the substitution
 * is removed. Weight is preserved on pass.
 */
export function evaluateNegation(
  a: Atom,
  db: ReadonlyDatabase,
  subs: readonly Substitution[],
  mask: number = 0,
): Substitution[] {
  const relation = db.getRelation(a.predicate)

  const results: Substitution[] = []
  for (const sub of subs) {
    const entries =
      mask === 0
        ? relation.weightedTuples()
        : relation.candidates(probeFor(a, mask, sub), false)

    // Only existence matters here, so stop at the first match rather than
    // collecting them all.
    let matched = false
    for (const { tuple } of entries) {
      if (matchAtomWithTuple(a, tuple, sub) !== null) {
        matched = true
        break
      }
    }

    if (!matched) {
      // No match — negation holds, keep this substitution (weight preserved)
      results.push(sub)
    }
  }
  return results
}

/**
 * Evaluate differential negation: process delta entries for a negated atom
 * with sign inversion.
 *
 * Unlike `evaluateNegation` (boolean filter — pass or block), this function
 * produces weighted substitutions from changes in the negated relation:
 *
 * - Delta weight +1 (fact appeared in negated relation): this binding is
 *   now blocked → emit substitution with `weight = sub.weight × (-1)`.
 * - Delta weight −1 (fact disappeared from negated relation): this binding
 *   is now unblocked → emit substitution with `weight = sub.weight × (+1)`.
 *
 * The general formula is: `output_weight = sub.weight × (-deltaWeight)`.
 *
 * The sign inversion encodes negation-as-failure semantics: appearance of
 * a negated fact *removes* derivations; disappearance *adds* derivations.
 *
 * Uses `allWeightedTuples()` to see both positive and negative delta entries.
 *
 * @param a      The negated atom to match against the delta.
 * @param delta  The delta database (entries with +1 or −1 weights).
 * @param subs   Current substitutions to extend.
 * @returns      Extended substitutions with sign-inverted weights.
 *
 * See Plan 006.2, Phase 1, Task 1.1.
 */
export function evaluateDifferentialNegation(
  a: Atom,
  delta: ReadonlyDatabase,
  subs: readonly Substitution[],
  mask: number = 0,
): Substitution[] {
  const relation = delta.getRelation(a.predicate)
  if (relation.allEntryCount === 0) return []

  const scanned = mask === 0 ? relation.allWeightedTuples() : null

  const results: Substitution[] = []
  for (const sub of subs) {
    // allEntries: delta relations carry the negative weights that encode
    // disappearance, and those are exactly what unblocks a derivation here.
    const entries = scanned ?? relation.candidates(probeFor(a, mask, sub), true)

    for (const { tuple, weight: deltaWeight } of entries) {
      const extended = matchAtomWithTuple(a, tuple, sub)
      if (extended === null) continue

      // Sign inversion: appearance (+1) blocks (→ -1), disappearance (-1) unblocks (→ +1).
      const outputWeight = extended.weight * -deltaWeight
      if (outputWeight !== 0) {
        results.push({ bindings: extended.bindings, weight: outputWeight })
      }
    }
  }
  return results
}

/**
 * Evaluate a guard body element: keep only substitutions for which the
 * guard condition holds. Weight is preserved on pass.
 */
export function evaluateGuardElement(
  guard: GuardElement,
  subs: readonly Substitution[],
): Substitution[] {
  const results: Substitution[] = []
  for (const sub of subs) {
    const result = evaluateGuard(guard, sub)
    if (result !== null) {
      results.push(result)
    }
  }
  return results
}

/**
 * Evaluate a compute body element: apply the named host function to each
 * substitution's resolved arguments and unify the value with `result`.
 *
 * Linear per row, weight preserved, never a delta source: it is a guard
 * that binds, and takes part in the incremental decomposition without any
 * new theory. An argument that resolves to nothing drops the row, as an
 * unresolvable guard does; so does a function returning `undefined`.
 *
 * A missing function throws. `hostErrors` runs before any evaluation, so
 * reaching this means validation was bypassed, and a wrong answer must not
 * be the outcome.
 */
export function evaluateComputeElement(
  element: ComputeElement,
  functions: ReadonlyMap<string, HostFunction>,
  subs: readonly Substitution[],
): Substitution[] {
  const fn = functions.get(element.fn)
  if (fn === undefined) {
    throw new Error(
      `host function "${element.fn}" is not registered; hostErrors would have reported it`,
    )
  }

  const results: Substitution[] = []
  // One array, reused for every row — allocating per row was measurable here.
  //
  // Two consequences worth knowing. It is why a declared function arity needs
  // no run-time check: the width comes from the rule, so every call is made at
  // exactly `element.args.length`. And it means a host function must not
  // *retain* what it is handed — the contents change under it on the next row.
  // Reading the values is fine; keeping the array is not.
  const args: Value[] = new Array(element.args.length)
  rows: for (const sub of subs) {
    let i = 0
    for (const term of element.args) {
      const value = resolveGuardTerm(term, sub)
      if (value === undefined) continue rows
      args[i++] = value
    }
    const value = fn.apply(args)
    if (value === undefined) continue

    const result = element.result
    if (result.kind === "wildcard") {
      results.push(sub)
    } else if (result.kind === "const") {
      if (valuesEqual(result.value, value)) results.push(sub)
    } else {
      const existing = resolveGuardTerm(result, sub)
      if (existing === undefined) {
        results.push(extendSubstitution(sub, result.name, value))
      } else if (valuesEqual(existing, value)) {
        results.push(sub)
      }
    }
  }
  return results
}

/**
 * Evaluate an aggregation body element.
 * Aggregation output substitutions have weight = 1 (group-by boundary
 * that resets provenance).
 */
export function evaluateAggregationElement(
  agg: AggregationClause,
  db: ReadonlyDatabase,
  subs: readonly Substitution[],
): Substitution[] {
  const results: Substitution[] = []
  for (const sub of subs) {
    const extended = evaluateAggregation(agg, db, sub)
    for (const s of extended) {
      results.push(s)
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Head grounding
// ---------------------------------------------------------------------------

/**
 * Ground the head atom with each substitution, producing weighted facts.
 * Substitutions that leave variables unbound are silently dropped.
 *
 * Duplicate facts (same predicate + values) have their weights summed
 * (Z-set addition). In batch evaluation where all weights are 1, the
 * deduplication behavior is preserved (first occurrence wins, weight
 * stays 1 since duplicates sum to the same value).
 */
export function groundHead(
  head: Atom,
  subs: readonly Substitution[],
): WeightedFact[] {
  // Keyed by tuple key: every fact here shares the head's predicate.
  const weightMap = new Map<string, { fact: Fact; weight: number }>()

  for (const sub of subs) {
    const tuple = groundAtom(head, sub)
    if (tuple === null) continue

    const key = serializeTuple(tuple)
    const existing = weightMap.get(key)
    if (existing !== undefined) {
      existing.weight += sub.weight
    } else {
      weightMap.set(key, {
        fact: { predicate: head.predicate, values: tuple },
        weight: sub.weight,
      })
    }
  }

  const results: WeightedFact[] = []
  for (const [tupleKey, entry] of weightMap) {
    if (entry.weight !== 0) {
      results.push({ fact: entry.fact, weight: entry.weight, tupleKey })
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
