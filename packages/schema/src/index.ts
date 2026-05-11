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
  ReplaceChange,
  RichTextChange,
  RichTextDelta,
  RichTextInstruction,
  RichTextSpan,
  SequenceChange,
  SequenceInstruction,
  TextChange,
  TextInstruction,
  TextPatch,
  TreeChange,
  TreeInstruction,
} from "./change.js"
export {
  advanceAddresses,
  advanceIndex,
  foldInstructions,
  incrementChange,
  isIncrementChange,
  isMapChange,
  isReplaceChange,
  isRichTextChange,
  isSequenceChange,
  // Type guards
  isTextChange,
  isTreeChange,
  mapChange,
  replaceChange,
  richTextChange,
  sequenceChange,
  // Constructors
  textChange,
  textInstructionsToPatches,
  transformIndex,
  treeChange,
} from "./change.js"
export type {
  ComposedChangefeedProtocol,
  HasComposedChangefeed,
  Op,
} from "./changefeed.js"
// Changefeed — schema-specific extensions (contract symbols live in @kyneta/changefeed)
export {
  expandMapOpsToLeaves,
  getOrCreateChangefeed,
  hasComposedChangefeed,
} from "./changefeed.js"
export type { MergeFn } from "./combinators.js"
// Interpreter composition combinators
export { firstDefined, overlay, product } from "./combinators.js"
// Create-doc — generic document construction for any substrate
export { createDoc, createRef } from "./create-doc.js"
export { describe } from "./describe.js"
export type { CommitOptions } from "./facade/change.js"
// Facade — library-level change capture and declarative application
export { applyChanges, change, remove } from "./facade/change.js"
// Facade — library-level observation protocol
export { subscribe, subscribeNode } from "./facade/observe.js"
// Guards — shared type-narrowing utilities
export { isNonNullObject, isPropertyHost } from "./guards.js"
export type {
  ChangefeedBrand,
  InterpretBuilder,
  Interpreter,
  InterpreterLayer,
  ReadableBrand,
  Resolve,
  ResolveCarrier,
  SumVariants,
  WritableBrand,
} from "./interpret.js"
// interpret — the generic catamorphism over the schema functor
export {
  createInterpreter,
  dispatchSum,
  interpret,
  RawPath,
  rawIndex,
  rawKey,
} from "./interpret.js"
// Shared interpreter types (canonical location)
export type { Plain, RefContext } from "./interpreter-types.js"
export type {
  HasCaching,
  HasCall,
  HasNavigation,
  HasRead,
} from "./interpreters/bottom.js"
// Bottom interpreter — universal foundation and capability lattice
export {
  bottomInterpreter,
  CALL,
  makeCarrier,
} from "./interpreters/bottom.js"
// Navigable type interfaces — navigation-only collection refs
export type {
  NavigableMapRef,
  NavigableSequenceRef,
} from "./interpreters/navigable.js"
// Built-in interpreters
export { plainInterpreter } from "./interpreters/plain.js"
// Readable types — type-level interpretation for readable refs
// (The monolithic readableInterpreter is removed; use
// withCaching(withReadable(bottomInterpreter)) instead.)
export type {
  Readable,
  ReadableMapRef,
  ReadableSequenceRef,
} from "./interpreters/readable.js"
// Positional algebra — cursor-positioning kernel
export { at } from "./interpreters/sequence-helpers.js"
export type { ValidateContext } from "./interpreters/validate.js"
// Validate interpreter — schema-driven validation with collecting errors
export {
  formatPath,
  SchemaValidationError,
  tryValidate,
  validate,
  validateInterpreter,
} from "./interpreters/validate.js"
// withAddressing — stable identity for all composite refs
export {
  ADDRESS_TABLE,
  withAddressing,
} from "./interpreters/with-addressing.js"
// withCaching — interposition transformer (identity-preserving caching + INVALIDATE)
export {
  INVALIDATE,
  withCaching,
} from "./interpreters/with-caching.js"
// Path types — re-exported from path.ts via interpret.ts
// (Path, RawPath, RawSegment, Segment, etc. are exported above)
export type { NotificationPlan } from "./interpreters/with-changefeed.js"
// Changefeed interpreter transformer — compositional observation layer
export {
  attachChangefeed,
  deliverNotifications,
  planNotifications,
  withChangefeed,
} from "./interpreters/with-changefeed.js"
// withNavigation — structural navigation (coalgebraic addressing, no reading)
export { withNavigation } from "./interpreters/with-navigation.js"
// withReadable — refinement transformer (reading only, requires navigation)
export { withReadable } from "./interpreters/with-readable.js"
export type {
  CounterRef,
  HasRemove,
  HasTransact,
  ProductRef,
  RichTextRef,
  ScalarRef,
  SequenceRef,
  TextRef,
  Writable,
  WritableContext,
  WritableMapRef,
} from "./interpreters/writable.js"
export {
  buildWritableContext,
  executeBatch,
  hasRemove,
  hasTransact,
  REMOVE,
  TRANSACT,
  withWritable,
} from "./interpreters/writable.js"
// Pre-built interpreter layers for fluent composition
export {
  addressing,
  navigation,
  observation,
  readable,
  writable,
} from "./layers.js"
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
export { NATIVE, SUBSTRATE } from "./native.js"
// Re-export path types from their canonical location
export type {
  Address,
  AddressTableRegistry,
  IndexAddress,
  MapAddressTable,
  Path,
  RawSegment,
  Segment,
  SequenceAddressTable,
} from "./path.js"
export {
  AddressedPath,
  indexAddress,
  keyAddress,
  nextAddressId,
  resetAddressIdCounter,
  resolveToAddressed,
} from "./path.js"
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
export type { PlainState, Reader } from "./reader.js"
// Reader — shared utilities for reading/writing plain state objects
export {
  applyChange,
  plainReader,
  writeByPath,
} from "./reader.js"
// Ref tier types — parameterized recursive refs for composed interpreter stacks
export type {
  DocRef,
  Ref,
  RefMode,
  Removable,
  RRef,
  RWRef,
  SchemaRef,
  Wrap,
} from "./ref.js"
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
  advanceSchema,
  buildVariantMap,
  isNullableSum,
  KIND,
  LAWS,
  Schema,
  structuralKind,
} from "./schema.js"
// Step — pure state transitions: (State, Change) → State
export {
  normalizeSpans,
  step,
  stepIncrement,
  stepMap,
  stepReplace,
  stepRichText,
  stepSequence,
  stepText,
} from "./step.js"
// Substrate — state management, versioning, and transfer semantics
export type {
  Delivery,
  DocMetadata,
  Durability,
  Replica,
  ReplicaFactory,
  ReplicaFactoryLike,
  ReplicaLike,
  ReplicaType,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
  SubstratePrepare,
  SyncProtocol,
  Version,
  WriterModel,
} from "./substrate.js"
export {
  BACKING_DOC,
  computeSchemaHash,
  fnv1a128,
  replicaTypesCompatible,
  requiresBidirectionalSync,
  STRUCTURAL_YJS_CLIENT_ID,
  SYNC_AUTHORITATIVE,
  SYNC_COLLABORATIVE,
  SYNC_EPHEMERAL,
} from "./substrate.js"
// Plain substrate — plain JS object store with version tracking
export {
  buildUpgrade,
  createPlainReplica,
  createPlainSubstrate,
  objectToReplaceOps,
  PlainVersion,
  plainContext,
  plainReplicaFactory,
  plainSubstrateFactory,
} from "./substrates/plain.js"
// Timestamp version — wall-clock version for LWW/ephemeral substrates
export { TimestampVersion } from "./substrates/timestamp-version.js"
// Sync — generic sync functions for any substrate (via ref[SUBSTRATE])
export {
  exportEntirety,
  exportSince,
  merge,
  version,
} from "./sync.js"
// Tree-position algebra — flat↔tree position mapping for editor bindings
export type { ResolvedTreePosition } from "./tree-position.js"
export {
  contentSize,
  flattenTreePosition,
  isLeaf,
  nodeSize,
  resolveTreePosition,
} from "./tree-position.js"
export type { HasNativeAny } from "./unwrap.js"
// Unwrap — typed escape hatch for accessing the native container backing a ref
export { unwrap } from "./unwrap.js"
// Version vector — shared lattice utilities for version vectors
export { versionVectorCompare, versionVectorMeet } from "./version-vector.js"
// Zero — default values derived from the schema grammar
export { scalarDefault, Zero } from "./zero.js"
