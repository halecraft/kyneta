// === @kyneta/datalog — public API ===
//
// What this barrel exports is a compatibility promise. It is deliberately
// smaller than the module surface: the rule *language*, the *engine* that runs
// it, the *host* registry, and the value/fact primitives a caller needs to feed
// it. The evaluator's internals — per-rule evaluation, unification,
// substitution plumbing, the dependency graph — are reachable by relative
// import inside this package, and by nothing outside it.

// --- The engine ---
export type { Evaluator } from "./evaluator.js"
export {
  createEvaluator,
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
// --- Result ---
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
  ReadonlyDatabase,
  Rule,
  StratificationError,
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
