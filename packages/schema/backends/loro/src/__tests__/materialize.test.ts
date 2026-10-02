// materialize — Tests for materializeLoroShadow.
//
// Validates that the Loro→PlainState materialization produces correct
// plain JS objects for all schema types: text, counter, scalar,
// sequence, nested struct, and empty documents.

import type {
  ProductSchema,
  Ref,
  SchemaBinding,
  Substrate,
} from "@kyneta/schema"
import {
  BACKING_DOC,
  batch,
  createRef,
  deriveSchemaBinding,
  KIND,
  RawPath,
  Schema,
  type SchemaNode,
} from "@kyneta/schema"
import type { LoroDoc } from "loro-crdt"
import { describe, expect, it } from "vitest"
import { type LoroVersion, loroSubstrateFactory } from "../index.js"
import { createLoroResolver, materializeLoroShadow } from "../materialize.js"

// ===========================================================================
// Helpers
// ===========================================================================

type InterpretSubstrate = <S extends SchemaNode>(
  schema: S,
  substrate: Substrate<LoroVersion>,
) => Ref<S>

const interpretSubstrate: InterpretSubstrate = (schema, substrate) =>
  createRef(schema, substrate)

function trivialBinding(schema: SchemaNode): SchemaBinding {
  if (schema[KIND] === "product") {
    return deriveSchemaBinding(schema as ProductSchema, {})
  }
  return { forward: new Map(), inverse: new Map() }
}

function getLoroDoc(substrate: Substrate<LoroVersion>): LoroDoc {
  return (substrate as any)[BACKING_DOC] as LoroDoc
}

// ===========================================================================
// Test schemas
// ===========================================================================

const TextSchema = Schema.struct({
  title: Schema.text(),
})

