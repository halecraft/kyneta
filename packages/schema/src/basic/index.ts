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
export type { CommitOptions } from "../facade/batch.js"
// --- Change protocol (substrate-agnostic, re-exported for convenience) ---
export { applyChanges, batch } from "../facade/batch.js"

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
export type { DocRef, Ref, RRef } from "../ref.js"
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
export type { SubstratePayload } from "../substrate.js"
// --- Zero (default values) ---
export { Zero } from "../zero.js"

// --- Generic sync: exportEntirety (re-exported from @kyneta/schema) ---

export { exportEntirety } from "../sync.js"

// ---------------------------------------------------------------------------
// Construction (convenience wrappers over generic createDoc)
// ---------------------------------------------------------------------------

import type { Op } from "../changefeed.js"
import { createRef } from "../create-doc.js"
import type { PlainNativeMap } from "../native.js"
import { SUBSTRATE } from "../native.js"
import { RawPath } from "../path.js"
import type { DocRef } from "../ref.js"
import type { ProductSchema } from "../schema.js"
import type { SubstratePayload } from "../substrate.js"
import { PlainVersion, plainSubstrateFactory } from "../substrates/plain.js"

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
  const substrate = (doc as any)[SUBSTRATE]
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
  const substrate = (doc as any)[SUBSTRATE]
  if (!substrate) {
    throw new Error("delta() requires a root ref created by createDoc().")
  }
  const currentEpoch = (substrate.version() as PlainVersion).epoch
  const since = new PlainVersion(fromVersion, currentEpoch)
  const payload = substrate.exportSince(since)
  if (!payload) return []
  // Wire format is batched: SerializedOp[][] — one inner array per flush cycle.
  // Flatten to a single Op[] for the basic API consumer.
  const parsed = JSON.parse(payload.data as string)
  const batches = (
    parsed && typeof parsed === "object" && "b" in parsed ? parsed.b : parsed
  ) as Array<
    Array<{
      path: Array<{
        type: string
        field?: string
        entry?: string
        index?: number
      }>
      change: Op["change"]
    }>
  >
  const raw = batches.flat()
  return raw.map((op: (typeof raw)[number]) => ({
    path: op.path.reduce(
      (p: RawPath, seg) =>
        seg.type === "field"
          ? p.field(seg.field as any)
          : seg.type === "entry"
            ? p.entry(seg.entry as any)
            : p.item(seg.index as any),
      RawPath.empty,
    ),
    change: op.change,
  }))
}
