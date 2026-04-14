/**
 * Integration tests for the transform pipeline.
 *
 * These tests exercise the full compile flow: source code → IR → generated output.
 * They validate that the pipeline produces correct output for real-world patterns.
 */

import {
  type ClassifiedDependency,
  createBuilder,
  createContent,
  createLoop,
  createSpan,
  type DeltaKind,
  type Dependency,
  type FilterMetadata,
} from "@kyneta/compiler"
import { Project } from "ts-morph"
import { describe, expect, it } from "vitest"
import {
  collectRequiredImports,
  hasBuilderCalls,
  mergeImports,
  transformSource,
  transformSourceInPlace,
} from "./transform.js"

// =============================================================================
// Inline Type Stubs for Transform Tests
// =============================================================================

/**
 * Inline type declarations for CHANGEFEED-based ref types.
 *
 * Transform tests use `transformSource()` which resolves modules from the real
 * filesystem. Test source strings declare their types inline. This helper
 * provides type stubs that mirror the schema's CHANGEFEED protocol with narrow
 * change types for proper deltaKind extraction.
 *
 * Usage: prepend to test source strings that need reactive types.
 */
const CHANGEFEED_TYPE_STUBS = `
import { type HasChangefeed } from "@kyneta/changefeed"

type TextChange = { readonly type: "text"; readonly ops: readonly unknown[] }
type SequenceChange<T = unknown> = { readonly type: "sequence"; readonly ops: readonly unknown[] }
type MapChange = { readonly type: "map"; readonly set?: Record<string, unknown>; readonly delete?: readonly string[] }
type ReplaceChange<T = unknown> = { readonly type: "replace"; readonly value: T }
type IncrementChange = { readonly type: "increment"; readonly amount: number }

interface TextRef extends HasChangefeed<string, TextChange> {
  (): string
  [Symbol.toPrimitive](hint: string): string
  insert(pos: number, text: string): void
  delete(pos: number, len: number): void
}

interface CounterRef extends HasChangefeed<number, IncrementChange> {
  (): number
  [Symbol.toPrimitive](hint: string): number | string
  increment(n: number): void
  decrement(n: number): void
}

interface ListRef<T> extends HasChangefeed<T[], SequenceChange<T>> {
  (): T[]
  readonly length: number
  get(index: number): T | undefined
  at(index: number): T | undefined
  push(item: T): void
  insert(index: number, item: T): void
  delete(index: number, len?: number): void
  [Symbol.iterator](): Iterator<T>
}

interface StructRef<T> extends HasChangefeed<T, MapChange> {
  (): T
}

type TypedDoc<Shape> = Shape & HasChangefeed<unknown, MapChange> & {
  toJSON(): unknown
}
`

/**
 * Wrap source code with the inline type stubs.
 * Use when a test source string needs TextRef, CounterRef, ListRef, etc.
 */
function withTypes(source: string): string {
  return `${CHANGEFEED_TYPE_STUBS}\n${source}`
}

// =============================================================================
// hasBuilderCalls Tests
// =============================================================================

describe("hasBuilderCalls", () => {
  it("should return true for source with element factory calls", () => {
    const source = `
      div(() => {
        h1("Hello")
      })
    `
    expect(hasBuilderCalls(source)).toBe(true)
  })

  it("should return true for source with props and builder", () => {
    const source = `
      div({ class: "container" }, () => {
        p("Content")
      })
    `
    expect(hasBuilderCalls(source)).toBe(true)
  })

  it("should return false for source without builder functions", () => {
    const source = `
      const x = 1 + 2
      console.log(x)
    `
    expect(hasBuilderCalls(source)).toBe(false)
  })

  it("should return false for element calls without builder argument", () => {
    const source = `
      div("just text")
      span(someVariable)
    `
    expect(hasBuilderCalls(source)).toBe(false)
  })

  it("should return false for non-element function calls with arrow functions", () => {
    const source = `
      myFunction(() => {
        doSomething()
      })
      array.map((item) => item.name)
    `
    expect(hasBuilderCalls(source)).toBe(false)
  })
})

// =============================================================================
// transformSource Tests - DOM Target
// =============================================================================

describe("transformSource - DOM target", () => {
  it("should transform simple static builder", () => {
    const source = `
      div(() => {
        h1("Hello, World!")
      })
    `

    const result = transformSource(source, { target: "dom" })

    expect(result.ir).toHaveLength(1)
    expect(result.ir[0].factoryName).toBe("div")
    expect(result.code).toContain('document.createElement("div")')
    expect(result.code).toContain('document.createElement("h1")')
    expect(result.code).toContain("Hello, World!")
  })

  it("should transform builder with props", () => {
    const source = `
      div({ class: "container", id: "main" }, () => {
        p("Content")
      })
    `

    const result = transformSource(source, { target: "dom" })

    expect(result.ir[0].props).toHaveLength(2)
    expect(result.code).toContain(".className =")
    expect(result.code).toContain("container")
    expect(result.code).toContain("setAttribute")
    expect(result.code).toContain('"id"')
  })

  it("should transform builder with event handlers", () => {
    const source = `
      button({ onClick: () => console.log("clicked") }, () => {
        span("Click me")
      })
    `

    const result = transformSource(source, { target: "dom" })

    expect(result.ir[0].eventHandlers).toHaveLength(1)
    expect(result.ir[0].eventHandlers[0].event).toBe("click")
    expect(result.code).toContain('addEventListener("click"')
  })

  it("should transform multiple top-level builders", () => {
    const source = `
      header(() => {
        h1("Title")
      })

      main(() => {
        p("Content")
      })

      footer(() => {
        span("Footer")
      })
    `

    const result = transformSource(source, { target: "dom" })

    expect(result.ir).toHaveLength(3)
    expect(result.ir[0].factoryName).toBe("header")
    expect(result.ir[1].factoryName).toBe("main")
    expect(result.ir[2].factoryName).toBe("footer")
  })

  it("should produce code with balanced delimiters", () => {
    const source = `
      div({ class: "app" }, () => {
        header(() => {
          h1("Title")
        })
        main(() => {
          section(() => {
            p("Nested content")
          })
        })
      })
    `

    const result = transformSource(source, { target: "dom" })

    // Verify balanced braces (basic syntax validity check)
    const openBraces = (result.code.match(/{/g) || []).length
    const closeBraces = (result.code.match(/}/g) || []).length
    expect(openBraces).toBe(closeBraces)

    const openParens = (result.code.match(/\(/g) || []).length
    const closeParens = (result.code.match(/\)/g) || []).length
    expect(openParens).toBe(closeParens)
  })

  it("should include runtime imports when reactive content exists", () => {
    // We can't actually test reactive detection without real Loro types,
    // but we can verify the import generation mechanism works
    const source = `
      div(() => {
        h1("Static content only")
      })
    `

    const result = transformSource(source, { target: "dom" })

    // Static content should not generate imports
    // (or minimal imports if any)
    expect(result.ir[0].isReactive).toBe(false)
  })
})

