// stack — test shorthands for a document over a plain state the test holds.
//
// `contextOver(schema, store)` builds a plain substrate whose σ is `store`
// itself, so a test can seed it and read it back; a read freezes it in place,
// and a write may change it or, once frozen, replace its root. `refOver`
// makes the document's root ref over a context.

import type { PlainState } from "../reader.js"
import { createRootRef } from "../ref/create.js"
import type { Ref } from "../ref/schema-ref.js"
import type { Schema } from "../schema.js"
import {
  ALWAYS_AUTHOR,
  createPlainClock,
  createPlainSubstrate,
  EMPTY_HISTORY,
} from "../substrates/plain.js"
import type { WritableContext } from "../writable-context.js"

/** A writable context over a plain substrate whose σ is `store`. */
export function contextOver(
  schema: Schema,
  store: PlainState,
): WritableContext {
  return createPlainSubstrate(
    store,
    schema,
    createPlainClock("test"),
    EMPTY_HISTORY,
    ALWAYS_AUTHOR,
  ).context()
}

// Typed through a call signature, as `createDoc` is: `Ref<S>` over an
// abstract `S` in a function body exceeds the instantiation depth.
type RefOver = <S extends Schema>(schema: S, ctx: WritableContext) => Ref<S>
type DocOver = <S extends Schema>(schema: S, store: PlainState) => Ref<S>

/** The root ref of `schema` over `ctx`. */
export const refOver: RefOver = ((schema: Schema, ctx: WritableContext) =>
  createRootRef(ctx, schema)) as unknown as RefOver

/** The root ref of `schema` over a plain substrate whose σ is `store`. */
export const docOver: DocOver = ((schema: Schema, store: PlainState) => {
  return createRootRef(contextOver(schema, store), schema)
}) as unknown as DocOver

/** `refOver` for a schema whose type is not known: the ref is untyped. */
export function untypedRefOver(schema: Schema, ctx: WritableContext): any {
  return createRootRef(ctx, schema)
}

/** `docOver` for a schema whose type is not known: the ref is untyped. */
export function untypedDocOver(schema: Schema, store: PlainState): any {
  return untypedRefOver(schema, contextOver(schema, store))
}
