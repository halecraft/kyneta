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

// --- Evaluation ---
export {
  evaluate,
  evaluatePositive,
  evaluateNaive,
  evaluateRule,
  evaluateRuleSemiNaive,
  evaluatePositiveAtom,
  evaluateNegation,
  evaluateGuardElement,
  evaluateAggregationElement,
  groundHead,
  getPositiveAtomIndices,
} from './evaluate.js';

// --- Incremental Evaluation (Plan 006, Phase 5) ---
export type { IncrementalDatalogEvaluator } from './incremental-evaluate.js';

export {
  createIncrementalDatalogEvaluator,
  applyFactDelta,
  diffDatabases,
  groupByPredicate,
} from './incremental-evaluate.js';