// =============================================================================
// transformSource Tests - HTML Target
// =============================================================================

describe("transformSource - HTML target", () => {
  it("should generate HTML template for simple builder", () => {
    const source = `
      div(() => {
        h1("Hello, World!")
      })
    `

    const result = transformSource(source, { target: "html" })

    expect(result.code).toContain("<div>")
    expect(result.code).toContain("</div>")
    expect(result.code).toContain("<h1>")
    expect(result.code).toContain("Hello, World!")
  })

  it("should include escape helper for HTML target", () => {
    const source = `
      p(() => {
        span("Text")
      })
    `

    const result = transformSource(source, { target: "html" })

    expect(result.code).toContain("__escapeHtml")
  })

  it("should generate template literal syntax", () => {
    const source = `
      div({ class: "container" }, () => {
        p("Content")
      })
    `

    const result = transformSource(source, { target: "html" })

    // HTML output uses template literals
    expect(result.code).toContain("`")
  })
})

// =============================================================================
// transformSource Tests - Error Handling
// =============================================================================

describe("transformSource - error handling", () => {
  it("should handle empty source", () => {
    const result = transformSource("", { target: "dom" })

    expect(result.ir).toHaveLength(0)
    expect(result.code).toBeDefined()
  })

  it("should handle source with no builder calls", () => {
    const source = `
      const x = 1
      const y = 2
      console.log(x + y)
    `

    const result = transformSource(source, { target: "dom" })

    expect(result.ir).toHaveLength(0)
  })

  it("should include filename in error context when provided", () => {
    // This test verifies the filename option is accepted
    const source = `
      div(() => {
        h1("Test")
      })
    `

    const result = transformSource(source, {
      target: "dom",
      filename: "test-component.ts",
    })

    expect(result.ir).toHaveLength(1)
  })
})

// =============================================================================
// IR Structure Tests
// =============================================================================

describe("transformSource - IR structure", () => {
  it("should capture nested element structure in IR", () => {
    const source = `
      div(() => {
        header(() => {
          h1("Title")
          nav(() => {
            a("Link")
          })
        })
      })
    `

    const result = transformSource(source, { target: "dom" })

    const builder = result.ir[0]
    expect(builder.factoryName).toBe("div")
    expect(builder.children).toHaveLength(1)
    expect(builder.children[0].kind).toBe("element")

    if (builder.children[0].kind === "element") {
      const header = builder.children[0]
      expect(header.tag).toBe("header")
      expect(header.children).toHaveLength(2) // h1 and nav
    }
  })

  it("should capture props as attributes in IR", () => {
    const source = `
      input({ type: "text", placeholder: "Enter name", disabled: true }, () => {})
    `

    const result = transformSource(source, { target: "dom" })

    const builder = result.ir[0]
    expect(builder.props.length).toBeGreaterThanOrEqual(3)

    const typeAttr = builder.props.find(p => p.name === "type")
    expect(typeAttr).toBeDefined()

    const placeholderAttr = builder.props.find(p => p.name === "placeholder")
    expect(placeholderAttr).toBeDefined()
  })

  it("should separate event handlers from attributes in IR", () => {
    const source = `
      button({
        class: "btn",
        onClick: handleClick,
        onMouseEnter: handleHover
      }, () => {
        span("Click")
      })
    `

    const result = transformSource(source, { target: "dom" })

    const builder = result.ir[0]
    expect(builder.props).toHaveLength(1) // Only class
    expect(builder.props[0].name).toBe("class")
    expect(builder.eventHandlers).toHaveLength(2)
    expect(builder.eventHandlers.map(h => h.event)).toContain("click")
    expect(builder.eventHandlers.map(h => h.event)).toContain("mouseenter")
  })
})

// =============================================================================
// collectRequiredImports Tests
// =============================================================================

/**
 * Create a dependency with a given source and optional delta kind.
 * Defaults to "replace" for simplicity in tests.
 */
function dep(source: string, deltaKind: DeltaKind = "replace"): Dependency {
  return { source, deltaKind }
}

