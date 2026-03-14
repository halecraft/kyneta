// @loro-extended/schema — pure structure, pluggable interpretations
//
// This barrel re-exports the three core modules that make up the
// schema interpreter algebra spike.

// Schema — unified recursive grammar (backend-agnostic)
export {
  Schema,
  structuralKind,
  isAnnotated,
  isNullableSum,
  unwrapAnnotation,
} from "./schema.js"
// LoroSchema — Loro-specific annotations + composition constraints
export { LoroSchema } from "./loro-schema.js"
export { describe } from "./describe.js"
export type {
  // The recursive union
  Schema as SchemaNode,
  // Structural kinds
  ScalarSchema,
  ProductSchema,
  SequenceSchema,
  MapSchema,
  SumSchema,
  PositionalSumSchema,
  DiscriminatedSumSchema,
  AnnotatedSchema,
  // Plain subset (no annotations) — used by LoroSchema.plain.* constraints
  PlainSchema,
  PlainProductSchema,
  PlainSequenceSchema,
  PlainMapSchema,
  PlainPositionalSumSchema,
  PlainDiscriminatedSumSchema,
  // Scalar kinds
  ScalarKind,
  ScalarPlain,
} from "./schema.js"

// Change types — the universal currency of change
export type {
  ChangeBase,
  Change,
  BuiltinChange,
  TextChange,
  TextChangeOp,
  SequenceChange,
  SequenceChangeOp,
  MapChange,
  ReplaceChange,
  TreeChange,
  TreeChangeOp,
  IncrementChange,
} from "./change.js"

export {
  // Type guards
  isTextChange,
  isSequenceChange,
  isMapChange,
  isReplaceChange,
  isTreeChange,
  isIncrementChange,
  // Constructors
  textChange,
  sequenceChange,
  mapChange,
  replaceChange,
  treeChange,
  incrementChange,
} from "./change.js"

// Changefeed — the unified reactive protocol
export {
  CHANGEFEED,
  getOrCreateChangefeed,
  hasChangefeed,
  hasComposedChangefeed,
  staticChangefeed,
} from "./changefeed.js"
export type {
  Changeset,
  Changefeed,
  ComposedChangefeed,
  HasChangefeed,
  HasComposedChangefeed,
  TreeEvent,
} from "./changefeed.js"

// Step — pure state transitions: (State, Change) → State
export {
  step,
  stepText,
  stepSequence,
  stepMap,
  stepReplace,
  stepIncrement,
} from "./step.js"

// Zero — default values separated from the schema
export { Zero, scalarDefault } from "./zero.js"

// interpret — the generic catamorphism over the schema functor
export { interpret, createInterpreter } from "./interpret.js"
export type {
  Interpreter,
  InterpreterLayer,
  InterpretBuilder,
  Path,
  PathSegment,
  SumVariants,
} from "./interpret.js"

// Pre-built interpreter layers for fluent composition
export { readable, writable, changefeed } from "./layers.js"

// Guards — shared type-narrowing utilities
export { isNonNullObject, isPropertyHost } from "./guards.js"

// Store — shared utilities for reading/writing plain JS object stores
export {
  readByPath,
  writeByPath,
  applyChangeToStore,
  dispatchSum,
  pathKey,
} from "./store.js"
export type { Store } from "./store.js"

// Built-in interpreters
export { plainInterpreter } from "./interpreters/plain.js"

// Bottom interpreter — universal foundation and capability lattice
export {
  READ,
  makeCarrier,
  bottomInterpreter,
} from "./interpreters/bottom.js"
export type {
  HasRead,
  HasNavigation,
  HasCaching,
} from "./interpreters/bottom.js"

// withReadable — refinement transformer (reading + navigation, no caching)
export { withReadable } from "./interpreters/with-readable.js"

// withCaching — interposition transformer (identity-preserving caching + INVALIDATE)
export {
  withCaching,
  INVALIDATE,
  planCacheUpdate,
  applyCacheOps,
} from "./interpreters/with-caching.js"
export type { CacheOp } from "./interpreters/with-caching.js"

// Readable types — type-level interpretation for readable refs
// (The monolithic readableInterpreter is removed; use
// withCaching(withReadable(bottomInterpreter)) instead.)
export type {
  Readable,
  ReadableSequenceRef,
  ReadableMapRef,
} from "./interpreters/readable.js"
export {
  withWritable,
  createWritableContext,
  executeBatch,
  TRANSACT,
  hasTransact,
} from "./interpreters/writable.js"
export type {
  WritableContext,
  HasTransact,
  PendingChange,
  ScalarRef,
  TextRef,
  CounterRef,
  SequenceRef,
  ProductRef,
  WritableMapRef,
  Writable,
} from "./interpreters/writable.js"

// Shared interpreter types (canonical location)
export type { RefContext, Plain } from "./interpreter-types.js"

// Validate interpreter — schema-driven validation with collecting errors
export {
  validateInterpreter,
  validate,
  tryValidate,
  SchemaValidationError,
  formatPath,
} from "./interpreters/validate.js"
export type { ValidateContext } from "./interpreters/validate.js"

// Changefeed interpreter transformer — compositional observation layer
export {
  withChangefeed,
  attachChangefeed,
} from "./interpreters/with-changefeed.js"

// Interpreter composition combinators
export { product, overlay, firstDefined } from "./combinators.js"
export type { MergeFn } from "./combinators.js"
