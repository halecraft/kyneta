// === Datalog Module Public API ===
// Re-exports the public surface of the Datalog evaluator.

// --- Types ---
export type {
  Value,
  CnId,
  Term,
  ConstTerm,
  VarTerm,
  WildcardTerm,
  Atom,
  AggregationFn,
  AggregationClause,
  GuardOp,
  GuardElement,
  BodyElement,
  AtomElement,
  NegationElement,
  AggregationElement,
  Rule,
  FactTuple,
  Fact,
  Substitution,
  ReadonlyDatabase,
  Result,
  StratificationError,
  CyclicNegationError,
} from './types.js';

// --- Type constructors & utilities ---
export {
  ok,
  err,
  constTerm,
  varTerm,
  wildcard,
  _ ,
  atom,
  positiveAtom,
  negation,
  aggregation,
  eq,
  neq,
  lt,
  gt,
  lte,
  gte,
  rule,
  fact,
  Relation,
  Database,
  serializeValue,
  factKey,
  compareValues,
  valuesEqual,
  evaluateGuardOp,
} from './types.js';

// --- Unification ---
export {
  EMPTY_SUBSTITUTION,
  extendSubstitution,
  resolveTerm,
  unifyTermWithValue,
  matchAtomWithTuple,
  groundAtom,
  matchAtomAgainstRelation,
  evaluateGuard,
} from './unify.js';

// --- Stratification ---
export type {
  DependencyEdge,
  DependencyGraph,
  Stratum,
} from './stratify.js';

export {
  buildDependencyGraph,
  computeSCCs,
  stratify,
  bodyPredicates,
  headPredicates,
} from './stratify.js';

// --- Aggregation ---
export {
  evaluateAggregation,
  evaluateAggregationForSubs,
} from './aggregate.js';

// --- Evaluation Core (rule-level functions) ---
export type { WeightedFact } from './evaluate.js';

export {
  evaluateNaive,
  evaluateRule,
  evaluateRuleSemiNaive,
  evaluateRuleDelta,
  evaluatePositiveAtom,
  evaluateNegation,
  evaluateDifferentialNegation,
  evaluateGuardElement,
  evaluateAggregationElement,
  groundHead,
  getPositiveAtomIndices,
  getNegationAtomIndices,
} from './evaluate.js';

// --- Unified Evaluator (Plan 006.1) ---
export type { Evaluator, EvaluatorStepResult } from './evaluator.js';

export {
  createEvaluator,
  evaluateUnified as evaluate,
  evaluatePositiveUnified as evaluatePositive,
  evaluateStratumFromDelta,
} from './evaluator.js';