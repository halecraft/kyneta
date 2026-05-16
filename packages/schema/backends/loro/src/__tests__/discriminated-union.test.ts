// discriminated-union — integration tests for sums on the Loro substrate.

import type { Ref, SchemaNode, Substrate } from "@kyneta/schema"
import {
  change,
  interpret,
  observation,
  readable,
  Schema,
  writable,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { createDoc, loro, loroSubstrateFactory } from "../index.js"
import type { LoroVersion } from "../version.js"

// ===========================================================================
// Shared schemas
// ===========================================================================

const ContentSchema = Schema.discriminatedUnion("type", [
  Schema.struct({
    type: Schema.string("text" as const),
    body: Schema.string(),
  }),
  Schema.struct({
    type: Schema.string("image" as const),
    url: Schema.string(),
  }),
])

const DocSchema = Schema.struct({
  content: ContentSchema,
})

const ListDocSchema = Schema.struct({
  items: Schema.list(
    Schema.struct({
      label: Schema.string(),
      content: ContentSchema,
    }),
  ),
})

function interpretSubstrate<S extends SchemaNode>(
  schema: S,
  substrate: Substrate<LoroVersion>,
): Ref<S> {
  return interpret(schema, substrate.context())
    .with(readable)
    .with(writable)
    .with(observation)
    .done()
}

// ===========================================================================
// Tests
// ===========================================================================

describe("discriminated union on Loro substrate", () => {
  it("set, read discriminant, read variant field", () => {
    const doc = createDoc(loro.bind(DocSchema))
    change(doc, (d: any) => {
      d.content.set({ type: "text", body: "hello world" })
    })
    expect(doc.content.type).toBe("text")
    expect((doc.content as any).body()).toBe("hello world")
  })

  it("variant switch: .set() with different discriminant re-dispatches", () => {
    const doc = createDoc(loro.bind(DocSchema))

    change(doc, (d: any) => {
      d.content.set({ type: "text", body: "initial" })
    })
    expect(doc.content.type).toBe("text")
    expect((doc.content as any).body()).toBe("initial")

    change(doc, (d: any) => {
      d.content.set({ type: "image", url: "pic.png" })
    })

    expect(doc.content()).toEqual({ type: "image", url: "pic.png" })
    expect(doc.content.type).toBe("image")
    expect((doc.content as any).url()).toBe("pic.png")
  })

  it("variant switch in reverse direction (image → text)", () => {
    const doc = createDoc(loro.bind(DocSchema))

    change(doc, (d: any) => {
      d.content.set({ type: "image", url: "photo.jpg" })
    })
    expect(doc.content.type).toBe("image")

    change(doc, (d: any) => {
      d.content.set({ type: "text", body: "replaced" })
    })
    expect(doc.content.type).toBe("text")
    expect((doc.content as any).body()).toBe("replaced")
  })

  it("push struct containing discriminated union into list", () => {
    const doc = createDoc(loro.bind(ListDocSchema))
    change(doc, (d: any) => {
      d.items.push({
        label: "first",
        content: { type: "text", body: "hello" },
      })
    })
    const item = doc.items.at(0)
    expect(item).toBeDefined()
    expect((item as any).label()).toBe("first")
    expect((item as any).content.type).toBe("text")
    expect((item as any).content.body()).toBe("hello")
  })

  it("two-peer sync via delta", () => {
    const substrateA = loroSubstrateFactory.create(DocSchema)
    const docA = interpretSubstrate(DocSchema, substrateA)
    const substrateB = loroSubstrateFactory.create(DocSchema)
    const docB = interpretSubstrate(DocSchema, substrateB)

    substrateB.merge(substrateA.exportEntirety(), { origin: "sync" })
    const sinceVV = substrateB.version()

    change(docA, (d: any) => {
      d.content.set({ type: "image", url: "synced.png" })
    })

    const delta = substrateA.exportSince(sinceVV)
    expect(delta).toBeDefined()
    if (delta) substrateB.merge(delta, { origin: "sync" })

    expect(docB.content.type).toBe("image")
    expect((docB.content as any).url()).toBe("synced.png")
  })
})

describe("nullable sum on Loro substrate", () => {
  it("set and null round-trip", () => {
    const doc = createDoc(
      loro.bind(Schema.struct({ bio: Schema.string().nullable() })),
    )

    change(doc, d => d.bio.set("hello"))
    expect(doc.bio()).toBe("hello")

    change(doc, d => d.bio.set(null))
    expect(doc.bio()).toBe(null)
  })
})
