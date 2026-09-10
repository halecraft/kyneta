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
  BOOTSTRAP_CONSTRAINT_COUNT,
  type BootstrapConfig,
  type BootstrapResult,
  buildDefaultFugueRules,
  buildDefaultLWWRules,
  buildDefaultRules,
  createReality,
  DEFAULT_RETRACTION_DEPTH,
} from "./bootstrap.js"
// === Incremental Pipeline (Plan 005) ===
export {
  createIncrementalEvaluation,
  createIncrementalPipeline,
  createIncrementalPipelineFromStore,
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
  exportDelta,
  extractFugueOrdering,
  extractResolution,
  extractRules,
  extractWinners,
  type FugueBeforePair,
  filterActive,
  filterByVersion,
  filterValid,
  fuguePairDeltas,
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
  winnerDeltas,
} from "./kernel/index.js"
// === Pipeline (§7) ===
export {
  type PipelineConfig,
  type PipelineResult,
  solve,
  solveFull,
} from "./kernel/pipeline.js"
