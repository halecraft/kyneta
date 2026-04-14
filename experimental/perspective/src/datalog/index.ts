// === Datalog Module Public API ===
// Re-exports the public surface of the Datalog evaluator.

// --- Aggregation ---
export {
  evaluateAggregation,
  evaluateAggregationForSubs,
} from "./aggregate.js"
// --- Evaluation Core (rule-level functions) ---
export type { WeightedFact } from "./evaluate.js"
export {
  evaluateAggregationElement,
  evaluateDifferentialNegation,
  evaluateGuardElement,
  evaluateNaive,
  evaluateNegation,
  evaluatePositiveAtom,
  evaluateRule,
  evaluateRuleDelta,
  evaluateRuleSemiNaive,
  getNegationAtomIndices,
  getPositiveAtomIndices,
  groundHead,
} from "./evaluate.js"
// --- Unified Evaluator (Plan 006.1) ---
export type { Evaluator, EvaluatorStepResult } from "./evaluator.js"
export {
  createEvaluator,
  evaluatePositiveUnified as evaluatePositive,
  evaluateStratumFromDelta,
  evaluateUnified as evaluate,
} from "./evaluator.js"
// --- Stratification ---
export type {
  DependencyEdge,
  DependencyGraph,
  Stratum,
} from "./stratify.js"
export {
  bodyPredicates,
  buildDependencyGraph,
  computeSCCs,
  headPredicates,
  stratify,
} from "./stratify.js"
// --- Types ---
export type {
  AggregationClause,
  AggregationElement,
  AggregationFn,
  Atom,
  AtomElement,
  BodyElement,
  CnId,
  ConstTerm,
  CyclicNegationError,
  Fact,
  FactTuple,
  GuardElement,
  GuardOp,
  NegationElement,
  ReadonlyDatabase,
  Result,
  Rule,
  StratificationError,
  Substitution,
  Term,
  Value,
  VarTerm,
  WildcardTerm,
} from "./types.js"
// --- Type constructors & utilities ---
export {
  _,
  aggregation,
  atom,
  compareValues,
  constTerm,
  Database,
  eq,
  err,
  evaluateGuardOp,
  fact,
  factKey,
  gt,
  gte,
  lt,
  lte,
  negation,
  neq,
  ok,
  positiveAtom,
  Relation,
  rule,
  serializeValue,
  valuesEqual,
  varTerm,
  wildcard,
} from "./types.js"
// --- Unification ---
export {
  EMPTY_SUBSTITUTION,
  evaluateGuard,
  extendSubstitution,
  groundAtom,
  matchAtomAgainstRelation,
  matchAtomWithTuple,
  resolveTerm,
  unifyTermWithValue,
} from "./unify.js"
