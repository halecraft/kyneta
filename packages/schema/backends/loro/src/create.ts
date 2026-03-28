// create — batteries-included document construction backed by LoroSubstrate.
//
// Provides `createLoroDoc` and `createLoroDocFromSnapshot` functions that
// hide the interpret pipeline and layer composition behind a single call.
//
// Internally tracks substrates via a module-scoped WeakMap so that sync
// primitives (`version`, `exportSnapshot`, `importDelta` in sync.ts)
// can retrieve the substrate from just a doc ref.
//
// `getSubstrate` is exported for use by `sync.ts` but is NOT re-exported
// from the barrel (`index.ts`). It is an internal cross-module helper.
//
// Two forms for `createLoroDoc`:
//   createLoroDoc(schema, loroDoc)   — "bring your own doc" (wrap existing)
//   createLoroDoc(schema)            — create a fresh empty LoroDoc

import { interpret } from "@kyneta/schema"
import { changefeed, readable, writable } from "@kyneta/schema"
import type { Ref } from "@kyneta/schema"
import type { Schema as SchemaType } from "@kyneta/schema"
import type { Substrate, SubstratePayload } from "@kyneta/schema"
import type { LoroDoc } from "loro-crdt"
import { LoroVersion } from "./version.js"
import { createLoroSubstrate, loroSubstrateFactory } from "./substrate.js"

// ---------------------------------------------------------------------------
// Substrate tracking (module-scoped)
// ---------------------------------------------------------------------------

const substrates = new WeakMap<object, Substrate<LoroVersion>>()

/**
 * Retrieve the substrate associated with a doc created by `createLoroDoc`
 * or `createLoroDocFromSnapshot`.
 *
 * Exported for `sync.ts` — NOT re-exported from the barrel.
 *
 * @throws If `doc` was not created by `createLoroDoc` / `createLoroDocFromSnapshot`.
 */
export function getSubstrate(doc: object): Substrate<LoroVersion> {
  const s = substrates.get(doc)
  if (!s) {
    throw new Error(
      "version/exportSnapshot/importDelta called on an object without a LoroSubstrate. " +
        "Use a doc created by createLoroDoc() or createLoroDocFromSnapshot().",
    )
  }
  return s
}

// ---------------------------------------------------------------------------
// registerDoc — internal helper (interpret + WeakMap registration)
// ---------------------------------------------------------------------------

function registerDoc(
  schema: SchemaType,
  substrate: Substrate<LoroVersion>,
): any {
  // The `as any` on the builder avoids TS2589 — interpret's fluent API
  // produces deeply recursive types when S is the abstract SchemaType.
  // The public createLoroDoc/createLoroDocFromSnapshot signatures provide
  // the correct Ref<S> return type via interface call signature patterns.
  const doc: any = (interpret as any)(schema, substrate.context())
    .with(readable)
    .with(writable)
    .with(changefeed)
    .done()
  substrates.set(doc, substrate)
  return doc
}

// ---------------------------------------------------------------------------
// isLoroDoc — runtime check for LoroDoc
// ---------------------------------------------------------------------------

function isLoroDoc(value: unknown): value is LoroDoc {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    "getMap" in value &&
    "getText" in value &&
    "getList" in value &&
    "getCounter" in value &&
    "commit" in value &&
    "peerIdStr" in value &&
    typeof (value as any).commit === "function"
  )
}

// ---------------------------------------------------------------------------
// createLoroDoc
// ---------------------------------------------------------------------------

// Interface call signature avoids TS2589 on Ref<S> when S is generic.

/**
 * Create a live Loro-backed document.
 *
 * **Form 1 — bring your own doc:**
 * ```ts
 * const loroDoc = new LoroDoc()
 * const doc = createLoroDoc(mySchema, loroDoc)
 * ```
 *
 * **Form 2 — fresh empty doc:**
 * ```ts
 * const doc = createLoroDoc(mySchema)
 *
 * // Apply initial content via change():
 * change(doc, d => {
 *   d.title.insert(0, "Hello")
 *   d.items.push({ name: "First item" })
 * })
 * ```
 *
 * Returns a full-stack `Ref<S>` — callable, navigable, writable,
 * transactable, and observable. Backed by a `LoroSubstrate` with
 * CRDT collaboration support.
 *
 * The returned ref observes **all** mutations to the underlying LoroDoc,
 * regardless of source (local kyneta writes, importDelta, external
 * `doc.import()`, external raw Loro API mutations).
 *
 * @param schema - The schema describing the document structure.
 * @param doc - Optional `LoroDoc` instance to wrap. If omitted, a fresh
 *   empty LoroDoc is created with containers matching the schema.
 */
type CreateLoroDoc = <S extends SchemaType>(
  schema: S,
  doc?: LoroDoc,
) => Ref<S>

export const createLoroDoc: CreateLoroDoc = (schema, doc) => {
  if (doc !== undefined && isLoroDoc(doc)) {
    // Bring your own doc — wrap the existing LoroDoc
    return registerDoc(schema, createLoroSubstrate(doc, schema))
  }
  // Fresh empty doc
  return registerDoc(schema, loroSubstrateFactory.create(schema))
}

// ---------------------------------------------------------------------------
// createLoroDocFromSnapshot
// ---------------------------------------------------------------------------

type CreateLoroDocFromSnapshot = <S extends SchemaType>(
  schema: S,
  payload: SubstratePayload,
) => Ref<S>

/**
 * Reconstruct a live Loro-backed document from a substrate snapshot payload.
 *
 * The payload must have been produced by `exportSnapshot()` on a
 * compatible document. This is the entry point for SSR hydration
 * and reconnection past log compaction.
 *
 * ```ts
 * const payload = exportSnapshot(docA)
 * const docB = createLoroDocFromSnapshot(MySchema, payload)
 * // docB has the same state as docA at the time of export
 * ```
 */
export const createLoroDocFromSnapshot: CreateLoroDocFromSnapshot = (
  schema,
  payload,
) => registerDoc(schema, loroSubstrateFactory.fromSnapshot(payload, schema))