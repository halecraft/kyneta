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

// === Z-Set Algebra (DBSP) ===
export {
  type ZSet,
  type ZSetEntry,
  zsetAdd,
  zsetElements,
  zsetEmpty,
  zsetFilter,
  zsetForEach,
  zsetFromEntries,
  zsetGet,
  zsetHas,
  zsetIsEmpty,
  zsetKeys,
  zsetMap,
  zsetNegate,
  zsetNegative,
  zsetPositive,
  zsetSingleton,
  zsetSize,
} from "./base/zset.js"
// === Bootstrap (§B.8) ===
export {
  BOOTSTRAP_CONSTRAINT_COUNT,
  type BootstrapConfig,
  type BootstrapResult,
  buildDefaultFugueRules,
  buildDefaultLWWRules,
  buildDefaultRules,
  createReality,
  DEFAULT_RETRACTION_DEPTH,
} from "./bootstrap.js"
// === Datalog Evaluator ===
export {
  _,
  type AggregationClause,
  type AggregationElement,
  type AggregationFn,
  type Atom,
  type AtomElement,
  aggregation,
  // Atom & rule constructors
  atom,
  type BodyElement,
  bodyPredicates,
  buildDependencyGraph,
  type ConstTerm,
  type CyclicNegationError,
  compareValues,
  computeSCCs,
  // Term constructors
  constTerm,
  Database,
  // Stratification
  type DependencyEdge,
  type DependencyGraph,
  // Unification
  EMPTY_SUBSTITUTION,
  // Guard constructors
  eq,
  // Evaluation
  evaluate,
  // Aggregation
  evaluateAggregation,
  evaluateAggregationForSubs,
  evaluateGuard,
  evaluateGuardOp,
  evaluateNaive,
  evaluatePositive,
  extendSubstitution,
  type Fact,
  type FactTuple,
  fact,
  type GuardElement,
  type GuardOp,
  groundAtom,
  gt,
  gte,
  headPredicates,
  lt,
  lte,
  matchAtomAgainstRelation,
  matchAtomWithTuple,
  type NegationElement,
  negation,
  neq,
  positiveAtom,
  // Data structures
  Relation,
  type Rule,
  resolveTerm,
  rule,
  type StratificationError,
  type Stratum,
  type Substitution,
  // Value utilities
  serializeValue,
  stratify,
  // Types (Datalog-specific; kernel re-exports are above)
  type Term,
  unifyTermWithValue,
  type VarTerm,
  valuesEqual,
  varTerm,
  type WildcardTerm,
  wildcard,
} from "./datalog/index.js"
// === Incremental Pipeline (Plan 005) ===
export {
  createIncrementalEvaluation,
  createIncrementalPipeline,
  createIncrementalPipelineFromBootstrap,
  extractRuleDeltasFromActive,
  type IncrementalEvaluation,
  type IncrementalPipeline,
  type NodeDelta,
  type NodeDeltaKind,
  type RealityDelta,
  realityDeltaEmpty,
  realityDeltaFrom,
  routeFactsByPredicate,
  type StructureIndexDelta,
  structureIndexDeltaEmpty,
  structureIndexDeltaFrom,
} from "./kernel/incremental/index.js"

// === Kernel (Layer 0) ===
export {
  ACTIVE_STRUCTURE_SEQ,
  ACTIVE_VALUE,
  // Agent
  type Agent,
  type AuthorityAction,
  type AuthorityConstraint,
  type AuthorityPayload,
  // Authority (§5)
  type AuthorityState,
  allConstraints,
  allPairsFromOrdered,
  type BookmarkConstraint,
  type BookmarkPayload,
  buildNativeFuguePairs,
  // Native Resolution (§B.7)
  buildNativeResolution,
  // Skeleton (§7.3)
  buildSkeleton,
  buildStructureIndex,
  type Capability,
  type CnId,
  CONSTRAINT_PEER,
  type Constraint,
  type ConstraintBase,
  type ConstraintDelta,
  // Store
  type ConstraintStore,
  type ConstraintType,
  type Counter,
  capabilityCovers,
  capabilityEquals,
  capabilityKey,
  childKey,
  cnIdCompare,
  cnIdEquals,
  cnIdFromString,
  cnIdKey,
  cnIdNullableEquals,
  cnIdToString,
  computeActive,
  computeAuthority,
  computeValid,
  constraintCount,
  constraintsByType,
  createAgent,
  // CnId
  createCnId,
  createLamportClock,
  createLamportClockAt,
  createStore,
  createVersionVector,
  DEFAULT_RETRACTION_CONFIG,
  err,
  exportDelta,
  extractFugueOrdering,
  extractResolution,
  extractRules,
  extractWinners,
  type FugueBeforePair,
  filterActive,
  filterByVersion,
  filterValid,
  fuguePairKey,
  generateKeypair,
  getCapabilities,
  getChildren,
  getChildrenOfSlotGroup,
  getConstraint,
  getGeneration,
  getLamport,
  getSlotGroup,
  getSlotId,
  getStructure,
  getVersionVector,
  hasCapability,
  hasConstraint,
  hasDefaultFugueRules,
  hasDefaultLWWRules,
  hasStructure,
  type InsertError,
  type InvalidConstraint,
  importDelta,
  insert,
  insertMany,
  isDefaultRulesOnly,
  isSafeUint,
  type Lamport,
  // Lamport clock
  type LamportClock,
  lamportCurrent,
  lamportMerge,
  lamportObserve,
  type MutableVersionVector,
  mergeStores,
  nativeResolution,
  // Type utilities
  ok,
  // Types
  type PeerID,
  type Policy,
  // Projection (§7.2)
  type ProjectionResult,
  produceMapChild,
  produceRoot,
  produceSeqChild,
  projectToFacts,
  type Reality,
  type RealityNode,
  type ResolutionResult,
  // Rule Detection (§B.7)
  type ResolutionStrategy,
  // Resolution (§B.4, §B.7 — Datalog→kernel bridge)
  type ResolvedWinner,
  type Result,
  type RetractConstraint,
  // Retraction (§6)
  type RetractionConfig,
  type RetractionResult,
  type RetractionViolation,
  type RetractionViolationReason,
  type RetractPayload,
  type RetractScope,
  type RuleConstraint,
  type RulePayload,
  requiredCapability,
  // Structure Index (§8)
  type SlotGroup,
  STUB_PRIVATE_KEY,
  // Signature (stub)
  STUB_SIGNATURE,
  type StructureConstraint,
  type StructureIndex,
  type StructurePayload,
  selectResolutionStrategy,
  sign,
  slotId,
  tick,
  topologicalOrderFromPairs,
  type ValidationError,
  // Validity (§5)
  type ValidityResult,
  type Value,
  type ValueConstraint,
  type ValuePayload,
  type VersionVector,
  // Version vector
  type VVCompareResult,
  verify,
  vvClone,
  vvCompare,
  vvDiff,
  vvEquals,
  vvExtend,
  vvExtendCnId,
  vvFromObject,
  vvGet,
  vvHasSeen,
  vvHasSeenCnId,
  vvIncludes,
  vvIsEmpty,
  vvMerge,
  vvMergeInto,
  vvPeers,
  vvToObject,
  vvToString,
  vvTotalOps,
} from "./kernel/index.js"
// === Pipeline (§7) ===
export {
  type PipelineConfig,
  type PipelineResult,
  solve,
  solveFull,
} from "./kernel/pipeline.js"
