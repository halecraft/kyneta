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
  staticChangefeed,
} from "./changefeed.js"
export type {
  Changefeed,
  HasChangefeed,
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
  Path,
  PathSegment,
  SumVariants,
} from "./interpret.js"

// Guards — shared type-narrowing utilities
export { isNonNullObject, isPropertyHost } from "./guards.js"

// Store — shared utilities for reading/writing plain JS object stores
export {
  readByPath,
  writeByPath,
  applyChangeToStore,
} from "./store.js"
export type { Store } from "./store.js"

// Built-in interpreters
export { plainInterpreter } from "./interpreters/plain.js"
export {
  readableInterpreter,
  INVALIDATE,
  SET_HANDLER,
  DELETE_HANDLER,
} from "./interpreters/readable.js"
export type {
  RefContext,
  Readable,
  ReadableSequenceRef,
} from "./interpreters/readable.js"
export {
  writableInterpreter,
  createWritableContext,
  flush,
} from "./interpreters/writable.js"
export type {
  WritableContext,
  WritableOptions,
  PendingChange,
  ScalarRef,
  TextRef,
  CounterRef,
  SequenceRef,
  Writable,
  Plain,
} from "./interpreters/writable.js"

// Validate interpreter — schema-driven validation with collecting errors
export {
  validateInterpreter,
  validate,
  tryValidate,
  SchemaValidationError,
  formatPath,
} from "./interpreters/validate.js"
export type { ValidateContext } from "./interpreters/validate.js"

// Changefeed decorator — observation layer via enrich(writableInterpreter, withChangefeed)
export {
  withChangefeed,
  createChangefeedContext,
  changefeedFlush,
  subscribeDeep,
} from "./interpreters/with-changefeed.js"
export type { ChangefeedContext, DeepEvent } from "./interpreters/with-changefeed.js"

// Deprecated aliases (backward compat) — prefer the new names above
export {
  withChangefeed as withFeed,
  createChangefeedContext as createFeedableContext,
  changefeedFlush as feedableFlush,
} from "./interpreters/with-changefeed.js"
/** @deprecated Use `ChangefeedContext` */
export type { ChangefeedContext as FeedableContext } from "./interpreters/with-changefeed.js"

// Interpreter composition combinators
export { enrich, product, overlay, firstDefined } from "./combinators.js"
export type { Decorator, MergeFn } from "./combinators.js"
