// create — batteries-included document construction backed by YjsSubstrate.
//
// Provides `createYjsDoc` and `createYjsDocFromSnapshot` functions that
// hide the interpret pipeline and layer composition behind a single call.
//
// Internally tracks substrates via a module-scoped WeakMap so that sync
// primitives (`version`, `exportSnapshot`, `importDelta` in sync.ts)
// can retrieve the substrate from just a doc ref.
//
// `getSubstrate` is exported for use by `sync.ts` but is NOT re-exported
// from the barrel (`index.ts`). It is an internal cross-module helper.
//
// Two forms for `createYjsDoc`:
//   createYjsDoc(schema, yjsDoc)    — "bring your own doc" (wrap existing)
//   createYjsDoc(schema)            — create a fresh empty Y.Doc

import { interpret, registerSubstrate } from "@kyneta/schema"
import { changefeed, readable, writable } from "@kyneta/schema"
import type { Ref } from "@kyneta/schema"
import type { Schema as SchemaType } from "@kyneta/schema"
import type { Substrate, SubstratePayload } from "@kyneta/schema"
import * as Y from "yjs"
import { YjsVersion } from "./version.js"
import { createYjsSubstrate, yjsSubstrateFactory } from "./substrate.js"

// ---------------------------------------------------------------------------
// Substrate tracking (module-scoped)
// ---------------------------------------------------------------------------

const substrates = new WeakMap<object, Substrate<YjsVersion>>()

/**
 * Retrieve the substrate associated with a doc created by `createYjsDoc`
 * or `createYjsDocFromSnapshot`.
 *
 * Exported for `sync.ts` — NOT re-exported from the barrel.
 *
 * @throws If `doc` was not created by `createYjsDoc` / `createYjsDocFromSnapshot`.
 */
export function getSubstrate(doc: object): Substrate<YjsVersion> {
  const s = substrates.get(doc)
  if (!s) {
    throw new Error(
      "version/exportSnapshot/importDelta called on an object without a YjsSubstrate. " +
        "Use a doc created by createYjsDoc() or createYjsDocFromSnapshot().",
    )
  }
  return s
}

// ---------------------------------------------------------------------------
// registerDoc — internal helper (interpret + WeakMap registration)
// ---------------------------------------------------------------------------

function registerDoc(
  schema: SchemaType,
  substrate: Substrate<YjsVersion>,
): any {
  // The `as any` on the builder avoids TS2589 — interpret's fluent API
  // produces deeply recursive types when S is the abstract SchemaType.
  // The public createYjsDoc/createYjsDocFromSnapshot signatures provide
  // the correct Ref<S> return type via interface call signature patterns.
  const doc: any = (interpret as any)(schema, substrate.context())
    .with(readable)
    .with(writable)
    .with(changefeed)
    .done()
  substrates.set(doc, substrate)
  // Also register in the general unwrap() registry so that the
  // yjs() escape hatch can discover the substrate from the ref.
  registerSubstrate(doc, substrate)
  return doc
}

// ---------------------------------------------------------------------------
// isYDoc — runtime check for Y.Doc
// ---------------------------------------------------------------------------

function isYDoc(value: unknown): value is Y.Doc {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    "getMap" in value &&
    "getText" in value &&
    "getArray" in value &&
    "transact" in value &&
    typeof (value as any).transact === "function" &&
    // Y.Doc has clientID; distinguish from other objects
    "clientID" in value &&
    typeof (value as any).clientID === "number"
  )
}

// ---------------------------------------------------------------------------
// createYjsDoc
// ---------------------------------------------------------------------------

// Interface call signature avoids TS2589 on Ref<S> when S is generic.

/**
 * Create a live Yjs-backed document.
 *
 * **Form 1 — bring your own doc:**
 * ```ts
 * const yjsDoc = new Y.Doc()
 * const doc = createYjsDoc(mySchema, yjsDoc)
 * ```
 *
 * **Form 2 — fresh empty doc:**
 * ```ts
 * const doc = createYjsDoc(mySchema)
 *
 * // Apply initial content via change():
 * change(doc, d => {
 *   d.title.insert(0, "Hello")
 *   d.items.push({ name: "First item" })
 * })
 * ```
 *
 * Returns a full-stack `Ref<S>` — callable, navigable, writable,
 * transactable, and observable. Backed by a `YjsSubstrate` with
 * CRDT collaboration support.
 *
 * The returned ref observes **all** mutations to the underlying Y.Doc,
 * regardless of source (local kyneta writes, importDelta, external
 * `Y.applyUpdate()`, external raw Yjs API mutations).
 *
 * @param schema - The schema describing the document structure.
 * @param doc - Optional `Y.Doc` instance to wrap. If omitted, a fresh
 *   empty Y.Doc is created with containers matching the schema.
 */
type CreateYjsDoc = <S extends SchemaType>(
  schema: S,
  doc?: Y.Doc,
) => Ref<S>

export const createYjsDoc: CreateYjsDoc = (schema, doc) => {
  if (doc !== undefined && isYDoc(doc)) {
    // Bring your own doc — wrap the existing Y.Doc
    return registerDoc(schema, createYjsSubstrate(doc, schema))
  }
  // Fresh empty doc
  return registerDoc(schema, yjsSubstrateFactory.create(schema))
}

// ---------------------------------------------------------------------------
// createYjsDocFromSnapshot
// ---------------------------------------------------------------------------

type CreateYjsDocFromSnapshot = <S extends SchemaType>(
  schema: S,
  payload: SubstratePayload,
) => Ref<S>

/**
 * Reconstruct a live Yjs-backed document from a substrate snapshot payload.
 *
 * The payload must have been produced by `exportSnapshot()` on a
 * compatible document. This is the entry point for SSR hydration
 * and reconnection past log compaction.
 *
 * ```ts
 * const payload = exportSnapshot(docA)
 * const docB = createYjsDocFromSnapshot(MySchema, payload)
 * // docB has the same state as docA at the time of export
 * ```
 */
export const createYjsDocFromSnapshot: CreateYjsDocFromSnapshot = (
  schema,
  payload,
) => registerDoc(schema, yjsSubstrateFactory.fromSnapshot(payload, schema))