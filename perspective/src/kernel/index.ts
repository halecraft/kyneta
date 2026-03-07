// === Kernel Module Public API ===
// Re-exports the public surface of the Layer 0 kernel.

// --- Types ---
export type {
  PeerID,
  Counter,
  Lamport,
  CnId,
  VersionVector,
  MutableVersionVector,
  Value,
  Policy,
  StructurePayload,
  ValuePayload,
  RetractPayload,
  RulePayload,
  AuthorityPayload,
  BookmarkPayload,
  Capability,
  RetractScope,
  AuthorityAction,
  ConstraintBase,
  StructureConstraint,
  ValueConstraint,
  RetractConstraint,
  RuleConstraint,
  AuthorityConstraint,
  BookmarkConstraint,
  Constraint,
  ConstraintType,
  RealityNode,
  Reality,
  InsertError,
  ValidationError,
  Result,
} from './types.js';

// --- Type utilities ---
export { ok, err, isSafeUint } from './types.js';

// --- Re-exported Datalog types (for RulePayload) ---
export type {
  Atom,
  Term,
  ConstTerm,
  VarTerm,
  WildcardTerm,
  GuardOp,
  GuardElement,
  BodyElement,
  AtomElement,
  NegationElement,
  AggregationElement,
  AggregationClause,
  Rule,
} from './types.js';

// --- CnId ---
export {
  createCnId,
  cnIdEquals,
  cnIdNullableEquals,
  cnIdCompare,
  cnIdToString,
  cnIdFromString,
  cnIdKey,
} from './cnid.js';

// --- Lamport clock ---
export type { LamportClock } from './lamport.js';

export {
  createLamportClock,
  createLamportClockAt,
  tick,
  merge as lamportMerge,
  observe as lamportObserve,
  current as lamportCurrent,
} from './lamport.js';

// --- Version vector ---
export type { VVCompareResult } from './version-vector.js';

export {
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
} from './version-vector.js';

// --- Signature (stub) ---
export {
  STUB_SIGNATURE,
  sign,
  verify,
  STUB_PRIVATE_KEY,
  generateKeypair,
} from './signature.js';

// --- Store ---
export type {
  ConstraintStore,
  ConstraintDelta,
} from './store.js';

export {
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
} from './store.js';

// --- Agent ---
export type { Agent } from './agent.js';

export {
  createAgent,
  produceRoot,
  produceMapChild,
  produceSeqChild,
} from './agent.js';

// --- Authority (§5.1) ---
export type { AuthorityState } from './authority.js';

export {
  capabilityEquals,
  capabilityKey,
  capabilityCovers,
  computeAuthority,
  hasCapability,
  getCapabilities,
  requiredCapability,
} from './authority.js';

// --- Validity (§5.2–§5.3) ---
export type {
  ValidityResult,
  InvalidConstraint,
} from './validity.js';

export {
  computeValid,
  filterValid,
} from './validity.js';

// --- Retraction (§6) ---
export type {
  RetractionConfig,
  RetractionResult,
  RetractionViolation,
  RetractionViolationReason,
} from './retraction.js';

export {
  DEFAULT_RETRACTION_CONFIG,
  computeActive,
  filterActive,
} from './retraction.js';