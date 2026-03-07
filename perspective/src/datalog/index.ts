// === Datalog Module Public API ===
// Re-exports the public surface of the Datalog evaluator.

// --- Types ---
export type {
  Value,
  CnIdRef,
  Term,
  ConstTerm,
  VarTerm,
  Atom,
  AggregationFn,
  AggregationClause,
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
  atom,
  positiveAtom,
  negation,
  aggregation,
  rule,
  fact,
  Relation,
  Database,
  serializeValue,
  compareValues,
  valuesEqual,
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
  isBuiltinPredicate,
  evaluateBuiltin,
  tryEvaluateBuiltin,
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
} from './evaluate.js';