import { describe as testDescribe, expect, it } from "vitest"
import { Schema, describe } from "../index.js"

testDescribe("describe", () => {
  testDescribe("scalars", () => {
    it("describes a bare scalar", () => {
      expect(describe(Schema.scalar("string"))).toBe("string")
    })

    it("describes a number scalar", () => {
      expect(describe(Schema.scalar("number"))).toBe("number")
    })

    it("describes a boolean scalar", () => {
      expect(describe(Schema.scalar("boolean"))).toBe("boolean")
    })

    it("describes plain.any()", () => {
      expect(describe(Schema.plain.any())).toBe("any")
    })

    it("describes plain.bytes()", () => {
      expect(describe(Schema.plain.bytes())).toBe("bytes")
    })
  })

  testDescribe("leaf annotations", () => {
    it("describes text", () => {
      expect(describe(Schema.text())).toBe("text")
    })

    it("describes counter", () => {
      expect(describe(Schema.counter())).toBe("counter")
    })

    it("describes unknown leaf annotation", () => {
      expect(describe(Schema.annotated("timestamp"))).toBe("timestamp")
    })
  })

  testDescribe("products", () => {
    it("describes an empty product", () => {
      expect(describe(Schema.product({}))).toBe("{}")
    })

    it("describes a flat struct", () => {
      const s = Schema.struct({
        name: Schema.plain.string(),
        age: Schema.plain.number(),
        active: Schema.plain.boolean(),
      })
      expect(describe(s)).toBe(
        [
          "name: string",
          "age: number",
          "active: boolean",
        ].join("\n"),
      )
    })

    it("describes nested structs with indentation", () => {
      const s = Schema.struct({
        outer: Schema.struct({
          inner: Schema.plain.number(),
        }),
      })
      expect(describe(s)).toBe(
        [
          "outer:",
          "  inner: number",
        ].join("\n"),
      )
    })

    it("describes a labeled empty product", () => {
      const s = Schema.struct({
        empty: Schema.product({}),
      })
      expect(describe(s)).toBe("empty: {}")
    })
  })

  testDescribe("sequences", () => {
    it("describes list with inline scalar item", () => {
      expect(describe(Schema.list(Schema.plain.string()))).toBe("list<string>")
    })

    it("describes list with inline annotation item", () => {
      expect(describe(Schema.list(Schema.text()))).toBe("list<text>")
    })

    it("describes list with complex item on indented lines", () => {
      const s = Schema.list(
        Schema.struct({
          title: Schema.plain.string(),
          done: Schema.plain.boolean(),
        }),
      )
      expect(describe(s)).toBe(
        [
          "list",
          "  title: string",
          "  done: boolean",
        ].join("\n"),
      )
    })

    it("describes labeled list with inline item", () => {
      const s = Schema.struct({
        tags: Schema.list(Schema.plain.string()),
      })
      expect(describe(s)).toBe("tags: list<string>")
    })

    it("describes labeled list with complex item", () => {
      const s = Schema.struct({
        items: Schema.list(
          Schema.struct({
            id: Schema.plain.number(),
          }),
        ),
      })
      expect(describe(s)).toBe(
        [
          "items: list",
          "  id: number",
        ].join("\n"),
      )
    })

    it("describes nested list<list<string>> inline", () => {
      expect(describe(Schema.list(Schema.list(Schema.plain.string())))).toBe(
        "list<list<string>>",
      )
    })
  })

  testDescribe("maps", () => {
    it("describes record with inline scalar item", () => {
      expect(describe(Schema.record(Schema.plain.string()))).toBe(
        "record<string>",
      )
    })

    it("describes record with complex item on indented lines", () => {
      const s = Schema.record(
        Schema.struct({
          value: Schema.plain.number(),
        }),
      )
      expect(describe(s)).toBe(
        [
          "record",
          "  value: number",
        ].join("\n"),
      )
    })

    it("describes labeled record inline", () => {
      const s = Schema.struct({
        labels: Schema.record(Schema.plain.string()),
      })
      expect(describe(s)).toBe("labels: record<string>")
    })

    it("describes record<list<number>> inline", () => {
      expect(
        describe(Schema.record(Schema.list(Schema.plain.number()))),
      ).toBe("record<list<number>>")
    })
  })

  testDescribe("sums", () => {
    it("describes a positional union", () => {
      const s = Schema.plain.union(
        Schema.plain.string(),
        Schema.plain.number(),
      )
      expect(describe(s)).toBe(
        [
          "union",
          "  0: string",
          "  1: number",
        ].join("\n"),
      )
    })

    it("describes a discriminated union", () => {
      const s = Schema.plain.discriminatedUnion("type", {
        text: Schema.struct({ content: Schema.plain.string() }),
        image: Schema.struct({ url: Schema.plain.string() }),
      })
      expect(describe(s)).toBe(
        [
          "union(type)",
          "  text:",
          "    content: string",
          "  image:",
          "    url: string",
        ].join("\n"),
      )
    })
  })

  testDescribe("annotated with inner schema", () => {
    it("describes doc with fields", () => {
      const s = Schema.doc({
        title: Schema.text(),
        count: Schema.counter(),
      })
      expect(describe(s)).toBe(
        [
          "doc",
          "  title: text",
          "  count: counter",
        ].join("\n"),
      )
    })

    it("describes movable list with inline item", () => {
      expect(describe(Schema.movableList(Schema.plain.string()))).toBe(
        "movable-list<string>",
      )
    })

    it("describes movable list with complex item", () => {
      const s = Schema.movableList(
        Schema.struct({
          name: Schema.plain.string(),
        }),
      )
      expect(describe(s)).toBe(
        [
          "movable-list",
          "  name: string",
        ].join("\n"),
      )
    })

    it("describes tree with node data", () => {
      const s = Schema.tree(
        Schema.struct({
          label: Schema.plain.string(),
          weight: Schema.plain.number(),
        }),
      )
      expect(describe(s)).toBe(
        [
          "tree",
          "  label: string",
          "  weight: number",
        ].join("\n"),
      )
    })

    it("describes generic annotation with inline inner", () => {
      const s = Schema.annotated("timestamp", Schema.scalar("number"))
      expect(describe(s)).toBe("@timestamp<number>")
    })

    it("describes generic annotation with complex inner", () => {
      const s = Schema.annotated(
        "versioned",
        Schema.product({
          value: Schema.plain.string(),
          version: Schema.plain.number(),
        }),
      )
      expect(describe(s)).toBe(
        [
          "@versioned",
          "  value: string",
          "  version: number",
        ].join("\n"),
      )
    })
  })

  testDescribe("realistic nested schemas", () => {
    it("describes a full project schema", () => {
      const s = Schema.doc({
        name: Schema.text(),
        description: Schema.text(),
        stars: Schema.counter(),
        tasks: Schema.list(
          Schema.struct({
            title: Schema.plain.string(),
            done: Schema.plain.boolean(),
            priority: Schema.plain.number(),
          }),
        ),
        settings: Schema.struct({
          visibility: Schema.plain.string(),
          maxTasks: Schema.plain.number(),
          archived: Schema.plain.boolean(),
        }),
        labels: Schema.record(Schema.plain.string()),
      })

      expect(describe(s)).toBe(
        [
          "doc",
          "  name: text",
          "  description: text",
          "  stars: counter",
          "  tasks: list",
          "    title: string",
          "    done: boolean",
          "    priority: number",
          "  settings:",
          "    visibility: string",
          "    maxTasks: number",
          "    archived: boolean",
          "  labels: record<string>",
        ].join("\n"),
      )
    })

    it("describes deeply nested containers", () => {
      const s = Schema.doc({
        channels: Schema.list(
          Schema.struct({
            name: Schema.text(),
            messages: Schema.list(
              Schema.struct({
                author: Schema.plain.string(),
                body: Schema.text(),
                reactions: Schema.record(Schema.plain.number()),
              }),
            ),
          }),
        ),
      })

      expect(describe(s)).toBe(
        [
          "doc",
          "  channels: list",
          "    name: text",
          "    messages: list",
          "      author: string",
          "      body: text",
          "      reactions: record<number>",
        ].join("\n"),
      )
    })

    it("describes schema with movable list and tree", () => {
      const s = Schema.doc({
        tasks: Schema.movableList(
          Schema.struct({
            title: Schema.plain.string(),
          }),
        ),
        hierarchy: Schema.tree(
          Schema.struct({
            label: Schema.plain.string(),
            color: Schema.plain.string(),
          }),
        ),
      })

      expect(describe(s)).toBe(
        [
          "doc",
          "  tasks: movable-list",
          "    title: string",
          "  hierarchy: tree",
          "    label: string",
          "    color: string",
        ].join("\n"),
      )
    })

    it("describes schema with discriminated union field", () => {
      const s = Schema.doc({
        content: Schema.plain.discriminatedUnion("type", {
          text: Schema.struct({ body: Schema.plain.string() }),
          image: Schema.struct({ url: Schema.plain.string(), width: Schema.plain.number() }),
        }),
      })

      expect(describe(s)).toBe(
        [
          "doc",
          "  content: union(type)",
          "    text:",
          "      body: string",
          "    image:",
          "      url: string",
          "      width: number",
        ].join("\n"),
      )
    })
  })

  testDescribe("inline rendering", () => {
    it("inlines simple items in list inside a labeled field", () => {
      const s = Schema.struct({
        a: Schema.list(Schema.plain.number()),
        b: Schema.record(Schema.plain.boolean()),
        c: Schema.movableList(Schema.plain.string()),
      })
      expect(describe(s)).toBe(
        [
          "a: list<number>",
          "b: record<boolean>",
          "c: movable-list<string>",
        ].join("\n"),
      )
    })

    it("does not inline products", () => {
      const s = Schema.struct({
        nested: Schema.struct({ x: Schema.plain.number() }),
      })
      // Should be multi-line, not inlined
      expect(describe(s)).toBe(
        [
          "nested:",
          "  x: number",
        ].join("\n"),
      )
    })
  })
})