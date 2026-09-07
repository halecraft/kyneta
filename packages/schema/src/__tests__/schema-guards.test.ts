// schema-guards — narrowing the `Schema` union by its `[KIND]` discriminant.
//
// `Schema` is a discriminated union, exactly as `ChangeBase` is. The change
// guards (`isMapChange` and siblings in `change.ts`) have always existed; the
// schema ones did not, so code that needed a schema's `.fields` or `.item`
// reached them with `(s as any).fields`.
//
// That cast does more than get the property. It stops checking that `s` is a
// schema at all, and it makes the result `any` — so a typo in the property
// name, or using the result as the wrong type, compiles cleanly. The
// `expectTypeOf` blocks below are the half of this that matters: a guard
// declared `schema is any` would pass every runtime assertion here.

import { describe, expect, expectTypeOf, it } from "vitest"
import {
  isCounterSchema,
  isMapSchema,
  isMovableSchema,
  isProductSchema,
  isRichTextSchema,
  isScalarSchema,
  isSequenceSchema,
  isSetSchema,
  isTextSchema,
  isTreeSchema,
  KIND,
  type MapSchema,
  type ProductSchema,
  Schema as S,
  type Schema,
  type SequenceSchema,
} from "../schema.js"

// One schema per kind, so the exhaustiveness table below is real rather than
// a spot check.
const samples: ReadonlyArray<readonly [string, Schema]> = [
  ["scalar", S.string()],
  ["product", S.struct({ a: S.number() })],
  ["sequence", S.list(S.number())],
  ["map", S.record(S.number())],
  ["set", S.set(S.string())],
  ["tree", S.tree(S.struct({ a: S.number() }))],
  ["movable", S.movableList(S.number())],
  ["text", S.text()],
  ["counter", S.counter()],
  ["richtext", S.richText({ bold: { expand: "after" } })],
]

const guardsByKind: Readonly<Record<string, (s: Schema) => boolean>> = {
  scalar: isScalarSchema,
  product: isProductSchema,
  sequence: isSequenceSchema,
  map: isMapSchema,
  set: isSetSchema,
  tree: isTreeSchema,
  movable: isMovableSchema,
  text: isTextSchema,
  counter: isCounterSchema,
  richtext: isRichTextSchema,
}

describe("each guard accepts exactly its own kind", () => {
  for (const [kind, schema] of samples) {
    it(`recognises ${kind} and nothing else`, () => {
      for (const [otherKind, guard] of Object.entries(guardsByKind)) {
        expect(guard(schema)).toBe(otherKind === kind)
      }
    })
  }

  it("covers every kind the samples produce", () => {
    // Guards against a kind being added to the union with no guard beside it:
    // the sample list would grow and this would fail.
    for (const [kind, schema] of samples) {
      expect(schema[KIND]).toBe(kind)
      expect(guardsByKind[kind]).toBeTypeOf("function")
    }
  })
})

describe("narrowing", () => {
  // These use direct assignment rather than `toEqualTypeOf`. The `Schema`
  // union is recursive and its members differ structurally, which defeats
  // deep structural comparison — but assignment proves the same thing: the
  // line only compiles if the guard narrowed to exactly that member.
  //
  // `not.toBeAny()` is the companion check, and the one that catches the
  // failure mode worth catching. A guard declared `schema is any` would make
  // every assignment below compile and every runtime test above pass.

  it("isProductSchema narrows to ProductSchema and types its fields", () => {
    const schema: Schema = S.struct({ a: S.number() })
    if (isProductSchema(schema)) {
      const narrowed: ProductSchema = schema
      expectTypeOf(narrowed).not.toBeAny()
      // The property the casts were reaching for, now typed.
      expectTypeOf(narrowed.fields).not.toBeAny()
      const fields: Record<string, Schema> = narrowed.fields
      expectTypeOf(fields).not.toBeAny()
    }
  })

  it("isSequenceSchema and isMapSchema narrow to types carrying item", () => {
    const seq: Schema = S.list(S.number())
    if (isSequenceSchema(seq)) {
      const narrowed: SequenceSchema = seq
      const item: Schema = narrowed.item
      expectTypeOf(item).not.toBeAny()
    }
    const map: Schema = S.record(S.number())
    if (isMapSchema(map)) {
      const narrowed: MapSchema = map
      const item: Schema = narrowed.item
      expectTypeOf(item).not.toBeAny()
    }
  })

  it("leaves the schema unnarrowed on the false branch", () => {
    const schema: Schema = S.string()
    if (!isProductSchema(schema)) {
      // Still the whole union: assignable back to `Schema`, and not `any`.
      const stillUnion: Schema = schema
      expectTypeOf(stillUnion).not.toBeAny()
    }
  })
})
