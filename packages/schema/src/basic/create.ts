// basic/create — document construction backed by PlainSubstrate.
//
// Provides the batteries-included `createDoc` and `createDocFromEntirety`
// functions. Internally tracks substrates via a module-scoped WeakMap so
// that sync primitives (`version`, `delta`, `exportEntirety` in sync.ts)
// can retrieve the substrate from just a doc ref.
//
// `getSubstrate` is exported for use by `sync.ts` but is NOT re-exported
// from the barrel (`basic/index.ts`). It is an internal cross-module helper.

import { interpret } from "../interpret.js"
import { changefeed, readable, writable } from "../layers.js"
import type { Ref } from "../ref.js"
import type { Schema as SchemaType } from "../schema.js"
import type { Substrate, SubstratePayload } from "../substrate.js"
import type { PlainVersion } from "../substrates/plain.js"
import { plainSubstrateFactory } from "../substrates/plain.js"

// ---------------------------------------------------------------------------
// Substrate tracking (module-scoped)
// ---------------------------------------------------------------------------

const substrates = new WeakMap<object, Substrate<PlainVersion>>()

/**
 * Retrieve the substrate associated with a doc created by `createDoc`
 * or `createDocFromEntirety`.
 *
 * Exported for `sync.ts` — NOT re-exported from the barrel.
 *
 * @throws If `doc` was not created by `createDoc` or `createDocFromEntirety`.
 */
export function getSubstrate(doc: object): Substrate<PlainVersion> {
  const s = substrates.get(doc)
  if (!s) {
    throw new Error(
      "version/delta/exportEntirety called on an object without a substrate. " +
        "Use a doc created by createDoc() or createDocFromEntirety().",
    )
  }
  return s
}

// ---------------------------------------------------------------------------
// registerDoc — internal helper (interpret + WeakMap registration)
// ---------------------------------------------------------------------------

function registerDoc(
  schema: SchemaType,
  substrate: Substrate<PlainVersion>,
): any {
  // The `as any` on the builder avoids TS2589 — interpret's fluent API
  // produces deeply recursive types when S is the abstract SchemaType.
  // The public createDoc/createDocFromEntirety signatures provide the
  // correct Ref<S> return type via interface call signature patterns.
  const doc: any = (interpret as any)(schema, substrate.context())
    .with(readable)
    .with(writable)
    .with(changefeed)
    .done()
  substrates.set(doc, substrate)
  return doc
}

// ---------------------------------------------------------------------------
// createDoc
// ---------------------------------------------------------------------------

// Interface call signature avoids TS2589 on Ref<S> when S is generic.
type CreateDoc = <S extends SchemaType>(schema: S) => Ref<S>

/**
 * Create a live document from a schema.
 *
 * Returns a full-stack `Ref<S>` — callable, navigable, writable,
 * transactable, and observable. Backed by a `PlainSubstrate` (plain
 * JS object store with version tracking).
 *
 * The store starts with `Zero.structural` defaults (empty strings,
 * 0, false, empty arrays). To set initial content, use `change()`
 * after construction:
 *
 * ```ts
 * const doc = createDoc(Schema.doc({
 *   title: Schema.string(),
 *   count: Schema.number(),
 * }))
 *
 * doc.title()           // "" (Zero default)
 * doc.count()           // 0 (Zero default)
 *
 * change(doc, d => {
 *   d.title.set("Hello")
 *   d.count.set(42)
 * })
 * ```
 *
 * @param schema - The schema describing the document structure.
 */
export const createDoc: CreateDoc = schema =>
  registerDoc(schema, plainSubstrateFactory.create(schema))

// ---------------------------------------------------------------------------
// createDocFromEntirety
// ---------------------------------------------------------------------------

type CreateDocFromEntirety = <S extends SchemaType>(
  schema: S,
  payload: SubstratePayload,
) => Ref<S>

/**
 * Reconstruct a live document from a substrate entirety payload.
 *
 * The payload must have been produced by `exportEntirety()` on a
 * compatible document. This is the entry point for SSR hydration
 * and reconnection past log compaction.
 *
 * ```ts
 * const payload = exportEntirety(docA)
 * const docB = createDocFromEntirety(MySchema, payload)
 * // docB has the same state as docA at the time of export
 * ```
 */
export const createDocFromEntirety: CreateDocFromEntirety = (schema, payload) =>
  registerDoc(schema, plainSubstrateFactory.fromEntirety(payload, schema))
