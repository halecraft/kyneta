// @kyneta/schema/basic — batteries-included document API.
//
// Everything an app developer needs in one import:
//   Schema definition, document construction, mutation, observation, sync.
//
// This is a thin convenience wrapper over the generic @kyneta/schema API.
// `createDoc(schema)` is sugar for `genericCreateDoc(json.bind(schema))`.

export type { Changeset } from "@kyneta/changefeed"
export type { Op } from "../changefeed.js"
// --- Describe (human-readable schema view) ---
export { describe } from "../describe.js"
// --- Change protocol (substrate-agnostic, re-exported for convenience) ---
export { applyChanges, batch } from "../facade/batch.js"
// --- Observation protocol (substrate-agnostic, re-exported for convenience) ---
export { subscribe, subscribeNode } from "../facade/observe.js"
// --- Validation ---
export {
  SchemaValidationError,
  tryValidate,
  validate,
} from "../interpreters/validate.js"
// --- Zero (default values) ---
export { Zero } from "../interpreters/zero.js"
export type { Plain } from "../plain-types.js"
// --- Types ---
export type { DocRef, Ref, RRef } from "../ref/schema-ref.js"
export type {
  CounterSchema,
  MapSchema,
  MovableSequenceSchema,
  ProductSchema,
  ScalarSchema,
  Schema as SchemaNode,
  SequenceSchema,
  SetSchema,
  TextSchema,
  TreeSchema,
} from "../schema.js"
// --- Schema definition ---
export { Schema } from "../schema.js"
export type { CommitOptions, SubstratePayload } from "../substrate.js"

// --- Generic sync: exportEntirety (re-exported from @kyneta/schema) ---

export { exportEntirety } from "../sync.js"

// ---------------------------------------------------------------------------
// Construction (convenience wrappers over generic createDoc)
// ---------------------------------------------------------------------------

import type { Op } from "../changefeed.js"
import { createRef } from "../create-doc.js"
import type { PlainNativeMap } from "../native.js"
import { hasSubstrate, SUBSTRATE } from "../native.js"
import type { DocRef } from "../ref/schema-ref.js"
import type { ProductSchema } from "../schema.js"
import type { SubstratePayload } from "../substrate.js"
import {
  decodePlainPayload,
  objectToReplaceOps,
  PlainVersion,
  plainSubstrateFactory,
} from "../substrates/plain.js"

// Interface call signature avoids TS2589 on the deep ref type when S is
// generic (the `as CreateDoc` cast defers evaluation to concrete call sites).
//
// Returns the precise `DocRef<S, PlainNativeMap>`: the basic API always backs
// documents with the plain substrate, so the root native is `PlainState`.
// `unwrap(createDoc(schema))` → `PlainState` (the backing JS object), and
// `unwrap(doc.nestedStruct)` → `undefined` (plain has no per-node container).
// This matches the generic `createDoc` in `create-doc.ts` and runtime.
type CreateDoc = <S extends ProductSchema>(
  schema: S,
) => DocRef<S, PlainNativeMap>

/**
 * Create a live document from a schema.
 *
 * Convenience wrapper: `createDoc(schema)` is equivalent to
 * `genericCreateDoc(json.bind(schema))`.
 */
export const createDoc: CreateDoc = (schema =>
  createRef(schema, plainSubstrateFactory.create(schema))) as CreateDoc

type CreateDocFromEntirety = <S extends ProductSchema>(
  schema: S,
  payload: SubstratePayload,
) => DocRef<S, PlainNativeMap>

/**
 * Reconstruct a live document from a substrate entirety payload.
 *
 * Convenience wrapper: `createDocFromEntirety(schema, payload)` is equivalent to
 * `genericCreateDoc(json.bind(schema), payload)`.
 */
export const createDocFromEntirety: CreateDocFromEntirety = ((
  schema,
  payload,
) =>
  createRef(
    schema,
    plainSubstrateFactory.fromEntirety(payload, schema),
  )) as CreateDocFromEntirety

// ---------------------------------------------------------------------------
// version — plain-substrate convenience returning a plain integer
// ---------------------------------------------------------------------------

/**
 * Current version — monotonic integer, increments on each flush cycle
 * that produces at least one Op.
 *
 * This is a plain-substrate convenience that unwraps `PlainVersion.value`.
 * For the generic (substrate-agnostic) version, use `sync.version()`.
 *
 * @param doc - A document created by `createDoc` or `createDocFromEntirety`.
 * @throws If `doc` was not created by `createDoc` / `createDocFromEntirety`.
 */
export function version(doc: object): number {
  // `PlainVersion` is an assertion, not a check — the guard can only see that
  // the slot exists. Both functions here are documented as plain-substrate
  // conveniences, so naming the version type once here is what lets the rest
  // of the body read `.value` and `.lineage` without casting for it.
  const substrate = hasSubstrate<PlainVersion>(doc) ? doc[SUBSTRATE] : undefined
  if (!substrate) {
    throw new Error("version() requires a root ref created by createDoc().")
  }
  return substrate.version().value
}

// ---------------------------------------------------------------------------
// delta — plain-substrate-specific op extraction
// ---------------------------------------------------------------------------

/**
 * All ops applied since `fromVersion`. Returns `[]` if already up to date.
 *
 * This is a plain-substrate-specific function (not available for Loro/Yjs).
 * Plain substrates encode deltas as JSON-serialized Op batches.
 *
 * @param doc - A document created by `createDoc` or `createDocFromEntirety`.
 * @param fromVersion - The version to diff from (inclusive lower bound).
 * @returns The ops applied between `fromVersion` and the current version.
 * @throws If `doc` was not created by `createDoc` / `createDocFromEntirety`.
 */
export function delta(doc: object, fromVersion: number): Op[] {
  // Plain-substrate specific — see the note in `version` above.
  const substrate = hasSubstrate<PlainVersion>(doc) ? doc[SUBSTRATE] : undefined
  if (!substrate) {
    throw new Error("delta() requires a root ref created by createDoc().")
  }
  const currentLineage = substrate.version().lineage
  const since = new PlainVersion(fromVersion, currentLineage)
  const payload = substrate.exportSince(since)
  if (!payload) return []
  const decoded = decodePlainPayload(payload, "delta")
  // The payload is batched, one batch per flush cycle; the basic API hands
  // back one flat list. A cursor the log cannot continue from is answered
  // with the whole document, which as ops is one replace per field.
  return decoded.kind === "since"
    ? decoded.batches.flat()
    : objectToReplaceOps(decoded.state)
}