describe("collectRequiredImports", () => {
  const span = createSpan(1, 0, 1, 10)

  it("should return empty set for static-only builders", () => {
    const builder = createBuilder("div", [], [], [], span)

    const { runtime } = collectRequiredImports([builder])

    expect(runtime.size).toBe(0)
  })

  it("should include subscribe for reactive builders", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [
        {
          kind: "content",
          source: "doc.count()",
          bindingTime: "reactive",
          dependencies: [dep("doc.count")],
          span,
        },
      ],
      span,
    )

    const { runtime } = collectRequiredImports([builder])

    expect(runtime.has("valueRegion")).toBe(true)
  })

  it("should include listRegion for reactive loops", () => {
    const loop = createLoop(
      "doc.items",
      "reactive",
      "item",
      null,
      [],
      [dep("doc.items")],
      span,
    )
    const builder = createBuilder("div", [], [], [loop], span)

    const { runtime } = collectRequiredImports([builder])

    expect(runtime.has("listRegion")).toBe(true)
  })

  it("should include filteredListRegion instead of listRegion for loops with filter metadata", () => {
    const filter: FilterMetadata = {
      predicate: createContent(
        "recipe.vegetarian()",
        "reactive",
        [dep("recipe.vegetarian")],
        span,
      ),
      itemDeps: [
        {
          source: "recipe.vegetarian",
          deltaKind: "replace",
          classification: "item",
        } satisfies ClassifiedDependency,
      ],
      externalDeps: [],
    }
    const loop = createLoop(
      "doc.recipes",
      "reactive",
      "recipe",
      null,
      [],
      [dep("doc.recipes")],
      span,
      filter,
    )
    const builder = createBuilder("div", [], [], [loop], span)

    const { runtime } = collectRequiredImports([builder])

    expect(runtime.has("filteredListRegion")).toBe(true)
    expect(runtime.has("listRegion")).toBe(false)
  })

  it("should include conditionalRegion for reactive conditionals", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [
        {
          kind: "conditional",
          branches: [
            {
              condition: {
                kind: "content",
                source: "doc.visible()",
                bindingTime: "reactive",
                dependencies: [dep("doc.visible")],
                span,
              },
              body: [],
              slotKind: "range",
              span,
            },
          ],
          subscriptionTarget: dep("doc.visible"),
          span,
        },
      ],
      span,
    )

    const { runtime } = collectRequiredImports([builder])

    expect(runtime.has("conditionalRegion")).toBe(true)
  })

  it("should NOT include conditionalRegion for render-time conditionals", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [
        {
          kind: "conditional",
          branches: [
            {
              condition: {
                kind: "content",
                source: "true",
                bindingTime: "render",
                dependencies: [],
                span,
              },
              body: [],
              slotKind: "range",
              span,
            },
          ],
          subscriptionTarget: null,
          span,
        },
      ],
      span,
    )

    const { runtime } = collectRequiredImports([builder])

    // Render-time conditionals emit inline if, no runtime import needed
    expect(runtime.has("conditionalRegion")).toBe(false)
  })

  it("should collect imports from multiple builders", () => {
    const builder1 = createBuilder(
      "div",
      [],
      [],
      [
        createLoop(
          "doc.items",
          "reactive",
          "item",
          null,
          [],
          [dep("doc.items")],
          span,
        ),
      ],
      span,
    )
    const builder2 = createBuilder(
      "div",
      [],
      [],
      [
        {
          kind: "conditional",
          branches: [],
          subscriptionTarget: dep("doc.visible"),
          span,
        },
      ],
      span,
    )

    const { runtime } = collectRequiredImports([builder1, builder2])

    expect(runtime.has("listRegion")).toBe(true)
    expect(runtime.has("conditionalRegion")).toBe(true)
  })

  it("should include valueRegion for multi-dependency text content", () => {
    const multiDepContent = {
      kind: "content" as const,
      source: "first() + ' ' + last()",
      bindingTime: "reactive" as const,
      dependencies: [dep("first"), dep("last")],
      span,
    }
    const builder = createBuilder("span", [], [], [multiDepContent], span)
    builder.isReactive = true

    const { runtime } = collectRequiredImports([builder])

    expect(runtime.has("valueRegion")).toBe(true)
  })

  it("should include valueRegion for multi-dependency attributes", () => {
    const multiDepAttr = {
      name: "class",
      value: {
        kind: "content" as const,
        source: "theme() + ' ' + variant()",
        bindingTime: "reactive" as const,
        dependencies: [dep("theme"), dep("variant")],
        span,
      },
    }
    const element = {
      kind: "element" as const,
      tag: "div",
      attributes: [multiDepAttr],
      eventHandlers: [],
      children: [],
      span,
      isReactive: true,
    }
    const builder = createBuilder("div", [], [], [element], span)
    builder.isReactive = true

    const { runtime } = collectRequiredImports([builder])

    expect(runtime.has("valueRegion")).toBe(true)
  })

  it("should include textRegion for direct TextRef read", () => {
    const directTextRead = {
      kind: "content" as const,
      source: "doc.title()",
      bindingTime: "reactive" as const,
      dependencies: [dep("doc.title", "text")],
      span,
      directReadSource: "doc.title",
    }
    const builder = createBuilder("p", [], [], [directTextRead], span)
    builder.isReactive = true

    const { runtime } = collectRequiredImports([builder])

    expect(runtime.has("textRegion")).toBe(true)
  })

  it("should NOT include textRegion for non-direct TextRef read", () => {
    const nonDirectRead = {
      kind: "content" as const,
      source: "doc.title().toUpperCase()",
      bindingTime: "reactive" as const,
      dependencies: [dep("doc.title", "text")],
      span,
      // no directReadSource — this is not a direct read
    }
    const builder = createBuilder("p", [], [], [nonDirectRead], span)
    builder.isReactive = true

    const { runtime } = collectRequiredImports([builder])

    expect(runtime.has("textRegion")).toBe(false)
  })

  it("should NOT include textRegion for non-text deltaKind even with directReadSource", () => {
    const replaceRead = {
      kind: "content" as const,
      source: "count()",
      bindingTime: "reactive" as const,
      dependencies: [dep("count", "replace")], // deltaKind is "replace", not "text"
      span,
      directReadSource: "count",
    }
    const builder = createBuilder("span", [], [], [replaceRead], span)
    builder.isReactive = true

    const { runtime } = collectRequiredImports([builder])

    expect(runtime.has("textRegion")).toBe(false)
    expect(runtime.has("valueRegion")).toBe(true)
    expect(runtime.has("read")).toBe(true)
  })

  it("should NOT include textRegion for multi-dependency content", () => {
    const multiDepRead = {
      kind: "content" as const,
      source: "doc.title() + doc.subtitle()",
      bindingTime: "reactive" as const,
      dependencies: [dep("doc.title", "text"), dep("doc.subtitle", "text")],
      span,
      // no directReadSource — multi-dep is never direct
    }
    const builder = createBuilder("span", [], [], [multiDepRead], span)
    builder.isReactive = true

    const { runtime } = collectRequiredImports([builder])

    expect(runtime.has("textRegion")).toBe(false)
    expect(runtime.has("valueRegion")).toBe(true)
  })

  it("should include inputTextRegion for value attribute with direct TextRef read", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [
        {
          kind: "element" as const,
          tag: "input",
          attributes: [
            {
              name: "value",
              value: {
                kind: "content" as const,
                source: "doc.title()",
                bindingTime: "reactive" as const,
                dependencies: [dep("doc.title", "text")],
                span,
                directReadSource: "doc.title",
              },
            },
          ],
          eventHandlers: [],
          children: [],
          isReactive: true,
          span,
        },
      ],
      span,
    )
    builder.isReactive = true

    const { runtime } = collectRequiredImports([builder])

    expect(runtime.has("inputTextRegion")).toBe(true)
  })

  it("should NOT include inputTextRegion for value attribute without directReadSource", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [
        {
          kind: "element" as const,
          tag: "input",
          attributes: [
            {
              name: "value",
              value: {
                kind: "content" as const,
                source: "doc.title().toUpperCase()",
                bindingTime: "reactive" as const,
                dependencies: [dep("doc.title", "text")],
                span,
                // no directReadSource
              },
            },
          ],
          eventHandlers: [],
          children: [],
          isReactive: true,
          span,
        },
      ],
      span,
    )
    builder.isReactive = true

    const { runtime } = collectRequiredImports([builder])

    expect(runtime.has("inputTextRegion")).toBe(false)
  })

  it("should NOT include inputTextRegion for value attribute with non-text deltaKind", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [
        {
          kind: "element" as const,
          tag: "input",
          attributes: [
            {
              name: "value",
              value: {
                kind: "content" as const,
                source: "doc.selected()",
                bindingTime: "reactive" as const,
                dependencies: [dep("doc.selected", "replace")],
                span,
                directReadSource: "doc.selected",
              },
            },
          ],
          eventHandlers: [],
          children: [],
          isReactive: true,
          span,
        },
      ],
      span,
    )
    builder.isReactive = true

    const { runtime } = collectRequiredImports([builder])

    expect(runtime.has("inputTextRegion")).toBe(false)
  })

  it("should NOT include inputTextRegion for non-value attribute even with TextRef", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [
        {
          kind: "element" as const,
          tag: "div",
          attributes: [
            {
              name: "class",
              value: {
                kind: "content" as const,
                source: "doc.theme()",
                bindingTime: "reactive" as const,
                dependencies: [dep("doc.theme", "text")],
                span,
                directReadSource: "doc.theme",
              },
            },
          ],
          eventHandlers: [],
          children: [],
          isReactive: true,
          span,
        },
      ],
      span,
    )
    builder.isReactive = true

    const { runtime } = collectRequiredImports([builder])

    expect(runtime.has("inputTextRegion")).toBe(false)
  })
})

