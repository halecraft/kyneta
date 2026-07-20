// Regression: a whole-struct `.set({...})` on a non-nullable nested struct
// must converge to a peer on Loro. Storing the struct as a plain blob, or
// keying its fields literally, leaves it unresolvable by the identity-keyed
// reader — this locks the container-level identity keying.

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
import type { LoroDoc, LoroMap } from "loro-crdt"
import { describe, expect, it } from "vitest"
import { loro } from "../bind-loro.js"

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

function nativeDoc(ref: any): LoroDoc {
  const S = Object.getOwnPropertySymbols(ref).find(
    s => s.description === "kyneta:substrate",
  )
  return (ref as any)[S as any][BACKING_DOC]
}

function pair() {
  const a = createDoc(loro.bind(ReproSchema))
  const b = createDoc(loro.bind(ReproSchema))
  merge(a, exportEntirety(b))
  merge(b, exportEntirety(a))
  return { a, b }
}

describe("loro — whole-struct replace converges & is identity-keyed", () => {
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
    const b = createDoc(loro.bind(ReproSchema))
    b.nonNullableStruct.set(VALUE)

    const doc = nativeDoc(b)
    // A root-level product field is its own top-level container (doc.getMap(id)),
    // not a _props entry.
    const outerKey = binding.forward.get("nonNullableStruct") as string
    const inner = doc.getMap(outerKey) as LoroMap
    const innerKeys = [...inner.keys()]
    expect(innerKeys).toContain(binding.forward.get("nonNullableStruct.a"))
    expect(innerKeys).not.toContain("a")
    expect(innerKeys).not.toContain("b")
  })

  it("a struct carrying a text field converges", () => {
    const { a, b } = pair()
    b.withText.set({ label: "greetings" })
    merge(a, exportEntirety(b))
    expect(a.withText()?.label).toBe("greetings")
  })
})
