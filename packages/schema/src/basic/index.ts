// @kyneta/schema/basic — batteries-included document API.
//
// Everything an app developer needs in one import:
//   Schema definition, document construction, mutation, observation, sync.
//
// Backed by PlainSubstrate (plain JS object store with version tracking).
// For the composable interpreter toolkit, import from "@kyneta/schema".

export type { Changeset, Op } from "../changefeed.js"
// --- Describe (human-readable schema view) ---
export { describe } from "../describe.js"
export type { ApplyChangesOptions } from "../facade/change.js"
// --- Change protocol (substrate-agnostic, re-exported for convenience) ---
export { applyChanges, change } from "../facade/change.js"

// --- Observation protocol (substrate-agnostic, re-exported for convenience) ---
export { subscribe, subscribeNode } from "../facade/observe.js"
export type { Plain } from "../interpreter-types.js"

// --- Validation ---
export {
  SchemaValidationError,
  tryValidate,
  validate,
} from "../interpreters/validate.js"
// --- Types ---
export type { Ref, RRef } from "../ref.js"
export type {
  AnnotatedSchema,
  MapSchema,
  ProductSchema,
  ScalarSchema,
  Schema as SchemaNode,
  SequenceSchema,
} from "../schema.js"
// --- Schema definition ---
export { Schema } from "../schema.js"
export type { SubstratePayload } from "../substrate.js"
// --- Zero (default values) ---
export { Zero } from "../zero.js"
// --- Construction (PlainSubstrate-backed) ---
export { createDoc, createDocFromEntirety } from "./create.js"
// --- Sync primitives (PlainSubstrate-specific) ---
export { delta, exportEntirety, version } from "./sync.js"