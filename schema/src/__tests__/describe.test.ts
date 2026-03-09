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

    it("describes any()", () => {
      expect(describe(Schema.any())).toBe("any")
    })

    it("describes bytes()", () => {
      expect(describe(Schema.bytes())).toBe("bytes")
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
        name: Schema.string(),
        age: Schema.number(),
        active: Schema.boolean(),
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
          inner: Schema.number(),
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
      expect(describe(Schema.list(Schema.string()))).toBe("list<string>")
    })

    it("describes list with inline annotation item", () => {
      expect(describe(Schema.list(Schema.text()))).toBe("list<text>")
    })

    it("describes list with complex item on indented lines", () => {
      const s = Schema.list(
        Schema.struct({
          title: Schema.string(),
          done: Schema.boolean(),
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
        tags: Schema.list(Schema.string()),
      })
      expect(describe(s)).toBe("tags: list<string>")
    })

    it("describes labeled list with complex item", () => {
      const s = Schema.struct({
        items: Schema.list(
          Schema.struct({
            id: Schema.number(),
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
      expect(describe(Schema.list(Schema.list(Schema.string())))).toBe(
        "list<list<string>>",
      )
    })
  })

  testDescribe("maps", () => {
    it("describes record with inline scalar item", () => {
      expect(describe(Schema.record(Schema.string()))).toBe(
        "record<string>",
      )
    })

    it("describes record with complex item on indented lines", () => {
      const s = Schema.record(
        Schema.struct({
          value: Schema.number(),
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
        labels: Schema.record(Schema.string()),
      })
      expect(describe(s)).toBe("labels: record<string>")
    })

    it("describes record<list<number>> inline", () => {
      expect(
        describe(Schema.record(Schema.list(Schema.number()))),
      ).toBe("record<list<number>>")
    })
  })

  testDescribe("sums", () => {
    it("describes a positional union", () => {
      const s = Schema.union(
        Schema.string(),
        Schema.number(),
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
      const s = Schema.discriminatedUnion("type", {
        text: Schema.struct({ content: Schema.string() }),
        image: Schema.struct({ url: Schema.string() }),
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
      expect(describe(Schema.movableList(Schema.string()))).toBe(
        "movable-list<string>",
      )
    })

    it("describes movable list with complex item", () => {
      const s = Schema.movableList(
        Schema.struct({
          name: Schema.string(),
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
          label: Schema.string(),
          weight: Schema.number(),
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
          value: Schema.string(),
          version: Schema.number(),
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
            title: Schema.string(),
            done: Schema.boolean(),
            priority: Schema.number(),
          }),
        ),
        settings: Schema.struct({
          visibility: Schema.string(),
          maxTasks: Schema.number(),
          archived: Schema.boolean(),
        }),
        labels: Schema.record(Schema.string()),
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
                author: Schema.string(),
                body: Schema.text(),
                reactions: Schema.record(Schema.number()),
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
            title: Schema.string(),
          }),
        ),
        hierarchy: Schema.tree(
          Schema.struct({
            label: Schema.string(),
            color: Schema.string(),
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
        content: Schema.discriminatedUnion("type", {
          text: Schema.struct({ body: Schema.string() }),
          image: Schema.struct({ url: Schema.string(), width: Schema.number() }),
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
        a: Schema.list(Schema.number()),
        b: Schema.record(Schema.boolean()),
        c: Schema.movableList(Schema.string()),
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
        nested: Schema.struct({ x: Schema.number() }),
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