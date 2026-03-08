// @loro-extended/schema — pure structure, pluggable interpretations
//
// This barrel re-exports the three core modules that make up the
// schema interpreter algebra spike.

// Schema — unified recursive grammar
export { Schema, structuralKind, isAnnotated, unwrapAnnotation } from "./schema.js"
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
  // Scalar kinds
  ScalarKind,
} from "./schema.js"

// Action types — the universal currency of change
export type {
  ActionBase,
  Action,
  BuiltinAction,
  TextAction,
  TextActionOp,
  SequenceAction,
  SequenceActionOp,
  MapAction,
  ReplaceAction,
  TreeAction,
  TreeActionOp,
  IncrementAction,
} from "./action.js"

export {
  // Type guards
  isTextAction,
  isSequenceAction,
  isMapAction,
  isReplaceAction,
  isTreeAction,
  isIncrementAction,
  // Constructors
  textAction,
  sequenceAction,
  mapAction,
  replaceAction,
  treeAction,
  incrementAction,
} from "./action.js"

// Feed — the unified reactive protocol
export { FEED, getOrCreateFeed, isFeedable, staticFeed } from "./feed.js"
export type { Feed, Feedable } from "./feed.js"

// step — pure state transitions: (State, Action) → State
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
export type { Interpreter, Path, PathSegment, SumVariants } from "./interpret.js"

// Built-in interpreters
export { plainInterpreter } from "./interpreters/plain.js"
export { zeroInterpreter } from "./interpreters/zero.js"
export {
  writableInterpreter,
  createWritableContext,
  flush,
} from "./interpreters/writable.js"
export type {
  WritableContext,
  WritableOptions,
  PendingAction,
  Store,
  ScalarRef,
  TextRef,
  CounterRef,
  SequenceRef,
} from "./interpreters/writable.js"