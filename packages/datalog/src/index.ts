// === @kyneta/datalog — public API ===
//
// What this barrel exports is a compatibility promise. It is deliberately
// smaller than the module surface: the rule *language*, the *engine* that runs
// it, the *host* registry, and the value/fact primitives a caller needs to feed
// it, and the *substitution* — what a match is — because a consumer that
// binds variables itself needs to say so in the same vocabulary. The
// evaluator's internals — per-rule evaluation, the join planner and its
// probes, unification against stored tuples, the dependency graph — are
// reachable by relative import inside this package, and by nothing outside it.

// --- Arity ---
//
// `analyzeArity` is public for the same reason `bodyPredicates` is: it is a
// utility over the rule *language*, not an evaluator internal. A consumer that
// generates rule heads can run it over the rules it produced before installing
// them, and learn that it emitted a head at the wrong width — which is exactly
// the failure the engine would otherwise only reveal as a relation nothing
// matches. `matchedAtom` stays module-internal; it has no consumer out here.
export type { ArityAnalysis } from "./arity.js"
export { analyzeArity } from "./arity.js"
// --- Result ---
export { lookup, nth } from "./checked.js"
// --- The engine ---
export type { Evaluator } from "./evaluator.js"
export {
  createEvaluator,
  describeProgramError,
  evaluatePositiveUnified as evaluatePositive,
  evaluateUnified as evaluate,
  factsToZSet,
} from "./evaluator.js"
// --- Host relations and functions ---
export type {
  DeclarationError,
  ForeignDeclaration,
  ForeignRelation,
  Host,
  HostFunction,
} from "./host.js"
export { declarationErrors, hostErrors } from "./host.js"
export type { Result } from "./result.js"
export { err, ok } from "./result.js"
// --- Stratification ---
//
// `bodyPredicates` and `headPredicates` are public because they are utilities
// over the rule language, not evaluator internals: anything that inspects a
// rule set — a rule-shape detector, a stratification assertion — wants them,
// and would otherwise re-implement them.
export type { Stratum } from "./stratify.js"
export { bodyPredicates, headPredicates, stratify } from "./stratify.js"
// --- The rule language ---
// --- Values and facts ---
// --- Relations and databases ---
export type {
  AggregationClause,
  AggregationElement,
  AggregationFn,
  ArityError,
  Atom,
  AtomElement,
  BodyElement,
  ComputeElement,
  ConstTerm,
  CyclicNegationError,
  Fact,
  FactTuple,
  GuardElement,
  GuardOp,
  HostError,
  NegationElement,
  Probe,
  ProgramError,
  ReadonlyDatabase,
  Rule,
  Substitution,
  Term,
  Value,
  ValueRef,
  VarTerm,
  WeightedTuple,
  WildcardTerm,
} from "./types.js"
export {
  _,
  ALL_POSITIONS,
  aggregation,
  atom,
  compareValues,
  compute,
  constTerm,
  Database,
  eq,
  fact,
  factKey,
  gt,
  gte,
  lt,
  lte,
  negation,
  neq,
  positiveAtom,
  Relation,
  rule,
  serializeTuple,
  serializeValue,
  valuesEqual,
  varTerm,
  wildcard,
} from "./types.js"
// --- Substitutions ---
//
// A `Substitution` is a set of variable bindings plus a Z-set weight: what
// the evaluator carries while it works through a rule body, and what a
// consumer building bindings of its own has to produce to ground a head.
// Start from `EMPTY_SUBSTITUTION`, extend it, then `groundAtom` the head.
//
// Two traps, both of which the engine handles internally and a consumer must
// not rediscover the hard way:
//
//   - `resolveTerm` returns `undefined` for an unbound variable *and* for a
//     wildcard, while `null` is a perfectly good bound `Value`. Use
//     `sub.bindings.has(name)` to tell "bound to null" from "not bound".
//   - `groundAtom` returns `null` rather than throwing when the atom is not
//     fully ground — a wildcard in head position included, since a head must
//     be ground. Check it; do not assume a head always grounds.
//
// The `weight` carries Z-set provenance and multiplies through joins. A
// consumer assembling its own substitution should leave it at the 1 that
// `EMPTY_SUBSTITUTION` starts with and `extendSubstitution` preserves.
export {
  EMPTY_SUBSTITUTION,
  extendSubstitution,
  groundAtom,
  resolveTerm,
} from "./unify.js"
