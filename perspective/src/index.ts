/**
 * Prism - Convergent Constraint Systems
 *
 * A constraint-based approach to CRDTs where constraints are truth
 * and state is derived through deterministic solving.
 *
 * ## Quick Start
 *
 * ```ts
 * import {
 *   createReality, solve, insert,
 *   produceRoot, produceMapChild,
 * } from 'prism';
 *
 * const { store, agent, config } = createReality({ creator: 'alice' });
 * const root = produceRoot(agent, 'profile', 'map');
 * insert(store, root.constraint);
 * // ... add children, values, sync with other agents
 * const reality = solve(store, config);
 * ```
 *
 * @packageDocumentation
 */

// === Bootstrap (§B.8) ===
export {
  type BootstrapConfig,
  type BootstrapResult,
  createReality,
  buildDefaultLWWRules,
  buildDefaultFugueRules,
  buildDefaultRules,
  DEFAULT_RETRACTION_DEPTH,
  BOOTSTRAP_CONSTRAINT_COUNT,
} from './bootstrap.js';

// === Pipeline (§7) ===
export {
  type PipelineConfig,
  type PipelineResult,
  solve,
  solveFull,
} from './kernel/pipeline.js';

// === Incremental Pipeline (Plan 005) ===
export {
  type IncrementalPipeline,
  createIncrementalPipeline,
  createIncrementalPipelineFromBootstrap,
  type StructureIndexDelta,
  type NodeDelta,
  type NodeDeltaKind,
  type RealityDelta,
  structureIndexDeltaEmpty,
  structureIndexDeltaFrom,
  realityDeltaEmpty,
  realityDeltaFrom,
} from './kernel/incremental/index.js';

// === Z-Set Algebra (DBSP) ===
export {
  type ZSet,
  type ZSetEntry,
  zsetEmpty,
  zsetSingleton,
  zsetFromEntries,
  zsetAdd,
  zsetNegate,
  zsetIsEmpty,
  zsetSize,
  zsetGet,
  zsetHas,
  zsetPositive,
  zsetNegative,
  zsetForEach,
  zsetMap,
  zsetFilter,
  zsetElements,
  zsetKeys,
} from './base/zset.js';

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

  // Authority (§5)
  type AuthorityState,
  capabilityEquals,
  capabilityKey,
  capabilityCovers,
  computeAuthority,
  hasCapability,
  getCapabilities,
  requiredCapability,

  // Validity (§5)
  type ValidityResult,
  type InvalidConstraint,
  computeValid,
  filterValid,

  // Retraction (§6)
  type RetractionConfig,
  type RetractionResult,
  type RetractionViolation,
  type RetractionViolationReason,
  DEFAULT_RETRACTION_CONFIG,
  computeActive,
  filterActive,

  // Structure Index (§8)
  type SlotGroup,
  type StructureIndex,
  slotId,
  childKey,
  buildStructureIndex,
  getStructure,
  getSlotId,
  getSlotGroup,
  getChildren,
  hasStructure,
  getChildrenOfSlotGroup,

  // Projection (§7.2)
  type ProjectionResult,
  ACTIVE_VALUE,
  ACTIVE_STRUCTURE_SEQ,
  CONSTRAINT_PEER,
  projectToFacts,

  // Resolution (§B.4, §B.7 — Datalog→skeleton bridge)
  type ResolvedWinner,
  type FugueBeforePair,
  type ResolutionResult,
  extractWinners,
  extractFugueOrdering,
  extractResolution,
  nativeResolution,
  topologicalOrderFromPairs,

  // Skeleton (§7.3)
  buildSkeleton,
} from './kernel/index.js';

// === Datalog Evaluator ===
export {
  // Types (Datalog-specific; kernel re-exports are above)
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