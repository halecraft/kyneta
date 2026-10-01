// @kyneta/schema — pure structure, pluggable interpretations
//
// This barrel re-exports the three core modules that make up the
// schema interpreter algebra spike.

// Base64 — platform-agnostic encoding utilities
export { base64ToUint8Array, uint8ArrayToBase64 } from "./base64.js"
// Bind — schema + factory + sync protocol binding
export type {
  BindingTarget,
  BoundSchema,
  EphemeralLaws,
  FactoryBuilder,
  RestrictLaws,
} from "./bind.js"
// Interpret, Replicate, BoundReplica are dual-namespace (type + value) —
// export from the value line only; TypeScript resolves the type automatically.
export {
  BoundReplica,
  bind,
  createBindingTarget,
  Defer,
  ephemeral,
  Interpret,
  isBoundSchema,
  json,
  metadataOf,
  Reject,
  Replicate,
} from "./bind.js"
// Change types — the universal currency of change
export type {
  BuiltinChange,
  Change,
  ChangeBase,
  FoldResult,
  IncrementChange,
  Instruction,
  InstructionFold,
  MapChange,
  MarkMap,
  Owned,
  OwnedRichTextInstruction,
  PayloadSlot,
  ReplaceChange,
  RichTextChange,
  RichTextDelta,
  RichTextInstruction,
  RichTextSpan,
  SequenceChange,
  SequenceInstruction,
  SetChange,
  SingleEdit,
  TextChange,
  TextInstruction,
  TextPatch,
  TreeChange,
  TreeInstruction,
} from "./change.js"
export {
  advanceAddresses,
  advanceIndex,
  applyTextInstructions,
  diffText,
  foldInstructions,
  incrementChange,
  isIncrementChange,
  isMapChange,
  isReplaceChange,
  isRichTextChange,
  isSequenceChange,
  isSetOpChange,
  // Type guards
  isTextChange,
  isTreeChange,
  mapChange,
  mapChangeEffects,
  mapClearChange,
  mapPayload,
  own,
  replaceChange,
  richTextChange,
  sequenceChange,
  setOpChange,
  singleEdit,
  // Constructors
  textChange,
  textInstructionsToPatches,
  transformIndex,
  treeChange,
  trustAsOwned,
} from "./change.js"
export type {
  HasRecursiveChangefeed,
  Op,
  RecursiveChangefeedProtocol,
} from "./changefeed.js"
// Changefeed — schema-specific extensions (contract symbols live in @kyneta/changefeed)
export {
  expandProductMapChanges,
  getOrCreateChangefeed,
  hasRecursiveChangefeed,
} from "./changefeed.js"
// Clone — the shared deep-copy primitive (leaf module, no imports)
export {
  deepClonePlain,
  freezeTree,
  isDeeplyFrozen,
} from "./clone.js"
export { CoordinateTrie } from "./coordinate-trie.js"
// Create-doc — generic document construction for any substrate
export { createDoc, createDocAs, createRef } from "./create-doc.js"
export { describe } from "./describe.js"
// Undo — rebasing positions, restoring values, grouping typing
export { diffSequence, diffString } from "./diff-sequence.js"
// Doc-position algebra — flat↔document-tree position mapping for editor bindings
export type { ResolvedDocPosition } from "./doc-position.js"
export {
  contentSize,
  flattenDocPosition,
  isLeaf,
  nodeSize,
  resolveDocPosition,
} from "./doc-position.js"
// Facade — library-level change capture and declarative application
export { applyChanges, batch, remove } from "./facade/batch.js"
// Facade — metadata read
export { lastUpdated } from "./facade/last-updated.js"
// Facade — library-level observation protocol
export { subscribe, subscribeNode } from "./facade/observe.js"
// walkPath — the one schema-guided traversal, and its projections. `foldPath`
// is the value-resolving one that every CRDT backend's path resolver composes
// around. The single-step primitive underneath (`stepSchema`) is deliberately
// NOT exported: handing it out is what makes hand-rolling a divergent walker
// easy, and that is what this module exists to prevent.
export type {
  OpaqueBoundaryHit,
  PathFoldResult,
  PathStepper,
  PathWalk,
} from "./fold-path.js"
export {
  extendSchemaPathKey,
  findOpaqueBoundary,
  foldPath,
  pathSchema,
  walkPath,
} from "./fold-path.js"
// Forest helpers — pure flat↔recursive projection for `Schema.tree`
export type {
  FlatTreeNode,
  ForestNode,
  ForestValidationError,
  ForestValidationErrorKind,
} from "./forest.js"
export {
  flattenForest,
  nestForest,
  subtreeIds,
  validateForest,
} from "./forest.js"
// Guards — shared type-narrowing utilities
export {
  isNonNullObject,
  isPlainObject,
  isPropertyHost,
  samePlainValue,
} from "./guards.js"
// Peer numbers — a peer id's CRDT identity, shared by the Yjs and Loro bindings
export { peerNumber } from "./hash.js"
export type { Interpreter, SumVariants } from "./interpret.js"
// interpret — the generic catamorphism over the schema functor
export {
  createInterpreter,
  dispatchSum,
  interpret,
  RawPath,
  rawEntry,
  rawField,
  rawIndex,
} from "./interpret.js"
// Materialize interpreter — generic CRDT→PlainState materialization
export type {
  MaterializeContext,
  MaterializeResolver,
} from "./interpreters/materialize.js"
export {
  createMaterializeInterpreter,
  materializeContextFromResolver,
  plainResolution,
  plainValueResolver,
} from "./interpreters/materialize.js"
export type { ValidateContext } from "./interpreters/validate.js"
// Validate interpreter — schema-driven validation with collecting errors
export {
  SchemaValidationError,
  tryValidate,
  validate,
  validateInterpreter,
} from "./interpreters/validate.js"
// Zero — default values derived from the schema grammar
export { scalarDefault, Zero, zeroInterpreter } from "./interpreters/zero.js"
// Inverse — reverse arrows for the change groupoid (abort and undo)
export {
  invert,
  invertIncrement,
  invertMap,
  invertReplace,
  invertRichText,
  invertSequence,
  invertSet,
  invertText,
  invertTree,
} from "./inverse.js"
// materializeValue — write-side counterpart to foldPath: unfolds a plain value
// into a backend-agnostic, identity-keyed container-shape IR.
export type { EagerPolicy, MaterializedNode } from "./materialize-value.js"
export {
  containerKey,
  fieldAbsPath,
  materializeValue,
  needsContainer,
} from "./materialize-value.js"
// Migration — schema migration primitives and identity derivation
export type {
  Droppable,
  DroppedPrimitive,
  EpochStep,
  IdentityManifest,
  IdentityOrigin,
  MigrationChain,
  MigrationChainEntry,
  MigrationInput,
  MigrationPrimitive,
  MigrationStep,
  MigrationTier,
  NodeIdentity,
  NonT2Primitive,
  SchemaBinding,
  T2Primitive,
  TransformProof,
} from "./migration.js"
export {
  deriveIdentity,
  deriveManifest,
  deriveSchemaBinding,
  deriveStepTier,
  deriveTier,
  getMigrationChain,
  type HasMigrationChain,
  hasMigrationChain,
  MIGRATION_CHAIN,
  Migration,
  migrationMethods,
  snapshotManifest,
  validateChain,
} from "./migration.js"
// Native — NativeMap functor, NATIVE/SUBSTRATE symbols, HasNative
export type {
  HasNative,
  NativeMap,
  PlainNativeMap,
  UnknownNativeMap,
} from "./native.js"
export {
  type HasSubstrate,
  hasSubstrate,
  NATIVE,
  SUBSTRATE,
} from "./native.js"
// Re-export path types from their canonical location
export type {
  Address,
  Coordinate,
  IndexAddress,
  Path,
  RawSegment,
  Segment,
} from "./path.js"
export {
  AddressedPath,
  entryAddress,
  fieldAddress,
  indexAddress,
  nextAddressId,
  resetAddressIdCounter,
} from "./path.js"
// Plain values — the type of a schema's plain value
export type { Plain, PlainFlatTreeNode } from "./plain-types.js"
// Position algebra — substrate-agnostic cursor stability
export type {
  HasPosition,
  Position,
  PositionCapable,
  Side,
} from "./position.js"
export {
  decodePlainPosition,
  hasPosition,
  PlainPosition,
  POSITION,
} from "./position.js"
export type {
  FlatTreeNodeTopology,
  PlainState,
  Reader,
  StateCell,
} from "./reader.js"
// Reader — reading σ, and advancing it by a change
export { applyChange, freezePayload, plainReader } from "./reader.js"
export { rebaseChange } from "./rebase.js"
// Reconcile — σ brought up to date from λ where a change touched it
export type { ReconcileTarget, Touched } from "./reconcile-shadow.js"
export {
  planReconcile,
  reconcileShadow,
  touchedBy,
} from "./reconcile-shadow.js"
// Refs — one construction per schema node (`ref/`): the deletion, removal and
// population protocols, the read symbol, and the ref types by kind
export {
  DELETED,
  deleted,
  deletedFeed,
  type HasDeleted,
  type HasRemove,
  hasDeleted,
  hasRemove,
  REMOVE,
} from "./ref/address.js"
// Navigable type interfaces — navigation-only collection refs
export type {
  NavigableMapRef,
  NavigableSequenceRef,
} from "./ref/navigable.js"
export {
  type HasFlag,
  type HasPopulated,
  hasPopulated,
  POPULATED,
  populated,
  populatedFeed,
} from "./ref/observe.js"
export { CALL } from "./ref/read.js"
// The read surface of a ref, by kind (`Readable<S>`)
export type {
  Readable,
  ReadableMapRef,
  ReadableSequenceRef,
  ReadableSetRef,
  ReadableTreeNode,
  ReadableTreeRef,
} from "./ref/readable.js"
// Ref types — a document's refs, typed by schema
export type {
  DocRef,
  Ref,
  Removable,
  RRef,
  SchemaRef,
  Wrap,
} from "./ref/schema-ref.js"
// The write surface of a ref, by kind
export type {
  CounterRef,
  ProductRef,
  RichTextRef,
  ScalarRef,
  SequenceRef,
  TextRef,
  WritableMapRef,
  WritableSetRef,
  WritableTreeRef,
} from "./ref/writable.js"
// `at`, the cursor-positioning primitive; `TRANSACT`, a ref's context
export { at, type HasTransact, hasTransact, TRANSACT } from "./ref/write.js"
export type { ValueRestore } from "./restore.js"
export { planValueRestores } from "./restore.js"
export type { PartReverted, StepReverted } from "./revert-step.js"
export { revertStep } from "./revert-step.js"
export type {
  CounterSchema,
  DiscriminatedSumSchema,
  ExtractLaws,
  // KIND symbol type
  KindSymbol,
  // Capability extraction
  LawsSymbol,
  MapSchema,
  MarkConfig,
  MarkExpand,
  MovableSequenceSchema,
  NullableSumOf,
  NullableSumSchema,
  PlainDiscriminatedSumSchema,
  PlainMapSchema,
  PlainPositionalSumSchema,
  PlainProductSchema,
  // Plain subset (no non-LWW types) — used by .json() and sum constraints
  PlainSchema,
  PlainSequenceSchema,
  PositionalSumSchema,
  ProductSchema,
  // Rich text
  RichTextSchema,
  // Scalar kinds
  ScalarKind,
  ScalarPlain,
  // Structural kinds
  ScalarSchema,
  // The recursive union
  Schema as SchemaNode,
  SequenceSchema,
  SetSchema,
  StructuralKind,
  SumSchema,
  TextSchema,
  TreeSchema,
} from "./schema.js"
// Schema — unified recursive grammar (backend-agnostic)
export {
  buildVariantMap,
  isCounterSchema,
  isJsonBoundary,
  isMapSchema,
  isMovableSchema,
  isNullableSum,
  isProductSchema,
  isRichTextSchema,
  isScalarSchema,
  isSequenceSchema,
  isSetSchema,
  isTextSchema,
  isTreeSchema,
  JSON_BOUNDARY,
  KIND,
  LAWS,
  Schema,
  structuralKind,
} from "./schema.js"
// Step — state transitions: (State, Change) → State, pure and in place
export {
  normalizeSpans,
  step,
  stepIncrement,
  stepInPlace,
  stepMap,
  stepReplace,
  stepRichText,
  stepSequence,
  stepSet,
  stepText,
  stepTree,
} from "./step.js"
// Substrate — state management, versioning, and transfer semantics
// Tree node allocation — substrate capability for tree.create()
export type {
  AnnounceOptions,
  BatchIngress,
  BatchOptions,
  BatchOutcome,
  CommitOptions,
  DevtoolsHistory,
  DevtoolsHistorySummary,
  DocMetadata,
  Durability,
  HasDevtoolsHistory,
  HasTreeNodeAllocation,
  HydrationHandle,
  MergeOptions,
  MetadataAxis,
  MetadataMismatch,
  PrepareIngress,
  PrepareOptions,
  ReadCapability,
  RecordCodec,
  RecordInverseFn,
  Remap,
  Replica,
  ReplicaFactory,
  ReplicaFactoryLike,
  ReplicaLike,
  ReplicaType,
  Reverted,
  Revertible,
  RevertibleCommit,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
  SubstratePrepare,
  SyncMode,
  Version,
  WriterModel,
} from "./substrate.js"
export {
  BACKING_DOC,
  beginHydration,
  beginUpgrade,
  computeSchemaHash,
  DEVTOOLS_HISTORY,
  HASH_ALGORITHM_VERSION,
  type HasBackingDoc,
  hasBackingDoc,
  hasDevtoolsHistory,
  hasTreeNodeAllocation,
  jsonRecordCodec,
  mismatchForInterpretation,
  mismatchForSync,
  planAdvance,
  reaches,
  replicaTypesCompatible,
  requiresBidirectionalSync,
  STRUCTURAL_YJS_CLIENT_ID,
  SYNC_AUTHORITATIVE,
  SYNC_COLLABORATIVE,
  SYNC_EPHEMERAL,
  supportsHash,
  TREE_NODE_ALLOCATE,
} from "./substrate.js"
export {
  ephemeralReplicaFactory,
  ephemeralSubstrateFactory,
} from "./substrates/ephemeral.js"
// Plain substrate — plain JS object store with version tracking
export {
  DEFAULT_LINEAGE,
  decodePlainPayload,
  latestLineage,
  mintLineage,
  objectToReplaceOps,
  type PlainPayload,
  PlainVersion,
  plainReplicaFactory,
  plainSubstrateFactory,
  supersedes,
} from "./substrates/plain.js"
export type { SubtreeEffect } from "./subtree-effect.js"
// Sync — generic sync functions for any substrate (via ref[SUBSTRATE])
export {
  exportEntirety,
  exportSince,
  merge,
  version,
} from "./sync.js"
// Read tracking — dependency capture for reactive scopes (consumed by
// @kyneta/reactive, jj:kpywvkpr). Pure scope stack + single `reportRead`
// mutation; aspect vocabulary harmonizes with @kyneta/compiler's
// DependencyClassification.
export type { Aspect, Dependency } from "./tracking.js"
export {
  currentScope,
  dependencyKey,
  reportRead,
  withReadScope,
} from "./tracking.js"
export type { Edit } from "./typing.js"
export { continuesStep, editOf, TYPING_GAP } from "./typing.js"
export type { HasNativeAny } from "./unwrap.js"
// Unwrap — typed escape hatch for accessing the native container backing a ref
export { unwrap } from "./unwrap.js"
// Version vector — shared lattice utilities for version vectors
export {
  versionVectorCompare,
  versionVectorJoin,
  versionVectorMeet,
} from "./version-vector.js"
// The writable context every ref of a document shares
export type {
  SealedBatch,
  SubstrateCapabilities,
  WritableContext,
} from "./writable-context.js"
export { buildWritableContext } from "./writable-context.js"
