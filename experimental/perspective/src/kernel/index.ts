// === Kernel Module Public API ===
// Re-exports the public surface of the Layer 0 kernel.

// --- Agent ---
export type { Agent } from "./agent.js"
export {
  createAgent,
  produceMapChild,
  produceRoot,
  produceSeqChild,
} from "./agent.js"
// --- Authority (§5.1) ---
export type { AuthorityState } from "./authority.js"
export {
  capabilityCovers,
  capabilityEquals,
  capabilityKey,
  computeAuthority,
  getCapabilities,
  hasCapability,
  requiredCapability,
} from "./authority.js"
// --- CnId ---
export {
  cnIdCompare,
  cnIdEquals,
  cnIdFromString,
  cnIdKey,
  cnIdNullableEquals,
  cnIdToString,
  createCnId,
} from "./cnid.js"
// --- Lamport clock ---
export type { LamportClock } from "./lamport.js"
export {
  createLamportClock,
  createLamportClockAt,
  current as lamportCurrent,
  merge as lamportMerge,
  observe as lamportObserve,
  tick,
} from "./lamport.js"
// --- Native Resolution (§B.7) ---
export {
  buildNativeFuguePairs,
  buildNativeResolution,
} from "./native-resolution.js"
// --- Pipeline (§7) ---
export type {
  PipelineConfig,
  PipelineResult,
} from "./pipeline.js"
export {
  solve,
  solveFull,
} from "./pipeline.js"
// --- Projection (§7.2) ---
export type { ProjectionResult } from "./projection.js"
export {
  ACTIVE_STRUCTURE_SEQ,
  ACTIVE_VALUE,
  CONSTRAINT_PEER,
  projectToFacts,
} from "./projection.js"
// --- Resolution (§B.4, §B.7 — Datalog→kernel bridge) ---
export type {
  FugueBeforePair,
  ResolutionResult,
  ResolvedWinner,
} from "./resolve.js"
export {
  allPairsFromOrdered,
  extractFugueOrdering,
  extractResolution,
  extractWinners,
  fuguePairKey,
  nativeResolution,
  type ParsedSeqStructureFact,
  parseLWWFact,
  parseSeqStructureFact,
  topologicalOrderFromPairs,
} from "./resolve.js"
// --- Retraction (§6) ---
export type {
  RetractionConfig,
  RetractionResult,
  RetractionViolation,
  RetractionViolationReason,
} from "./retraction.js"
export {
  computeActive,
  DEFAULT_RETRACTION_CONFIG,
  filterActive,
} from "./retraction.js"
// --- Rule Detection (§B.7) ---
export type { ResolutionStrategy } from "./rule-detection.js"
export {
  extractRules,
  hasDefaultFugueRules,
  hasDefaultLWWRules,
  isDefaultRulesOnly,
  selectResolutionStrategy,
} from "./rule-detection.js"
// --- Signature (stub) ---
export {
  generateKeypair,
  STUB_PRIVATE_KEY,
  STUB_SIGNATURE,
  sign,
  verify,
} from "./signature.js"
// --- Skeleton (§7.3) ---
export { buildSkeleton } from "./skeleton.js"
// --- Store ---
export type {
  ConstraintDelta,
  ConstraintStore,
} from "./store.js"
export {
  allConstraints,
  constraintCount,
  constraintsByType,
  createStore,
  exportDelta,
  getConstraint,
  getGeneration,
  getLamport,
  getVersionVector,
  hasConstraint,
  importDelta,
  insert,
  insertMany,
  mergeStores,
} from "./store.js"
// --- Structure Index (§8) ---
export type {
  SlotGroup,
  StructureIndex,
} from "./structure-index.js"
export {
  buildStructureIndex,
  childKey,
  getChildren,
  getChildrenOfSlotGroup,
  getSlotGroup,
  getSlotId,
  getStructure,
  hasStructure,
  slotId,
} from "./structure-index.js"
// --- Types ---
// --- Re-exported Datalog types (for RulePayload) ---
export type {
  AggregationClause,
  AggregationElement,
  Atom,
  AtomElement,
  AuthorityAction,
  AuthorityConstraint,
  AuthorityPayload,
  BodyElement,
  BookmarkConstraint,
  BookmarkPayload,
  Capability,
  CnId,
  Constraint,
  ConstraintBase,
  ConstraintType,
  ConstTerm,
  Counter,
  GuardElement,
  GuardOp,
  InsertError,
  Lamport,
  MutableVersionVector,
  NegationElement,
  PeerID,
  Policy,
  Reality,
  RealityNode,
  Result,
  RetractConstraint,
  RetractPayload,
  RetractScope,
  Rule,
  RuleConstraint,
  RulePayload,
  StructureConstraint,
  StructurePayload,
  Term,
  ValidationError,
  Value,
  ValueConstraint,
  ValuePayload,
  VarTerm,
  VersionVector,
  WildcardTerm,
} from "./types.js"
// --- Type utilities ---
export { err, isSafeUint, ok } from "./types.js"
// --- Validity (§5.2–§5.3) ---
export type {
  InvalidConstraint,
  ValidityResult,
} from "./validity.js"
export {
  computeValid,
  filterValid,
} from "./validity.js"
// --- Version vector ---
export type { VVCompareResult } from "./version-vector.js"
export {
  createVersionVector,
  filterByVersion,
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
} from "./version-vector.js"
