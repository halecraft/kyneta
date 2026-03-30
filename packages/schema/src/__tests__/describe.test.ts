import { expect, it, describe as testDescribe } from "vitest"
import { describe, Schema } from "../index.js"

// ===========================================================================
// Base grammar tests — Schema only, no Loro annotations
// ===========================================================================

testDescribe("describe: base grammar", () => {
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
        ["name: string", "age: number", "active: boolean"].join("\n"),
      )
    })

    it("describes nested structs with indentation", () => {
      const s = Schema.struct({
        outer: Schema.struct({
          inner: Schema.number(),
        }),
      })
      expect(describe(s)).toBe(["outer:", "  inner: number"].join("\n"))
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

    it("describes list with complex item on indented lines", () => {
      const s = Schema.list(
        Schema.struct({
          title: Schema.string(),
          done: Schema.boolean(),
        }),
      )
      expect(describe(s)).toBe(
        ["list", "  title: string", "  done: boolean"].join("\n"),
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
      expect(describe(s)).toBe(["items: list", "  id: number"].join("\n"))
    })

    it("describes nested list<list<string>> inline", () => {
      expect(describe(Schema.list(Schema.list(Schema.string())))).toBe(
        "list<list<string>>",
      )
    })
  })

  testDescribe("maps", () => {
    it("describes record with inline scalar item", () => {
      expect(describe(Schema.record(Schema.string()))).toBe("record<string>")
    })

    it("describes record with complex item on indented lines", () => {
      const s = Schema.record(
        Schema.struct({
          value: Schema.number(),
        }),
      )
      expect(describe(s)).toBe(["record", "  value: number"].join("\n"))
    })

    it("describes labeled record inline", () => {
      const s = Schema.struct({
        labels: Schema.record(Schema.string()),
      })
      expect(describe(s)).toBe("labels: record<string>")
    })

    it("describes record<list<number>> inline", () => {
      expect(describe(Schema.record(Schema.list(Schema.number())))).toBe(
        "record<list<number>>",
      )
    })
  })

  testDescribe("sums", () => {
    it("describes a positional union", () => {
      const s = Schema.union(Schema.string(), Schema.number())
      expect(describe(s)).toBe(
        ["union", "  0: string", "  1: number"].join("\n"),
      )
    })

    it("describes a discriminated union", () => {
      const s = Schema.discriminatedUnion("type", [
        Schema.struct({
          type: Schema.string("text"),
          content: Schema.string(),
        }),
        Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
      ])
      expect(describe(s)).toBe(
        [
          "union(type)",
          "  text:",
          '    type: string("text")',
          "    content: string",
          "  image:",
          '    type: string("image")',
          "    url: string",
        ].join("\n"),
      )
    })
  })

  testDescribe("doc (structural root)", () => {
    it("describes doc with scalar fields", () => {
      const s = Schema.doc({
        name: Schema.string(),
        count: Schema.number(),
      })
      expect(describe(s)).toBe(
        ["doc", "  name: string", "  count: number"].join("\n"),
      )
    })

    it("describes doc with nested struct and list", () => {
      const s = Schema.doc({
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

    it("describes doc with discriminated union field", () => {
      const s = Schema.doc({
        content: Schema.discriminatedUnion("type", [
          Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
          Schema.struct({
            type: Schema.string("image"),
            url: Schema.string(),
            width: Schema.number(),
          }),
        ]),
      })

      expect(describe(s)).toBe(
        [
          "doc",
          "  content: union(type)",
          "    text:",
          '      type: string("text")',
          "      body: string",
          "    image:",
          '      type: string("image")',
          "      url: string",
          "      width: number",
        ].join("\n"),
      )
    })
  })

  testDescribe("generic annotations", () => {
    it("describes unknown leaf annotation", () => {
      expect(describe(Schema.annotated("timestamp"))).toBe("timestamp")
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
        ["@versioned", "  value: string", "  version: number"].join("\n"),
      )
    })
  })

  testDescribe("inline rendering", () => {
    it("does not inline products", () => {
      const s = Schema.struct({
        nested: Schema.struct({ x: Schema.number() }),
      })
      expect(describe(s)).toBe(["nested:", "  x: number"].join("\n"))
    })
  })
})

// ===========================================================================
// Annotation rendering tests
// ===========================================================================

testDescribe("describe: annotation rendering", () => {
  testDescribe("leaf annotations", () => {
    it("describes text", () => {
      expect(describe(Schema.annotated("text"))).toBe("text")
    })

    it("describes counter", () => {
      expect(describe(Schema.annotated("counter"))).toBe("counter")
    })
  })

  testDescribe("movable list", () => {
    it("describes movable list with inline item", () => {
      expect(describe(Schema.annotated("movable", Schema.list(Schema.string())))).toBe(
        "movable-list<string>",
      )
    })

    it("describes movable list with complex item", () => {
      const s = Schema.annotated("movable", Schema.list(
        Schema.struct({
          name: Schema.string(),
        }),
      ))
      expect(describe(s)).toBe(["movable-list", "  name: string"].join("\n"))
    })
  })

  testDescribe("tree", () => {
    it("describes tree with node data", () => {
      const s = Schema.annotated("tree",
        Schema.struct({
          label: Schema.string(),
          weight: Schema.number(),
        }),
      )
      expect(describe(s)).toBe(
        ["tree", "  label: string", "  weight: number"].join("\n"),
      )
    })
  })

  testDescribe("list with annotation item", () => {
    it("describes list with inline annotation item", () => {
      expect(describe(Schema.list(Schema.annotated("text")))).toBe("list<text>")
    })

    it("inlines movable-list inside a labeled field", () => {
      const s = Schema.struct({
        a: Schema.list(Schema.number()),
        b: Schema.record(Schema.boolean()),
        c: Schema.annotated("movable", Schema.list(Schema.string())),
      })
      expect(describe(s)).toBe(
        [
          "a: list<number>",
          "b: record<boolean>",
          "c: movable-list<string>",
        ].join("\n"),
      )
    })
  })

  testDescribe("realistic nested schemas", () => {
    it("describes a full annotated project schema", () => {
      const s = Schema.doc({
        name: Schema.annotated("text"),
        description: Schema.annotated("text"),
        stars: Schema.annotated("counter"),
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
            name: Schema.annotated("text"),
            messages: Schema.list(
              Schema.struct({
                author: Schema.string(),
                body: Schema.annotated("text"),
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
        tasks: Schema.annotated("movable", Schema.list(
          Schema.struct({
            title: Schema.string(),
          }),
        )),
        hierarchy: Schema.annotated("tree",
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
  })

  testDescribe("constrained scalars", () => {
    it("describes a constrained string", () => {
      expect(describe(Schema.string("public", "private"))).toBe(
        'string("public" | "private")',
      )
    })

    it("describes a constrained number", () => {
      expect(describe(Schema.number(1, 2, 3))).toBe("number(1 | 2 | 3)")
    })

    it("describes a constrained boolean", () => {
      expect(describe(Schema.boolean(true))).toBe("boolean(true)")
    })

    it("unconstrained scalar renders without parens", () => {
      expect(describe(Schema.string())).toBe("string")
    })

    it("constrained scalar inline in list", () => {
      expect(describe(Schema.list(Schema.string("a", "b")))).toBe(
        'list<string("a" | "b")>',
      )
    })

    it("constrained scalar as struct field", () => {
      const s = Schema.struct({
        visibility: Schema.string("public", "private"),
        count: Schema.number(),
      })
      expect(describe(s)).toBe(
        ['visibility: string("public" | "private")', "count: number"].join(
          "\n",
        ),
      )
    })
  })

  testDescribe("nullable sugar", () => {
    it("renders nullable<string> for sum([null, string])", () => {
      expect(describe(Schema.nullable(Schema.string()))).toBe(
        "nullable<string>",
      )
    })

    it("renders nullable<number> for sum([null, number])", () => {
      expect(describe(Schema.nullable(Schema.number()))).toBe(
        "nullable<number>",
      )
    })

    it("renders nullable with complex inner as indented children", () => {
      const s = Schema.nullable(
        Schema.struct({
          name: Schema.string(),
          age: Schema.number(),
        }),
      )
      expect(describe(s)).toBe(
        ["nullable", "  name: string", "  age: number"].join("\n"),
      )
    })

    it("renders nullable<text> for annotated inner", () => {
      expect(describe(Schema.nullable(Schema.annotated("text")))).toBe(
        "nullable<text>",
      )
    })

    it("non-nullable union with 3 variants renders as union", () => {
      const s = Schema.union(Schema.null(), Schema.string(), Schema.number())
      expect(describe(s)).toBe(
        ["union", "  0: null", "  1: string", "  2: number"].join("\n"),
      )
    })

    it("non-nullable 2-variant union (no null first) renders as union", () => {
      const s = Schema.union(Schema.string(), Schema.number())
      expect(describe(s)).toBe(
        ["union", "  0: string", "  1: number"].join("\n"),
      )
    })

    it("nullable with constrained inner", () => {
      expect(describe(Schema.nullable(Schema.string("a", "b")))).toBe(
        'nullable<string("a" | "b")>',
      )
    })

    it("nullable field in doc", () => {
      const s = Schema.doc({
        name: Schema.string(),
        bio: Schema.nullable(Schema.string()),
      })
      expect(describe(s)).toBe(
        ["doc", "  name: string", "  bio: nullable<string>"].join("\n"),
      )
    })
  })
})