// =============================================================================
// mergeImports Tests
// =============================================================================

describe("mergeImports", () => {
  function createSourceFile(code: string) {
    const project = new Project({ useInMemoryFileSystem: true })
    return project.createSourceFile("test.ts", code)
  }

  it("should add new import when no kyneta import exists", () => {
    const sourceFile = createSourceFile("const x = 1\nconst y = 2")

    mergeImports(sourceFile, {
      runtime: new Set(["subscribe", "listRegion"]),
    })

    const result = sourceFile.getFullText()
    expect(result).toContain("listRegion")
    expect(result).toContain("subscribe")
    expect(result).toContain("@kyneta/cast/runtime")
  })

  it("should merge imports with existing cast/runtime import", () => {
    const importLine = 'import { subscribe } from "@kyneta/cast/runtime"'
    const sourceFile = createSourceFile(`${importLine}\n\nconst app = div()`)

    mergeImports(sourceFile, {
      runtime: new Set(["subscribe", "listRegion"]),
    })

    const result = sourceFile.getFullText()
    expect(result).toContain("subscribe")
    expect(result).toContain("listRegion")
    const importMatches = result.match(/@kyneta\/cast\/runtime/g) || []
    expect(importMatches.length).toBe(1)
  })

  it("should not duplicate existing imports", () => {
    const importLine = 'import { subscribe } from "@kyneta/cast/runtime"'
    const sourceFile = createSourceFile(`${importLine}\n\nconst app = div()`)

    mergeImports(sourceFile, {
      runtime: new Set(["subscribe", "listRegion"]),
    })

    const result = sourceFile.getFullText()
    // "subscribe" appears once in import, "listRegion" added
    expect(result).toContain("subscribe")
    expect(result).toContain("listRegion")
    // Only one import statement for /runtime
    const importMatches = result.match(/@kyneta\/cast\/runtime/g) || []
    expect(importMatches.length).toBe(1)
  })

  it("should do nothing when no imports needed", () => {
    const sourceFile = createSourceFile("const x = 1")

    mergeImports(sourceFile, {
      runtime: new Set(),
    })

    const result = sourceFile.getFullText()
    expect(result).not.toContain("@kyneta/cast")
  })

  it("should preserve other imports", () => {
    const lines = [
      'import { describe } from "vitest"',
      'import { CHANGEFEED } from "@kyneta/changefeed"',
      "",
      "const x = 1",
    ]
    const sourceFile = createSourceFile(lines.join("\n"))

    mergeImports(sourceFile, {
      runtime: new Set(["subscribe"]),
    })

    const result = sourceFile.getFullText()
    expect(result).toContain("describe")
    expect(result).toContain("CHANGEFEED")
    expect(result).toContain("subscribe")
  })
})

