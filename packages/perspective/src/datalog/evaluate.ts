// === Datalog Evaluation Core ===
// Per-rule evaluation functions used by both the unified evaluator
// (evaluator.ts) and the naive test utility below.
//
// Weight semantics (Plan 006.1, extended by Plan 006.2):
// - Substitutions carry weights through evaluation.
// - Positive atom join: weight = sub.weight × tuple.weight (provenance product).
// - Negation/guard: weight preserved on pass, substitution dropped on fail.
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
// - unified-engine.md §B.3 (evaluator requirements)
// - Ullman, "Principles of Database and Knowledge-Base Systems" Vol 1, Ch 3
// - DBSP (Budiu & McSherry, 2023) §3.2 (Z-set joins)

import { evaluateAggregation } from "./aggregate.js"
import type {
  AggregationClause,
  Atom,
  BodyElement,
  Fact,
  GuardElement,
  ReadonlyDatabase,
  Rule,
  Substitution,
  Term,
} from "./types.js"
import { Database, factKey } from "./types.js"
import {
  EMPTY_SUBSTITUTION,
  evaluateGuard,
  groundAtom,
  knownPositions,
  matchAtomWithTuple,
  probeFor,
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
): Database {
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
      const derived = evaluateRule(rule, db, db)
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
   * Bitmask of this atom's positions whose values are already known when the
   * step runs — constants, plus variables bound by earlier steps. Feeds the
   * join index; `0` means "nothing known", i.e. a full scan.
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
 * all of its variables or the substitution is discarded, negation and guards
 * bind nothing, and aggregation binds its `groupBy` variables plus `result`.
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

  for (const i of order) {
    const element = rule.body[i]!

    steps.push({
      element,
      source: sourceFor(element, i, deltaIdx, deltaPreds),
      isDeltaSource: i === deltaIdx,
      mask: element.kind === "atom" ? knownPositions(element.atom, bound) : 0,
    })

    bindVariables(element, bound)
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

/** Body element indices, in the order they should be evaluated. */
function planOrder(
  rule: Rule,
  deltaIdx: number,
  sizes: PlanSizes | undefined,
): readonly number[] {
  const n = rule.body.length
  const sourceOrder = (): number[] => Array.from({ length: n }, (_v, i) => i)

  // No estimates, or an aggregation in the body (which cannot move): the
  // order is the order it was written in.
  if (sizes === undefined) return sourceOrder()
  if (rule.body.some(b => b.kind === "aggregation")) return sourceOrder()

  const order: number[] = []
  const planned = new Array<boolean>(n).fill(false)
  const bound = new Set<string>()

  for (let step = 0; step < n; step++) {
    let best = -1
    let bestCost = Number.POSITIVE_INFINITY

    for (let i = 0; i < n; i++) {
      if (planned[i]) continue
      const cost = estimateCost(rule.body[i]!, i === deltaIdx, bound, sizes)
      if (cost < bestCost) {
        bestCost = cost
        best = i
      }
    }

    // Nothing left is safely evaluable — a negation or guard whose variables
    // nothing binds. Fall back to source order for the remainder and let
    // evaluation handle it exactly as it did before.
    if (best === -1 || bestCost === Number.POSITIVE_INFINITY) {
      for (let i = 0; i < n; i++) if (!planned[i]) order.push(i)
      return order
    }

    planned[best] = true
    order.push(best)
    bindVariables(rule.body[best]!, bound)
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

  // Negations always read the current state: negation-as-failure asks whether
  // the fact is absent *now*, not whether it was absent before the delta.
  if (element.kind !== "atom") return "new"

  return index < deltaIdx && deltaPreds.has(element.atom.predicate)
    ? "new"
    : "old"
}

/** Record the variables this element binds for subsequent steps. */
function bindVariables(element: BodyElement, bound: Set<string>): void {
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
    // Negation and guards filter; they never bind.
    case "negation":
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
 * @param rule     The rule to evaluate.
 * @param fullDb   The full database (for general matching and negation).
 * @param matchDb  The database to match positive atoms against
 *                 (could be delta for semi-naive).
 * @returns        Weighted derived facts from this rule.
 */
export function evaluateRule(
  rule: Rule,
  fullDb: ReadonlyDatabase,
  matchDb: ReadonlyDatabase,
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
        subs = evaluateNegation(element.atom, fullDb, subs)
        break
      case "aggregation":
        subs = evaluateAggregationElement(element.agg, fullDb, subs)
        break
      case "guard":
        subs = evaluateGuardElement(element, subs)
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
          subs = evaluateDifferentialNegation(element.atom, delta, subs)
        } else {
          // Non-delta negation: boolean negation-as-failure against
          // the current (post-update) state.
          subs = evaluateNegation(element.atom, dbFor(step.source), subs)
        }
        break
      }
      case "aggregation":
        subs = evaluateAggregationElement(element.agg, dbFor(step.source), subs)
        break
      case "guard":
        subs = evaluateGuardElement(element, subs)
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
): Substitution[] {
  const relation = db.getRelation(a.predicate)

  // Negation safety requires the negated atom's variables to be bound already,
  // so the probe is normally full-arity and the lookup is effectively a
  // membership test. Computed per substitution because only the values differ.
  const mask = maskFromSubs(a, subs)

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
 * Positions of `a` that are known under these substitutions.
 *
 * Negation and differential negation are reached without a plan step of their
 * own, so unlike positive atoms they work the mask out from the substitutions
 * they were handed. All substitutions arriving at one body element share a
 * binding domain (see `planRuleEvaluation`), so the first one is
 * representative; an empty list means there is nothing to probe for anyway.
 */
function maskFromSubs(a: Atom, subs: readonly Substitution[]): number {
  const first = subs[0]
  return first === undefined ? 0 : knownPositions(a, first.bindings)
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
): Substitution[] {
  const relation = delta.getRelation(a.predicate)
  if (relation.allEntryCount === 0) return []

  const mask = maskFromSubs(a, subs)
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
  const weightMap = new Map<string, { fact: Fact; weight: number }>()

  for (const sub of subs) {
    const tuple = groundAtom(head, sub)
    if (tuple === null) continue

    const fact: Fact = { predicate: head.predicate, values: tuple }
    const key = factKey(fact)

    const existing = weightMap.get(key)
    if (existing !== undefined) {
      existing.weight += sub.weight
    } else {
      weightMap.set(key, { fact, weight: sub.weight })
    }
  }

  const results: WeightedFact[] = []
  for (const entry of weightMap.values()) {
    if (entry.weight !== 0) {
      results.push({ fact: entry.fact, weight: entry.weight })
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get indices of positive atom body elements (for semi-naive evaluation).
 */
export function getPositiveAtomIndices(body: readonly BodyElement[]): number[] {
  const indices: number[] = []
  for (let i = 0; i < body.length; i++) {
    if (body[i]?.kind === "atom") {
      indices.push(i)
    }
  }
  return indices
}

/**
 * Get indices of negation body elements (for differential negation).
 *
 * Mirrors `getPositiveAtomIndices`. Used by the unified semi-naive loop
 * to enumerate negation atoms as potential delta sources.
 *
 * See Plan 006.2, Phase 1, Task 1.3.
 */
export function getNegationAtomIndices(body: readonly BodyElement[]): number[] {
  const indices: number[] = []
  for (let i = 0; i < body.length; i++) {
    if (body[i]?.kind === "negation") {
      indices.push(i)
    }
  }
  return indices
}