const CounterSchema = Schema.struct({
  count: Schema.counter(),
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
  count: Schema.counter(),
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

describe("materializeLoroShadow", () => {
  it("materializes text fields", () => {
    const substrate = loroSubstrateFactory.create(TextSchema)
    const doc = interpretSubstrate(TextSchema, substrate)

    batch(doc, d => {
      d.title.insert(0, "hello")
    })

    const loroDoc = getLoroDoc(substrate)
    const binding = trivialBinding(TextSchema)
    const result = materializeLoroShadow(loroDoc, TextSchema, binding)

    expect(result).toEqual({ title: "hello" })
  })

  it("materializes counter fields", () => {
    const substrate = loroSubstrateFactory.create(CounterSchema)
    const doc = interpretSubstrate(CounterSchema, substrate)

    batch(doc, d => {
      d.count.increment(5)
    })

    const loroDoc = getLoroDoc(substrate)
    const binding = trivialBinding(CounterSchema)
    const result = materializeLoroShadow(loroDoc, CounterSchema, binding)

    expect(result).toEqual({ count: 5 })
  })

  it("materializes scalar fields", () => {
    const substrate = loroSubstrateFactory.create(ScalarSchema)
    const doc = interpretSubstrate(ScalarSchema, substrate)

    batch(doc, d => {
      d.name.set("Alice")
      d.age.set(30)
      d.active.set(true)
    })

    const loroDoc = getLoroDoc(substrate)
    const binding = trivialBinding(ScalarSchema)
    const result = materializeLoroShadow(loroDoc, ScalarSchema, binding)

    expect(result).toEqual({ name: "Alice", age: 30, active: true })
  })

  it("materializes sequence fields", () => {
    const substrate = loroSubstrateFactory.create(SequenceSchema)
    const doc = interpretSubstrate(SequenceSchema, substrate)

    batch(doc, d => {
      d.items.push("alpha")
    })
    batch(doc, d => {
      d.items.push("beta")
    })
    batch(doc, d => {
      d.items.push("gamma")
    })

    const loroDoc = getLoroDoc(substrate)
    const binding = trivialBinding(SequenceSchema)
    const result = materializeLoroShadow(loroDoc, SequenceSchema, binding)

    expect(result).toEqual({ items: ["alpha", "beta", "gamma"] })
  })

  it("materializes nested struct fields", () => {
    const substrate = loroSubstrateFactory.create(NestedSchema)
    const doc = interpretSubstrate(NestedSchema, substrate)

    batch(doc, d => {
      d.meta.author.set("Bob")
      d.meta.version.set(42)
    })

    const loroDoc = getLoroDoc(substrate)
    const binding = trivialBinding(NestedSchema)
    const result = materializeLoroShadow(loroDoc, NestedSchema, binding)

    expect(result).toEqual({
      meta: { author: "Bob", version: 42 },
    })
  })

  it("materializes empty document to structural zeros", () => {
    const substrate = loroSubstrateFactory.create(FullSchema)

    const loroDoc = getLoroDoc(substrate)
    const binding = trivialBinding(FullSchema)
    const result = materializeLoroShadow(loroDoc, FullSchema, binding)

    expect(result).toEqual({
      title: "",
      count: 0,
      theme: "",
      tags: [],
      settings: { darkMode: false, fontSize: 0 },
    })
  })

  it("uses raw field names, not identity hashes", () => {
    const substrate = loroSubstrateFactory.create(TextSchema)
    const doc = interpretSubstrate(TextSchema, substrate)

    batch(doc, d => {
      d.title.insert(0, "test")
    })

    const loroDoc = getLoroDoc(substrate)
    const binding = trivialBinding(TextSchema)
    const result = materializeLoroShadow(loroDoc, TextSchema, binding)

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
    const substrate = loroSubstrateFactory.create(FullSchema)
    const doc = interpretSubstrate(FullSchema, substrate)

    batch(doc, d => {
      d.title.insert(0, "My Doc")
      d.count.increment(10)
      d.theme.set("dark")
      d.settings.darkMode.set(true)
      d.settings.fontSize.set(16)
    })
    batch(doc, d => {
      d.tags.push("important")
    })
    batch(doc, d => {
      d.tags.push("urgent")
    })

    const loroDoc = getLoroDoc(substrate)
    const binding = trivialBinding(FullSchema)
    const result = materializeLoroShadow(loroDoc, FullSchema, binding)

    expect(result).toEqual({
      title: "My Doc",
      count: 10,
      theme: "dark",
      tags: ["important", "urgent"],
      settings: { darkMode: true, fontSize: 16 },
    })
  })

  it("materializes without binding (undefined binding)", () => {
    const substrate = loroSubstrateFactory.create(TextSchema)
    const doc = interpretSubstrate(TextSchema, substrate)

    batch(doc, d => {
      d.title.insert(0, "no binding")
    })

    const loroDoc = getLoroDoc(substrate)
    // Pass no binding — materialize should still work
    const result = materializeLoroShadow(loroDoc, TextSchema)

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
    const substrate = loroSubstrateFactory.create(schema)
    const loroDoc = getLoroDoc(substrate)
    const binding = trivialBinding(schema)
    const result = materializeLoroShadow(loroDoc, schema, binding)
    expect(result).toEqual({ settings: { theme: null } })
  })
})

describe("createLoroResolver.resolveHasKey", () => {
  it("agrees with resolveKeys, for a record and a .json() record", () => {
    const schema = Schema.struct({
      peers: Schema.record(Schema.number()),
      blob: Schema.record.json(Schema.number()),
    })
    const substrate = loroSubstrateFactory.create(schema)
    const doc = interpretSubstrate(schema, substrate)
    batch(doc, (d: any) => {
      d.peers.set("alice", 1)
      d.peers.set("bob", 2)
      d.blob.set("carol", 3)
    })
    batch(doc, (d: any) => d.peers.delete("bob"))

    const resolver = createLoroResolver(
      () => getLoroDoc(substrate),
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