// =============================================================================
// transformSourceInPlace Tests
// =============================================================================

describe("transformSourceInPlace", () => {
  it("should replace builder calls in-place", () => {
    const lines = ["const app = div(() => {", '  h1("Hello")', "})"]
    const source = lines.join("\n")

    const result = transformSourceInPlace(source)
    const code = result.sourceFile.getFullText()

    expect(code).toContain("document.createElement")
    expect(code).not.toContain("div(() =>")
    expect(code).not.toContain('h1("Hello")')
    expect(code).toContain("const app =")
  })

  it("should preserve non-builder code exactly", () => {
    const lines = [
      "// This is a comment",
      'const greeting = "Hello"',
      "",
      "function helper(x: number) {",
      "  return x * 2",
      "}",
      "",
      "const app = div(() => {",
      "  h1(greeting)",
      "})",
      "",
      "export { app, helper }",
    ]
    const source = lines.join("\n")

    const result = transformSourceInPlace(source)
    const code = result.sourceFile.getFullText()

    expect(code).toContain("// This is a comment")
    expect(code).toContain('const greeting = "Hello"')
    expect(code).toContain("function helper(x: number)")
    expect(code).toContain("return x * 2")
    expect(code).toContain("export { app, helper }")
  })

  it("should handle multiple builder calls", () => {
    const lines = [
      "const header = div(() => {",
      '  h1("Header")',
      "})",
      "",
      "const content = section(() => {",
      '  p("Content")',
      "})",
      "",
      "const footer = div(() => {",
      '  span("Footer")',
      "})",
    ]
    const source = lines.join("\n")

    const result = transformSourceInPlace(source)
    const code = result.sourceFile.getFullText()

    expect(code).toContain("const header =")
    expect(code).toContain("const content =")
    expect(code).toContain("const footer =")

    // With template cloning, we should have:
    // - Template declarations using createElement("template")
    // - cloneNode calls instead of individual createElement calls
    const templateCreateCount = (
      code.match(/document\.createElement\("template"\)/g) || []
    ).length
    expect(templateCreateCount).toBeGreaterThanOrEqual(3) // one per builder

    const cloneNodeCount = (code.match(/\.cloneNode\(true\)/g) || []).length
    expect(cloneNodeCount).toBeGreaterThanOrEqual(3) // one per builder

    expect(code).not.toContain("div(() =>")
    expect(code).not.toContain("section(() =>")
  })

  it("should return correct IR nodes", () => {
    const lines = [
      "const a = div(() => {",
      '  h1("A")',
      "})",
      "const b = div(() => {",
      '  h1("B")',
      "})",
    ]
    const source = lines.join("\n")

    const result = transformSourceInPlace(source)

    expect(result.ir.length).toBe(2)
    expect(result.ir[0].factoryName).toBe("div")
    expect(result.ir[1].factoryName).toBe("div")
  })

  it("should return correct required imports for list regions", () => {
    const lines = [
      'import { type HasChangefeed } from "@kyneta/changefeed"',
      'type SequenceChange<T = unknown> = { readonly type: "sequence"; readonly ops: readonly unknown[] }',
      "interface ListRef<T> extends HasChangefeed<T[], SequenceChange<T>> {",
      "  readonly length: number",
      "  at(index: number): T | undefined",
      "  [Symbol.iterator](): Iterator<T>",
      "}",
      "declare const items: ListRef<string>",
      "",
      "const app = div(() => {",
      "  for (const item of items) {",
      "    li(item)",
      "  }",
      "})",
    ]
    const source = lines.join("\n")

    const result = transformSourceInPlace(source)

    expect(result.requiredImports.runtime.has("listRegion")).toBe(true)
  })

  it("should return empty required imports for static content", () => {
    const lines = [
      "const app = div(() => {",
      '  h1("Static Title")',
      '  p("Static Content")',
      "})",
    ]
    const source = lines.join("\n")

    const result = transformSourceInPlace(source)

    expect(result.requiredImports.runtime.size).toBe(0)
  })

  it("should handle deeply nested structures", () => {
    const lines = [
      "const app = div(() => {",
      "  header(() => {",
      "    nav(() => {",
      "      ul(() => {",
      '        li("Item 1")',
      '        li("Item 2")',
      "      })",
      "    })",
      "  })",
      "})",
    ]
    const source = lines.join("\n")

    const result = transformSourceInPlace(source)
    const code = result.sourceFile.getFullText()

    expect(result.ir.length).toBe(1)
    expect(code).toContain("document.createElement")
    expect(code).not.toContain("div(() =>")
  })

  it("should preserve existing imports", () => {
    const lines = [
      'import { describe } from "vitest"',
      'import { CHANGEFEED } from "@kyneta/changefeed"',
      "",
      "const x = 1",
      "",
      "const app = div(() => {",
      '  h1("App")',
      "})",
    ]
    const source = lines.join("\n")

    const result = transformSourceInPlace(source)
    const code = result.sourceFile.getFullText()

    expect(code).toContain("describe")
    expect(code).toContain("CHANGEFEED")
  })
})

