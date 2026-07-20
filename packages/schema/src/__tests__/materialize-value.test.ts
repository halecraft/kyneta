// Pure unit tests for the `materializeValue` unfold. No substrate — the whole
// point of the IR is that identity-keying is testable in isolation.

import { describe, expect, it } from "vitest"
import {
  containerKey,
  deriveSchemaBinding,
  fieldAbsPath,
  materializeValue,
  needsContainer,
  Schema,
} from "../index.js"
import { KIND, type ProductSchema } from "../schema.js"

const Inner = Schema.struct({
  a: Schema.string().nullable(),
  b: Schema.string().nullable(),
})

const Root = Schema.struct({
  nullableStruct: Inner.nullable(),
  nonNullableStruct: Inner,
  title: Schema.text(),
  tags: Schema.record(Inner),
  items: Schema.list(Inner),
})

const binding = deriveSchemaBinding(Root as unknown as ProductSchema, {})

/** The key the reader/binding uses for an abs-path (identity hash or fallback). */
const key = (absPath: string, fallback: string) =>
  containerKey(binding, absPath, fallback)

/** Look up an entry value by its final (already-resolved) key. */
function entry(node: any, k: string) {
  expect(node.kind).toBe("map")
  const found = node.entries.find(([ek]: [string, unknown]) => ek === k)
  expect(found, `expected entry keyed ${k}`).toBeTruthy()
  return found[1]
}

describe("materializeValue — identity keying", () => {
  it("product scalar leaves are identity-keyed, values are plain", () => {
    const node = materializeValue(
      Inner,
      { a: "hello", b: "world" },
      binding,
      "nonNullableStruct",
      "leaf-containers",
    )
    expect(node.kind).toBe("map")
    expect(entry(node, key("nonNullableStruct.a", "a"))).toEqual({
      kind: "plain",
      value: "hello",
    })
    expect(entry(node, key("nonNullableStruct.b", "b"))).toEqual({
      kind: "plain",
      value: "world",
    })
    // Never the literal names when a binding maps them.
    const literalKeys = (node as any).entries.map(([k]: [string]) => k)
    expect(literalKeys).not.toContain("a")
    expect(literalKeys).not.toContain("b")
  })

  it("nested product keys extend the parent abs-path", () => {
    const Outer = Schema.struct({ meta: Inner })
    const outerBinding = deriveSchemaBinding(
      Outer as unknown as ProductSchema,
      {},
    )
    const node = materializeValue(
      Outer,
      { meta: { a: "x", b: "y" } },
      outerBinding,
      "",
      "leaf-containers",
    )
    const meta = entry(node, containerKey(outerBinding, "meta", "meta"))
    expect(meta.kind).toBe("map")
    const mk = (p: string, f: string) => containerKey(outerBinding, p, f)
    expect(entry(meta, mk("meta.a", "a"))).toEqual({
      kind: "plain",
      value: "x",
    })
  })

  it("record entries keep runtime keys; the struct value's fields are identity-keyed", () => {
    const node = materializeValue(
      Root.fields.tags as any,
      { "entry-1": { a: "x", b: "y" } },
      binding,
      "tags",
      "leaf-containers",
    )
    // Entry key is the runtime string, verbatim.
    const struct = entry(node, "entry-1")
    expect(struct.kind).toBe("map")
    // The struct's fields key at the record's field-abs-path (entry does not
    // advance it) — exactly what foldPath resolves.
    expect(entry(struct, key("tags.a", "a"))).toEqual({
      kind: "plain",
      value: "x",
    })
  })

  it("list items are positional; item struct fields are identity-keyed", () => {
    const node = materializeValue(
      Root.fields.items as any,
      [{ a: "x" }],
      binding,
      "items",
      "leaf-containers",
    )
    expect(node.kind).toBe("list")
    const item0 = (node as any).items[0]
    expect(entry(item0, key("items.a", "a"))).toEqual({
      kind: "plain",
      value: "x",
    })
  })

  it("first-class leaves and opaque values map to the right node kinds", () => {
    expect(
      materializeValue(
        Schema.text(),
        "hi",
        binding,
        "title",
        "leaf-containers",
      ),
    ).toEqual({ kind: "text", content: "hi" })
    // sum (nullable) → plain, opaque
    expect(
      materializeValue(
        Inner.nullable(),
        { a: "x", b: "y" },
        binding,
        "nullableStruct",
        "leaf-containers",
      ),
    ).toEqual({ kind: "plain", value: { a: "x", b: "y" } })
    // json-boundary → plain
    const JsonInner = Schema.struct.json({ a: Schema.string() })
    expect(
      materializeValue(JsonInner, { a: "x" }, binding, "j", "leaf-containers"),
    ).toEqual({ kind: "plain", value: { a: "x" } })
  })

  it("skips explicit-undefined fields", () => {
    const node = materializeValue(
      Inner,
      { a: "x", b: undefined },
      binding,
      "nonNullableStruct",
      "leaf-containers",
    )
    const keys = (node as any).entries.map(([k]: [string]) => k)
    expect(keys).toContain(key("nonNullableStruct.a", "a"))
    expect(keys).not.toContain(key("nonNullableStruct.b", "b"))
  })
})

describe("materializeValue — eager policy", () => {
  const WithContainers = Schema.struct({
    note: Schema.text(),
    nested: Schema.struct({ x: Schema.string().nullable() }),
  })
  const b2 = deriveSchemaBinding(WithContainers as unknown as ProductSchema, {})

  it("leaf-containers eager-creates absent text but not absent nested structs", () => {
    const node = materializeValue(WithContainers, {}, b2, "", "leaf-containers")
    const keys = (node as any).entries.map(([k]: [string]) => k)
    expect(keys).toContain(containerKey(b2, "note", "note"))
    expect(keys).not.toContain(containerKey(b2, "nested", "nested"))
  })

  it("all-containers eager-creates absent nested structs too", () => {
    const node = materializeValue(WithContainers, {}, b2, "", "all-containers")
    const keys = (node as any).entries.map(([k]: [string]) => k)
    expect(keys).toContain(containerKey(b2, "note", "note"))
    expect(keys).toContain(containerKey(b2, "nested", "nested"))
  })
})

describe("needsContainer / fieldAbsPath", () => {
  it("needsContainer follows structural kind, excludes json-boundary", () => {
    expect(needsContainer(Schema.struct({ a: Schema.string() }))).toBe(true)
    expect(needsContainer(Schema.text())).toBe(true)
    expect(needsContainer(Schema.string())).toBe(false)
    expect(needsContainer(Schema.struct.json({ a: Schema.string() }))).toBe(
      false,
    )
  })

  it("fieldAbsPath accumulates only field segments", () => {
    // Sanity: the accumulator matches deriveSchemaBinding's key space for a
    // top-level field.
    expect(fieldAbsPath([])).toBe("")
    expect(Root.fields.nonNullableStruct[KIND]).toBe("product")
  })
})
