// @kyneta/schema — pure structure, pluggable interpretations
//
// This barrel re-exports the three core modules that make up the
// schema interpreter algebra spike.

// Change types — the universal currency of change
export type {
  BuiltinChange,
  Change,
  ChangeBase,
  IncrementChange,
  MapChange,
  ReplaceChange,
  SequenceChange,
  SequenceInstruction,
  TextChange,
  TextInstruction,
  TreeChange,
  TreeInstruction,
} from "./change.js"
export {
  incrementChange,
  isIncrementChange,
  isMapChange,
  isReplaceChange,
  isSequenceChange,
  // Type guards
  isTextChange,
  isTreeChange,
  mapChange,
  replaceChange,
  sequenceChange,
  // Constructors
  textChange,
  treeChange,
} from "./change.js"
export type {
  Changefeed,
  Changeset,
  ComposedChangefeed,
  HasChangefeed,
  HasComposedChangefeed,
  Op,
} from "./changefeed.js"
// Changefeed — the unified reactive protocol
export {
  CHANGEFEED,
  getOrCreateChangefeed,
  hasChangefeed,
  hasComposedChangefeed,
  staticChangefeed,
} from "./changefeed.js"
export type { MergeFn } from "./combinators.js"
// Interpreter composition combinators
export { firstDefined, overlay, product } from "./combinators.js"
export { describe } from "./describe.js"
export type { ApplyChangesOptions } from "./facade/change.js"
// Facade — library-level change capture and declarative application
export { applyChanges, change } from "./facade/change.js"
// Facade — library-level observation protocol
export { subscribe, subscribeNode } from "./facade/observe.js"
// Guards — shared type-narrowing utilities
export { isNonNullObject, isPropertyHost } from "./guards.js"
export type {
  ChangefeedBrand,
  InterpretBuilder,
  Interpreter,
  InterpreterLayer,
  Path,
  PathSegment,
  ReadableBrand,
  Resolve,
  ResolveCarrier,
  SumVariants,
  WritableBrand,
} from "./interpret.js"
// interpret — the generic catamorphism over the schema functor
export { createInterpreter, interpret } from "./interpret.js"
// Shared interpreter types (canonical location)
export type { Plain, RefContext, Seed } from "./interpreter-types.js"
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
export type { ValidateContext } from "./interpreters/validate.js"
// Validate interpreter — schema-driven validation with collecting errors
export {
  formatPath,
  SchemaValidationError,
  tryValidate,
  validate,
  validateInterpreter,
} from "./interpreters/validate.js"
export type { CacheInstruction } from "./interpreters/with-caching.js"
// withCaching — interposition transformer (identity-preserving caching + INVALIDATE)
export {
  applyCacheOps,
  INVALIDATE,
  planCacheUpdate,
  withCaching,
} from "./interpreters/with-caching.js"
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
  HasTransact,
  ProductRef,
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
  hasTransact,
  TRANSACT,
  withWritable,
} from "./interpreters/writable.js"
// Pre-built interpreter layers for fluent composition
export { changefeed, navigation, readable, writable } from "./layers.js"
// LoroSchema — Loro-specific annotations + composition constraints
export { LoroSchema } from "./loro-schema.js"
// Ref tier types — parameterized recursive refs for composed interpreter stacks
export type {
  Ref,
  RefMode,
  RRef,
  RWRef,
  SchemaRef,
  WithTransact,
  Wrap,
} from "./ref.js"
export type {
  AnnotatedSchema,
  DiscriminatedSumSchema,
  MapSchema,
  PlainDiscriminatedSumSchema,
  PlainMapSchema,
  PlainPositionalSumSchema,
  PlainProductSchema,
  // Plain subset (no annotations) — used by LoroSchema.plain.* constraints
  PlainSchema,
  PlainSequenceSchema,
  PositionalSumSchema,
  ProductSchema,
  // Scalar kinds
  ScalarKind,
  ScalarPlain,
  // Structural kinds
  ScalarSchema,
  // The recursive union
  Schema as SchemaNode,
  SequenceSchema,
  SumSchema,
} from "./schema.js"
// Schema — unified recursive grammar (backend-agnostic)
export {
  buildVariantMap,
  isAnnotated,
  isNullableSum,
  Schema,
  structuralKind,
  unwrapAnnotation,
} from "./schema.js"
// Step — pure state transitions: (State, Change) → State
export {
  step,
  stepIncrement,
  stepMap,
  stepReplace,
  stepSequence,
  stepText,
} from "./step.js"
export type { Store } from "./store.js"
// Store — shared utilities for reading/writing plain JS object stores
export {
  applyChangeToStore,
  dispatchSum,
  pathKey,
  readByPath,
  storeArrayLength,
  storeHasKey,
  storeKeys,
  writeByPath,
} from "./store.js"
// Substrate — state management, versioning, and transfer semantics
export type {
  Frontier,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
  SubstratePrepare,
} from "./substrate.js"
// Plain substrate — plain JS object store with version tracking
export {
  createPlainSubstrate,
  PlainFrontier,
  plainContext,
  plainSubstrateFactory,
} from "./substrates/plain.js"
// Zero — default values separated from the schema
export { scalarDefault, Zero } from "./zero.js"
