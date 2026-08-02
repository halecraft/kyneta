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

    // Rich text is a container like `text`, despite reading as a leaf. The
    // predicate's own doc comment explains why that is easy to get backwards.
    expect(needsContainer(Schema.richText({ bold: { expand: "after" } }))).toBe(
      true,
    )

    // A sum is stored whole, so there is no container to create. Worth pinning
    // because the consequence reaches well past this predicate: a sum
    // answering `false` is what makes a register land as ONE tuple in the
    // `state` substrate, and that in turn is what lets `mergeStateTree` merge
    // raw payloads without ever consulting the schema.
    expect(needsContainer(Schema.string().nullable())).toBe(false)
  })

  it("eager policies nest: leaf-containers ⊆ all-containers", () => {
    // `materializeValue` pre-creates containers for schema-declared fields the
    // written value omits, so a later write has something to land on. Two
    // policies choose how far to go: `"leaf-containers"` (Yjs) creates only the
    // leaf containers, `"all-containers"` (Loro) creates those *and* the
    // structural ones.
    //
    // The names promise a subset relation, and the promise is checkable, so it
    // is checked here rather than left to the naming. Asserting the relation
    // itself — instead of a list of per-kind expectations — means it keeps
    // holding as kinds are added, which is how it came to be violated by a
    // single kind that fell through a switch's `default`.
    const ALL_KINDS = {
      product: Schema.struct({ x: Schema.number() }),
      sum: Schema.struct({ x: Schema.number() }).nullable(),
      sequence: Schema.list(Schema.number()),
      map: Schema.record(Schema.number()),
      scalar: Schema.number(),
      text: Schema.text(),
      counter: Schema.counter(),
      set: Schema.set(Schema.string()),
      tree: Schema.tree(Schema.string()),
      movable: Schema.movableList(Schema.string()),
      richtext: Schema.richText({ bold: { expand: "after" } }),
      jsonBoundary: Schema.struct.json({ x: Schema.number() }),
    }
    // An empty value means every declared field is absent — the eager path.
    const eagerlyCreated = (policy: "leaf-containers" | "all-containers") => {
      const node = materializeValue(
        Schema.struct(ALL_KINDS) as never,
        {},
        undefined,
        "",
        policy,
      ) as { entries?: ReadonlyArray<readonly [string, unknown]> }
      return new Set((node.entries ?? []).map(([key]) => key))
    }

    const all = eagerlyCreated("all-containers")
    const leaf = eagerlyCreated("leaf-containers")
    expect([...leaf].filter(kind => !all.has(kind))).toEqual([])
    // And the relation is non-trivial: `all` genuinely creates more.
    expect(all.size).toBeGreaterThan(leaf.size)
  })

  it("fieldAbsPath accumulates only field segments", () => {
    // Sanity: the accumulator matches deriveSchemaBinding's key space for a
    // top-level field.
    expect(fieldAbsPath([])).toBe("")
    expect(Root.fields.nonNullableStruct[KIND]).toBe("product")
  })
})
