/**
 * Prism - Convergent Constraint Systems
 *
 * A constraint-based approach to CRDTs where constraints are truth
 * and state is derived through deterministic solving.
 *
 * @packageDocumentation
 */

// === Kernel (Layer 0) ===
export {
  // Types
  type PeerID,
  type Counter,
  type Lamport,
  type CnId,
  type VersionVector,
  type MutableVersionVector,
  type Value,
  type Policy,
  type StructurePayload,
  type ValuePayload,
  type RetractPayload,
  type RulePayload,
  type AuthorityPayload,
  type BookmarkPayload,
  type Capability,
  type RetractScope,
  type AuthorityAction,
  type ConstraintBase,
  type StructureConstraint,
  type ValueConstraint,
  type RetractConstraint,
  type RuleConstraint,
  type AuthorityConstraint,
  type BookmarkConstraint,
  type Constraint,
  type ConstraintType,
  type RealityNode,
  type Reality,
  type InsertError,
  type ValidationError,
  type Result,

  // Type utilities
  ok,
  err,
  isSafeUint,

  // CnId
  createCnId,
  cnIdEquals,
  cnIdNullableEquals,
  cnIdCompare,
  cnIdToString,
  cnIdFromString,
  cnIdKey,

  // Lamport clock
  type LamportClock,
  createLamportClock,
  createLamportClockAt,
  tick,
  lamportMerge,
  lamportObserve,
  lamportCurrent,

  // Version vector
  type VVCompareResult,
  createVersionVector,
  vvFromObject,
  vvClone,
  vvGet,
  vvHasSeen,
  vvHasSeenCnId,
  vvExtend,
  vvExtendCnId,
  vvCompare,
  vvIncludes,
  vvEquals,
  vvMerge,
  vvMergeInto,
  filterByVersion,
  vvDiff,
  vvToObject,
  vvToString,
  vvPeers,
  vvIsEmpty,
  vvTotalOps,

  // Signature (stub)
  STUB_SIGNATURE,
  sign,
  verify,
  STUB_PRIVATE_KEY,
  generateKeypair,

  // Store
  type ConstraintStore,
  type ConstraintDelta,
  createStore,
  insert,
  insertMany,
  getConstraint,
  hasConstraint,
  constraintCount,
  allConstraints,
  constraintsByType,
  mergeStores,
  exportDelta,
  importDelta,
  getVersionVector,
  getLamport,
  getGeneration,

  // Agent
  type Agent,
  createAgent,
  produceRoot,
  produceMapChild,
  produceSeqChild,
} from './kernel/index.js';

// === Datalog Evaluator ===
export {
  // Types (Datalog-specific; kernel re-exports are above)
  type CnIdRef,
  type Term,
  type ConstTerm,
  type VarTerm,
  type WildcardTerm,
  type Atom,
  type AggregationFn,
  type AggregationClause,
  type GuardOp,
  type GuardElement,
  type BodyElement,
  type AtomElement,
  type NegationElement,
  type AggregationElement,
  type Rule,
  type FactTuple,
  type Fact,
  type Substitution,
  type StratificationError,
  type CyclicNegationError,

  // Term constructors
  constTerm,
  varTerm,
  wildcard,
  _,

  // Atom & rule constructors
  atom,
  positiveAtom,
  negation,
  aggregation,
  rule,
  fact,

  // Guard constructors
  eq,
  neq,
  lt,
  gt,
  lte,
  gte,

  // Data structures
  Relation,
  Database,

  // Value utilities
  serializeValue,
  compareValues,
  valuesEqual,
  evaluateGuardOp,

  // Unification
  EMPTY_SUBSTITUTION,
  extendSubstitution,
  resolveTerm,
  unifyTermWithValue,
  matchAtomWithTuple,
  groundAtom,
  matchAtomAgainstRelation,
  evaluateGuard,

  // Stratification
  type DependencyEdge,
  type DependencyGraph,
  type Stratum,
  buildDependencyGraph,
  computeSCCs,
  stratify,
  bodyPredicates,
  headPredicates,

  // Aggregation
  evaluateAggregation,
  evaluateAggregationForSubs,

  // Evaluation
  evaluate,
  evaluatePositive,
  evaluateNaive,
} from './datalog/index.js';