// =============================================================================
// transformSourceInPlace - HTML Target Tests
// =============================================================================

describe("transformSourceInPlace - HTML target", () => {
  it("should generate HTML template literal instead of DOM code", () => {
    const source = `const app = div(() => {\n  h1("Hello")\n})`

    const result = transformSourceInPlace(source, { target: "html" })
    const code = result.sourceFile.getFullText()

    // Should contain HTML tags in template literal
    expect(code).toContain("<div>")
    expect(code).toContain("<h1>")
    expect(code).toContain("Hello")
    expect(code).toContain("</h1>")
    expect(code).toContain("</div>")

    // Should NOT contain DOM APIs
    expect(code).not.toContain("document.createElement")
    expect(code).not.toContain("appendChild")
  })

  it("should inject __escapeHtml helper for HTML target", () => {
    const source = `const app = div(() => {\n  h1("Hello")\n})`

    const result = transformSourceInPlace(source, { target: "html" })
    const code = result.sourceFile.getFullText()

    expect(code).toContain("function __escapeHtml(str)")
  })

  it("should not inject __escapeHtml helper for DOM target", () => {
    const source = `const app = div(() => {\n  h1("Hello")\n})`

    const result = transformSourceInPlace(source, { target: "dom" })
    const code = result.sourceFile.getFullText()

    expect(code).not.toContain("__escapeHtml")
  })

  it("should preserve non-builder code in HTML target", () => {
    const lines = [
      'const greeting = "Hello"',
      "",
      "const app = div(() => {",
      "  h1(greeting)",
      "})",
      "",
      "console.log(app)",
    ]
    const source = lines.join("\n")

    const result = transformSourceInPlace(source, { target: "html" })
    const code = result.sourceFile.getFullText()

    expect(code).toContain('const greeting = "Hello"')
    expect(code).toContain("console.log(app)")
    expect(code).toContain("<div>")
    expect(code).toContain("<h1>")
  })

  it("should generate list map expression for for-of loops", () => {
    const lines = [
      'import { type HasChangefeed } from "@kyneta/changefeed"',
      'type SequenceChange<T = unknown> = { readonly type: "sequence"; readonly ops: readonly unknown[] }',
      "interface ListRef<T> extends HasChangefeed<T[], SequenceChange<T>> { readonly length: number; at(index: number): T | undefined; [Symbol.iterator](): Iterator<T> }",
      "declare const items: ListRef<string>",
      "",
      "const app = div(() => {",
      "  for (const item of items) {",
      "    li(item)",
      "  }",
      "})",
    ]
    const source = lines.join("\n")

    const result = transformSourceInPlace(source, { target: "html" })
    const code = result.sourceFile.getFullText()

    // Should produce a for...of loop for the list using spread syntax for ref preservation
    expect(code).toContain("for (const")
    expect(code).toContain("[...")
    expect(code).toContain("<li>")
    // Should have hydration markers
    expect(code).toContain("kyneta:list")
  })

  it("should generate ternary for conditional regions", () => {
    const lines = [
      'import { type HasChangefeed } from "@kyneta/changefeed"',
      'type ReplaceChange<T = unknown> = { readonly type: "replace"; readonly value: T }',
      'type IncrementChange = { readonly type: "increment"; readonly amount: number }',
      "interface CounterRef extends HasChangefeed<number, IncrementChange> { (): number }",
      "declare const count: CounterRef",
      "",
      "const app = div(() => {",
      "  if (count > 0) {",
      '    p("Has items")',
      "  } else {",
      '    p("Empty")',
      "  }",
      "})",
    ]
    const source = lines.join("\n")

    const result = transformSourceInPlace(source, { target: "html" })
    const code = result.sourceFile.getFullText()

    // Should produce a ternary for the conditional
    // ExpressionIR auto-read inserts () on the CounterRef
    expect(code).toContain("count() > 0")
    expect(code).toContain("Has items")
    expect(code).toContain("Empty")
    // Dissolution produces inline ternary — no hydration markers needed
    expect(code).toContain('count() > 0 ? "Has items" : "Empty"')
    expect(code).not.toContain("kyneta:if")
  })

  it("should dissolve conditional on template cloning path (DOM target)", () => {
    const lines = [
      'import { type HasChangefeed } from "@kyneta/changefeed"',
      'type ReplaceChange<T = unknown> = { readonly type: "replace"; readonly value: T }',
      'type IncrementChange = { readonly type: "increment"; readonly amount: number }',
      "interface CounterRef extends HasChangefeed<number, IncrementChange> { (): number }",
      "declare const count: CounterRef",
      "",
      "const app = div(() => {",
      "  if (count > 0) {",
      '    p("Has items")',
      "  } else {",
      '    p("Empty")',
      "  }",
      "})",
    ]
    const source = lines.join("\n")

    const result = transformSourceInPlace(source, { target: "dom" })
    const code = result.sourceFile.getFullText()

    // Template cloning path should dissolve — no conditionalRegion
    expect(code).not.toContain("conditionalRegion")
    expect(code).not.toContain("whenTrue")
    expect(code).not.toContain("whenFalse")

    // Template HTML should not contain region comment markers
    expect(code).not.toContain("kyneta:if")

    // Should contain ternary from dissolution
    expect(code).toContain("?")
    expect(code).toContain('"Has items"')
    expect(code).toContain('"Empty"')
  })

  it("should produce a render function (not a scope factory)", () => {
    const source = `const app = div(() => {\n  h1("Hello")\n})`

    const result = transformSourceInPlace(source, { target: "html" })
    const code = result.sourceFile.getFullText()

    // HTML target produces () => `...` (no scope parameter)
    expect(code).toContain("const app = () =>")
    // DOM target produces (scope) => { ... }
    expect(code).not.toContain("(scope) =>")
  })
})

