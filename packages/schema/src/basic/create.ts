// basic/create — document construction backed by PlainSubstrate.
//
// Provides the batteries-included `createDoc` and `createDocFromSnapshot`
// functions. Internally tracks substrates via a module-scoped WeakMap so
// that sync primitives (`version`, `delta`, `exportSnapshot` in sync.ts)
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
 * or `createDocFromSnapshot`.
 *
 * Exported for `sync.ts` — NOT re-exported from the barrel.
 *
 * @throws If `doc` was not created by `createDoc` or `createDocFromSnapshot`.
 */
export function getSubstrate(doc: object): Substrate<PlainVersion> {
  const s = substrates.get(doc)
  if (!s) {
    throw new Error(
      "version/delta/exportSnapshot called on an object without a substrate. " +
        "Use a doc created by createDoc() or createDocFromSnapshot().",
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
  // The public createDoc/createDocFromSnapshot signatures provide the
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
// Seed is Record<string, unknown> for the same reason — use
// `satisfies Seed<typeof MySchema>` at call sites for type safety.
type CreateDoc = <S extends SchemaType>(
  schema: S,
  seed?: Record<string, unknown>,
) => Ref<S>

/**
 * Create a live document from a schema and optional seed data.
 *
 * Returns a full-stack `Ref<S>` — callable, navigable, writable,
 * transactable, and observable. Backed by a `PlainSubstrate` (plain
 * JS object store with version tracking).
 *
 * ```ts
 * const doc = createDoc(Schema.doc({
 *   title: Schema.string(),
 *   count: Schema.number(),
 * }), { title: "Hello" })
 *
 * doc.title()           // "Hello"
 * doc.count()           // 0 (Zero default)
 * doc.title.set("Hi")   // mutate
 * ```
 *
 * @param schema - The schema describing the document structure.
 * @param seed - Optional partial initial values. Missing fields use
 *   `Zero.structural` defaults. Use `satisfies Seed<typeof MySchema>`
 *   at call sites for type-safe seeds.
 */
export const createDoc: CreateDoc = (schema, seed = {}) =>
  registerDoc(schema, plainSubstrateFactory.create(schema, seed))

// ---------------------------------------------------------------------------
// createDocFromSnapshot
// ---------------------------------------------------------------------------

type CreateDocFromSnapshot = <S extends SchemaType>(
  schema: S,
  payload: SubstratePayload,
) => Ref<S>

/**
 * Reconstruct a live document from a substrate snapshot payload.
 *
 * The payload must have been produced by `exportSnapshot()` on a
 * compatible document. This is the entry point for SSR hydration
 * and reconnection past log compaction.
 *
 * ```ts
 * const payload = exportSnapshot(docA)
 * const docB = createDocFromSnapshot(MySchema, payload)
 * // docB has the same state as docA at the time of export
 * ```
 */
export const createDocFromSnapshot: CreateDocFromSnapshot = (schema, payload) =>
  registerDoc(schema, plainSubstrateFactory.fromSnapshot(payload, schema))
