// materialize — Tests for materializeYjsShadow.
//
// Validates that the Yjs→PlainState materialization produces correct
// plain JS objects for all supported schema types: text, scalar,
// sequence, nested struct, and empty documents.
//
// Yjs does not support counter, tree, or movableList — those are skipped.

import type { ProductSchema, SchemaBinding } from "@kyneta/schema"
import {
  BACKING_DOC,
  batch,
  createDoc,
  deriveSchemaBinding,
  KIND,
  RawPath,
  Schema,
  type SchemaNode,
  SUBSTRATE,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import type * as Y from "yjs"
import { yjs } from "../bind-yjs.js"
import { createYjsResolver, materializeYjsShadow } from "../materialize.js"

// ===========================================================================
// Helpers
// ===========================================================================

function trivialBinding(schema: SchemaNode): SchemaBinding {
  if (schema[KIND] === "product") {
    return deriveSchemaBinding(schema as ProductSchema, {})
  }
  return { forward: new Map(), inverse: new Map() }
}

function getYDoc(docRef: unknown): Y.Doc {
  const substrate = (docRef as any)[SUBSTRATE]
  return (substrate as any)[BACKING_DOC] as Y.Doc
}

// ===========================================================================
// Test schemas
// ===========================================================================

const TextSchema = Schema.struct({
  title: Schema.text(),
})

const ScalarSchema = Schema.struct({
  name: Schema.string(),
  age: Schema.number(),
  active: Schema.boolean(),
})

const SequenceSchema = Schema.struct({
  items: Schema.list(Schema.string()),
})

const NestedSchema = Schema.struct({
  meta: Schema.struct({
    author: Schema.string(),
    version: Schema.number(),
  }),
})

const FullSchema = Schema.struct({
  title: Schema.text(),
  theme: Schema.string(),
  tags: Schema.list(Schema.string()),
  settings: Schema.struct({
    darkMode: Schema.boolean(),
    fontSize: Schema.number(),
  }),
})

// ===========================================================================
// Tests
// ===========================================================================

describe("materializeYjsShadow", () => {
  it("materializes text fields", () => {
    const doc = createDoc(yjs.bind(TextSchema))
    batch(doc, (d: any) => {
      d.title.insert(0, "hello")
    })

    const yDoc = getYDoc(doc)
    const binding = trivialBinding(TextSchema)
    const result = materializeYjsShadow(yDoc, TextSchema, binding)

    expect(result).toEqual({ title: "hello" })
  })

  it("materializes scalar fields", () => {
    const doc = createDoc(yjs.bind(ScalarSchema))
    batch(doc, (d: any) => {
      d.name.set("Alice")
      d.age.set(30)
      d.active.set(true)
    })

    const yDoc = getYDoc(doc)
    const binding = trivialBinding(ScalarSchema)
    const result = materializeYjsShadow(yDoc, ScalarSchema, binding)

    expect(result).toEqual({ name: "Alice", age: 30, active: true })
  })

  it("materializes sequence fields", () => {
    const doc = createDoc(yjs.bind(SequenceSchema))
    // Separate batch() calls for list pushes to preserve order
    // (Yjs reverses order within a single transaction)
    batch(doc, (d: any) => d.items.push("alpha"))
    batch(doc, (d: any) => d.items.push("beta"))
    batch(doc, (d: any) => d.items.push("gamma"))

    const yDoc = getYDoc(doc)
    const binding = trivialBinding(SequenceSchema)
    const result = materializeYjsShadow(yDoc, SequenceSchema, binding)

    expect(result).toEqual({ items: ["alpha", "beta", "gamma"] })
  })

  it("materializes nested struct fields", () => {
    const doc = createDoc(yjs.bind(NestedSchema))
    batch(doc, (d: any) => {
      d.meta.author.set("Bob")
      d.meta.version.set(42)
    })

    const yDoc = getYDoc(doc)
    const binding = trivialBinding(NestedSchema)
    const result = materializeYjsShadow(yDoc, NestedSchema, binding)

    expect(result).toEqual({
      meta: { author: "Bob", version: 42 },
    })
  })

  it("materializes empty document to structural zeros", () => {
    const doc = createDoc(yjs.bind(FullSchema))

    const yDoc = getYDoc(doc)
    const binding = trivialBinding(FullSchema)
    const result = materializeYjsShadow(yDoc, FullSchema, binding)

    expect(result).toEqual({
      title: "",
      theme: "",
      tags: [],
      settings: { darkMode: false, fontSize: 0 },
    })
  })

  it("uses raw field names, not identity hashes", () => {
    const doc = createDoc(yjs.bind(TextSchema))
    batch(doc, (d: any) => {
      d.title.insert(0, "test")
    })

    const yDoc = getYDoc(doc)
    const binding = trivialBinding(TextSchema)
    const result = materializeYjsShadow(yDoc, TextSchema, binding)

    // Keys should be the raw field name "title", not an identity hash
    const keys = Object.keys(result as Record<string, unknown>)
    expect(keys).toContain("title")
    expect(keys).toHaveLength(1)
    // No key should look like a hash (long alphanumeric string)
    for (const key of keys) {
      expect(key).toBe("title")
    }
  })

  it("materializes a complex document with multiple field types", () => {
    const doc = createDoc(yjs.bind(FullSchema))

    batch(doc, (d: any) => {
      d.title.insert(0, "My Doc")
      d.theme.set("dark")
      d.settings.darkMode.set(true)
      d.settings.fontSize.set(16)
    })
    batch(doc, (d: any) => d.tags.push("important"))
    batch(doc, (d: any) => d.tags.push("urgent"))

    const yDoc = getYDoc(doc)
    const binding = trivialBinding(FullSchema)
    const result = materializeYjsShadow(yDoc, FullSchema, binding)

    expect(result).toEqual({
      title: "My Doc",
      theme: "dark",
      tags: ["important", "urgent"],
      settings: { darkMode: true, fontSize: 16 },
    })
  })

  it("materializes without binding (undefined binding)", () => {
    const doc = createDoc(yjs.bind(TextSchema))
    batch(doc, (d: any) => {
      d.title.insert(0, "no binding")
    })

    const yDoc = getYDoc(doc)
    // Pass no binding — materialize should still work
    const result = materializeYjsShadow(yDoc, TextSchema)

    // Without binding, keys may be identity hashes — but the values
    // should still be correct and the result should be an object.
    expect(result).toBeDefined()
    expect(typeof result).toBe("object")
  })

  it("nested nullable materializes to null on fresh doc", () => {
    const schema = Schema.struct({
      settings: Schema.struct({
        theme: Schema.string().nullable(),
      }),
    })
    const doc = createDoc(yjs.bind(schema))
    const yDoc = getYDoc(doc)
    const binding = trivialBinding(schema)
    const result = materializeYjsShadow(yDoc, schema, binding)
    expect(result).toEqual({ settings: { theme: null } })
  })
})

describe("createYjsResolver.resolveHasKey", () => {
  it("agrees with resolveKeys, for a record and a .json() record", () => {
    const schema = Schema.struct({
      peers: Schema.record(Schema.number()),
      blob: Schema.record.json(Schema.number()),
    })
    const doc: any = createDoc(yjs.bind(schema))
    batch(doc, (d: any) => {
      d.peers.set("alice", 1)
      d.peers.set("bob", 2)
      d.blob.set("carol", 3)
    })
    batch(doc, (d: any) => d.peers.delete("bob"))

    const resolver = createYjsResolver(
      getYDoc(doc).getMap("root"),
      schema,
      trivialBinding(schema),
    )
    for (const field of ["peers", "blob"]) {
      const path = RawPath.empty.field(field)
      for (const key of ["alice", "bob", "carol", "never"]) {
        expect(resolver.resolveHasKey(path, key)).toBe(
          resolver.resolveKeys(path).includes(key),
        )
      }
    }
    expect(resolver.resolveHasKey(RawPath.empty.field("peers"), "alice")).toBe(
      true,
    )
    expect(resolver.resolveHasKey(RawPath.empty.field("peers"), "bob")).toBe(
      false,
    )
  })
})