// =============================================================================
// Reactive Type Resolution Tests
// =============================================================================

describe("reactive type resolution from @kyneta/schema", () => {
  it("should resolve CounterRef type with CHANGEFEED protocol", () => {
    const source = `
      import { type HasChangefeed } from "@kyneta/changefeed"
      type IncrementChange = { readonly type: "increment"; readonly amount: number }
      interface CounterRef extends HasChangefeed<number, IncrementChange> { (): number }
      declare const count: CounterRef

      div(() => {
        if (count > 0) {
          p("Has items")
        }
      })
    `

    const result = transformSource(source, { target: "dom" })

    // Should generate conditionalRegion because CounterRef is detected as reactive
    expect(result.code).toContain("conditionalRegion")
    expect(result.ir[0].children[0].kind).toBe("conditional")
  })

  it("should resolve createTypedDoc return type", () => {
    const source = `
      import { type HasChangefeed } from "@kyneta/changefeed"
      type SequenceChange<T = unknown> = { readonly type: "sequence"; readonly ops: readonly unknown[] }
      type MapChange = { readonly type: "map"; readonly set?: Record<string, unknown>; readonly delete?: readonly string[] }
      type ReplaceChange<T = unknown> = { readonly type: "replace"; readonly value: T }
      type IncrementChange = { readonly type: "increment"; readonly amount: number }
      interface TextRef extends HasChangefeed<string, { readonly type: "text"; readonly ops: readonly unknown[] }> { (): string; [Symbol.toPrimitive](hint: string): string }
      interface CounterRef extends HasChangefeed<number, IncrementChange> { (): number; [Symbol.toPrimitive](hint: string): number | string }
      interface ListRef<T> extends HasChangefeed<T[], SequenceChange<T>> { (): T[]; readonly length: number; get(index: number): T | undefined; at(index: number): T | undefined; [Symbol.iterator](): Iterator<T> }

      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string())
      })

      declare const doc: { items: ListRef<string> }

      div(() => {
        for (const item of doc.items) {
          li(item)
        }
      })
    `

    const result = transformSource(source, { target: "dom" })

    // Should generate listRegion because doc.items is ListRef
    expect(result.code).toContain("listRegion")
  })

  it("should produce listRegion for for-of over inline ListRef", () => {
    // Critical test: the compiler must resolve ListRef with CHANGEFEED
    // to detect doc.todos as reactive and generate listRegion
    const source = withTypes(`
      interface TodoDoc {
        todos: ListRef<string>
      }

      declare const doc: TodoDoc

      const app = div(() => {
        ul(() => {
          for (const item of doc.todos) {
            li(item)
          }
        })
      })
    `)

    const result = transformSource(source, { target: "dom" })

    // Critical assertion: listRegion must be generated
    expect(result.code).toContain("listRegion")

    // Verify IR structure
    expect(result.ir.length).toBe(1)
    const divChildren = result.ir[0].children
    expect(divChildren.length).toBe(1)
    expect(divChildren[0].kind).toBe("element") // ul

    const ulElement = divChildren[0]
    if (ulElement.kind === "element") {
      expect(ulElement.children.length).toBe(1)
      expect(ulElement.children[0].kind).toBe("loop")
    }
  })

  it("should produce deltaKind 'text' and valueRegion for TextRef template coercion", () => {
    const source = `
      import { type HasChangefeed } from "@kyneta/changefeed"
      interface TextRef extends HasChangefeed<string, { readonly type: "text"; readonly ops: readonly unknown[] }> { (): string; [Symbol.toPrimitive](hint: string): string }
      declare const title: TextRef
      div(() => { h1(\`\${title}\`) })
    `

    const result = transformSource(source, { target: "dom" })

    // IR should have deltaKind "text" but template coercion returns string → no directReadSource
    const h1 = result.ir[0].children[0] as any
    const content = h1.children[0]
    expect(content.dependencies[0].deltaKind).toBe("text")

    // Codegen should emit valueRegion (not textRegion since template coercion has no directReadSource)
    expect(result.code).toContain("valueRegion(")
  })
})

// =============================================================================
// Schema-Inferred Reactive Detection Tests
// =============================================================================

