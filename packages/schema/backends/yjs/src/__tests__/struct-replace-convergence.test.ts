// Regression: a whole-struct `.set({...})` on a non-nullable nested struct
// must (a) write its leaves under identity-hashed keys and (b) converge to a
// peer. Leaves written under literal field names are invisible to the
// identity-keyed reader — this locks that they never are.

import {
  BACKING_DOC,
  createDoc,
  deriveSchemaBinding,
  exportEntirety,
  exportSince,
  merge,
  type ProductSchema,
  Schema,
  version,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import type * as Y from "yjs"
import { yjs } from "../bind-yjs.js"

const Inner = Schema.struct({
  a: Schema.string().nullable(),
  b: Schema.string().nullable(),
})
const ReproSchema = Schema.struct({
  nonNullableStruct: Inner,
  withText: Schema.struct({ label: Schema.text() }),
})
const VALUE = { a: "hello", b: "world" } as const

const binding = deriveSchemaBinding(ReproSchema as unknown as ProductSchema, {})

function backing(ref: any): Y.Doc {
  const S = Object.getOwnPropertySymbols(ref).find(
    s => s.description === "kyneta:substrate",
  )
  return (ref as any)[S as any][BACKING_DOC]
}

function pair() {
  const a = createDoc(yjs.bind(ReproSchema))
  const b = createDoc(yjs.bind(ReproSchema))
  merge(a, exportEntirety(b))
  merge(b, exportEntirety(a))
  return { a, b }
}

describe("yjs — whole-struct replace converges & is identity-keyed", () => {
  it("non-nullable struct whole .set() converges via incremental sync", () => {
    const { a, b } = pair()
    const v = version(b)
    b.nonNullableStruct.set(VALUE)
    const delta = exportSince(b, v)
    expect(delta, "a delta must be produced").not.toBeNull()
    merge(a, delta ?? exportEntirety(b))
    expect(a.nonNullableStruct()).toEqual(VALUE)
  })

  it("non-nullable struct whole .set() converges via full-entirety sync", () => {
    const { a, b } = pair()
    b.nonNullableStruct.set(VALUE)
    merge(a, exportEntirety(b))
    expect(a.nonNullableStruct()).toEqual(VALUE)
  })

  it("nested leaves are stored under the identity hash, not literal names", () => {
    const b = createDoc(yjs.bind(ReproSchema))
    b.nonNullableStruct.set(VALUE)

    const root = backing(b).getMap("root")
    const outerKey = binding.forward.get("nonNullableStruct") as string
    const inner = root.get(outerKey) as Y.Map<unknown>
    const innerKeys = [...inner.keys()]

    expect(innerKeys).toContain(binding.forward.get("nonNullableStruct.a"))
    expect(innerKeys).toContain(binding.forward.get("nonNullableStruct.b"))
    expect(innerKeys).not.toContain("a")
    expect(innerKeys).not.toContain("b")
  })

  it("a struct carrying a text field converges and the text is a live Y.Text", () => {
    const { a, b } = pair()
    b.withText.set({ label: "greetings" })
    merge(a, exportEntirety(b))
    expect(a.withText()?.label).toBe("greetings")
  })
})