describe("schema-inferred reactive detection (zero ceremony)", () => {
  it("should detect reactive types from TypedDoc without explicit interface", () => {
    const source = withTypes(`
      declare const doc: TypedDoc<{ title: TextRef; todos: ListRef<string> }>

      div(() => {
        h1(\`\${doc.title}\`)
        for (const item of doc.todos) {
          li(item)
        }
      })
    `)

    const result = transformSource(source, { target: "dom" })

    // template literal coercion returns string → no directReadSource → valueRegion
    expect(result.code).toContain("valueRegion")
    // Should detect ListRef on doc.todos → listRegion
    expect(result.code).toContain("listRegion")
    // Builder should be reactive
    expect(result.ir[0].isReactive).toBe(true)
  })

  it("should work with createTypedDoc options parameter", () => {
    const source = `
      import { type HasChangefeed } from "@kyneta/changefeed"
      type IncrementChange = { readonly type: "increment"; readonly amount: number }
      type MapChange = { readonly type: "map" }
      interface CounterRef extends HasChangefeed<number, IncrementChange> { (): number }
      type TypedDoc<S> = S & HasChangefeed<unknown, MapChange>
      declare function createTypedDoc<S>(schema: unknown, opts?: unknown): TypedDoc<S>
      const Shape = { doc: (s: any) => s, counter: () => ({}) }

      const Schema = Shape.doc({
        title: Shape.text(),
        items: Shape.list(Shape.plain.string()),
      })

      const doc = createTypedDoc(Schema, { doc: {} as any })

      div(() => {
        h1(\`\${doc.title}\`)
        for (const item of doc.items) {
          li(item)
        }
      })
    `

    const result = transformSource(source, { target: "dom" })

    expect(result.code).toContain("valueRegion")
    expect(result.code).toContain("listRegion")
  })

  it("should produce both DOM and HTML targets from same schema-inferred source", () => {
    const source = `
      import { type HasChangefeed } from "@kyneta/changefeed"
      type IncrementChange = { readonly type: "increment"; readonly amount: number }
      type MapChange = { readonly type: "map" }
      interface CounterRef extends HasChangefeed<number, IncrementChange> { (): number }
      type TypedDoc<S> = S & HasChangefeed<unknown, MapChange>
      declare function createTypedDoc<S>(schema: unknown): TypedDoc<S>
      const Shape = { doc: (s: any) => s, counter: () => ({}) }

      const Schema = Shape.doc({
        title: Shape.text(),
        items: Shape.list(Shape.plain.string()),
      })

      const doc = createTypedDoc(Schema)

      div(() => {
        h1(\`\${doc.title}\`)
        if (doc.items().length > 0) {
          ul(() => {
            for (const item of doc.items) {
              li(item)
            }
          })
        } else {
          p("No items")
        }
      })
    `

    const domResult = transformSource(source, { target: "dom" })
    const htmlResult = transformSource(source, { target: "html" })

    // DOM target: reactive runtime calls
    expect(domResult.code).toContain("valueRegion")
    expect(domResult.code).toContain("listRegion")
    expect(domResult.code).toContain("conditionalRegion")

    // HTML target: accumulation-line architecture with for...of loops and if/else blocks
    expect(htmlResult.code).toContain("for (const")
    expect(htmlResult.code).toContain("<h1>")
    expect(htmlResult.code).toContain("kyneta:list")
    expect(htmlResult.code).toContain("kyneta:if")
  })
})

// =============================================================================
// Bare Reactive Ref in Content Position Tests
// =============================================================================

describe("bare reactive ref in content position", () => {
  it("compiles bare CounterRef to valueRegion with auto-read", () => {
    const source = withTypes(`
      declare const doc: { count: CounterRef }
      div(() => {
        span(doc.count)
      })
    `)
    const result = transformSource(source, { target: "dom" })
    expect(result.code).toContain("valueRegion(")
    // Auto-read: bare changefeed in content position → doc.count()
    expect(result.code).toContain("doc.count()")
  })

  it("still supports explicit String() coercion with snapshot", () => {
    const source = `
      import { type HasChangefeed } from "@kyneta/changefeed"
      interface TextRef extends HasChangefeed<string, { readonly type: "text"; readonly ops: readonly unknown[] }> { (): string; [Symbol.toPrimitive](hint: string): string }
      declare const doc: { title: TextRef }
      div(() => {
        p(String(doc.title()))
      })
    `
    const result = transformSource(source, { target: "dom" })
    // String() wraps an explicit snapshot — the developer writes doc.title()
    // to read the value before passing to String(). No directReadSource → valueRegion.
    expect(result.code).toContain("valueRegion(")
    expect(result.code).toContain("String(doc.title())")
  })

  it("bare ref inside expression is not an implicit read", () => {
    const source = `
      import { type HasChangefeed } from "@kyneta/changefeed"
      interface TextRef extends HasChangefeed<string, { readonly type: "text"; readonly ops: readonly unknown[] }> { (): string; [Symbol.toPrimitive](hint: string): string }
      declare const doc: { first: TextRef, last: TextRef }
      div(() => {
        p(\`\${doc.first} \${doc.last}\`)
      })
    `
    const result = transformSource(source, { target: "dom" })
    // Expression with multiple deps, no directReadSource → valueRegion (not textRegion)
    expect(result.code).toContain("valueRegion(")
    expect(result.code).not.toContain("textRegion(")
  })
})

// =============================================================================
// Dependency subsumption — child deps make parent deps redundant
// =============================================================================

describe("dependency subsumption", () => {
  it("doc.title template coercion with reactive TypedDoc produces valueRegion (not multi-dep)", () => {
    // TypedDoc exposes [CHANGEFEED], so `doc` is reactive.
    // Without subsumption, extractDependencies captures both:
    //   { source: "doc", deltaKind: "map" }
    //   { source: "doc.title", deltaKind: "text" }
    // That gives dependencies.length === 2, breaking isTextRegionContent.
    // Subsumption drops "doc" because "doc.title" is more specific.
    // template literal coercion returns string (not Changefeed) → no directReadSource → valueRegion
    const source = withTypes(`
      declare const doc: TypedDoc<{ title: TextRef }>
      div(() => { h1(\`\${doc.title}\`) })
    `)
    const result = transformSource(source, { target: "dom" })
    expect(result.code).toContain("valueRegion")
  })
})
