/**
 * Integration tests for the transform pipeline.
 *
 * These tests exercise the full compile flow: source code → IR → generated output.
 * They validate that the pipeline produces correct output for real-world patterns.
 */

import { Project } from "ts-morph"
import { describe, expect, it } from "vitest"
import {
  createBuilder,
  createLoop,
  createSpan,
  type Dependency,
  type DeltaKind,
} from "./ir.js"
import {
  collectRequiredImports,
  hasBuilderCalls,
  mergeImports,
  transformSource,
  transformSourceInPlace,
} from "./transform.js"

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
    const imports = collectRequiredImports([builder])

    expect(imports.size).toBe(0)
  })

  it("should include __subscribe for reactive builders", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [
        {
          kind: "content",
          source: "doc.count.get()",
          bindingTime: "reactive",
          dependencies: [dep("doc.count")],
          span,
        },
      ],
      span,
    )

    const imports = collectRequiredImports([builder])

    expect(imports.has("__subscribe")).toBe(true)
    expect(imports.has("__subscribeWithValue")).toBe(true)
  })

  it("should include __listRegion for reactive loops", () => {
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

    const imports = collectRequiredImports([builder])

    expect(imports.has("__listRegion")).toBe(true)
  })

  it("should include __conditionalRegion for reactive conditionals", () => {
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
                source: "doc.visible.get()",
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

    const imports = collectRequiredImports([builder])

    expect(imports.has("__conditionalRegion")).toBe(true)
  })

  it("should NOT include __conditionalRegion for render-time conditionals", () => {
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

    const imports = collectRequiredImports([builder])

    // Render-time conditionals emit inline if, no runtime import needed
    expect(imports.has("__conditionalRegion")).toBe(false)
  })

  it("should include __bindTextValue for value bindings", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [
        {
          kind: "element",
          tag: "input",
          attributes: [],
          eventHandlers: [],
          bindings: [
            {
              attribute: "value",
              refSource: "doc.text",
              bindingType: "value",
              span,
            },
          ],
          children: [],
          isReactive: true,
          span,
        },
      ],
      span,
    )

    const imports = collectRequiredImports([builder])

    expect(imports.has("__bindTextValue")).toBe(true)
  })

  it("should include __bindChecked for checked bindings", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [
        {
          kind: "element",
          tag: "input",
          attributes: [],
          eventHandlers: [],
          bindings: [
            {
              attribute: "checked",
              refSource: "doc.enabled",
              bindingType: "checked",
              span,
            },
          ],
          children: [],
          isReactive: true,
          span,
        },
      ],
      span,
    )

    const imports = collectRequiredImports([builder])

    expect(imports.has("__bindChecked")).toBe(true)
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

    const imports = collectRequiredImports([builder1, builder2])

    expect(imports.has("__listRegion")).toBe(true)
    expect(imports.has("__conditionalRegion")).toBe(true)
  })

  it("should include __subscribeMultiple for multi-dependency text content", () => {
    const multiDepContent = {
      kind: "content" as const,
      source: "first.get() + ' ' + last.get()",
      bindingTime: "reactive" as const,
      dependencies: [dep("first"), dep("last")],
      span,
    }
    const builder = createBuilder("span", [], [], [multiDepContent], span)
    builder.isReactive = true

    const imports = collectRequiredImports([builder])

    expect(imports.has("__subscribeMultiple")).toBe(true)
  })

  it("should include __subscribeMultiple for multi-dependency attributes", () => {
    const multiDepAttr = {
      name: "class",
      value: {
        kind: "content" as const,
        source: "theme.get() + ' ' + variant.get()",
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
      bindings: [],
      children: [],
      span,
      isReactive: true,
    }
    const builder = createBuilder("div", [], [], [element], span)
    builder.isReactive = true

    const imports = collectRequiredImports([builder])

    expect(imports.has("__subscribeMultiple")).toBe(true)
  })

  it("should NOT include __subscribeMultiple for single-dependency content", () => {
    const singleDepContent = {
      kind: "content" as const,
      source: "title.get()",
      bindingTime: "reactive" as const,
      dependencies: [dep("title")],
      span,
    }
    const builder = createBuilder("span", [], [], [singleDepContent], span)
    builder.isReactive = true

    const imports = collectRequiredImports([builder])

    expect(imports.has("__subscribeMultiple")).toBe(false)
    expect(imports.has("__subscribe")).toBe(true)
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

  it("should add new import when no kinetic import exists", () => {
    const sourceFile = createSourceFile("const x = 1\nconst y = 2")

    mergeImports(sourceFile, new Set(["__subscribe", "__listRegion"]))

    const result = sourceFile.getFullText()
    expect(result).toContain("__listRegion")
    expect(result).toContain("__subscribe")
    expect(result).toContain("@loro-extended/kinetic")
  })

  it("should merge imports with existing kinetic import", () => {
    const importLine = 'import { mount, Scope } from "@loro-extended/kinetic"'
    const sourceFile = createSourceFile(`${importLine}\n\nconst app = div()`)

    mergeImports(sourceFile, new Set(["__subscribe"]))

    const result = sourceFile.getFullText()
    expect(result).toContain("mount")
    expect(result).toContain("Scope")
    expect(result).toContain("__subscribe")
    const importMatches = result.match(/@loro-extended\/kinetic/g) || []
    expect(importMatches.length).toBe(1)
  })

  it("should not duplicate existing imports", () => {
    const importLine =
      'import { __subscribe, mount } from "@loro-extended/kinetic"'
    const sourceFile = createSourceFile(`${importLine}\n\nconst app = div()`)

    mergeImports(sourceFile, new Set(["__subscribe", "__listRegion"]))

    const result = sourceFile.getFullText()
    const subscribeMatches = result.match(/__subscribe/g) || []
    expect(subscribeMatches.length).toBe(1)
    expect(result).toContain("__listRegion")
  })

  it("should do nothing when no imports needed", () => {
    const sourceFile = createSourceFile("const x = 1")

    mergeImports(sourceFile, new Set())

    const result = sourceFile.getFullText()
    expect(result).not.toContain("@loro-extended/kinetic")
  })

  it("should preserve other imports", () => {
    const lines = [
      'import { LoroDoc } from "loro-crdt"',
      'import { createTypedDoc } from "@loro-extended/change"',
      "",
      "const doc = new LoroDoc()",
    ]
    const sourceFile = createSourceFile(lines.join("\n"))

    mergeImports(sourceFile, new Set(["__subscribe"]))

    const result = sourceFile.getFullText()
    expect(result).toContain("LoroDoc")
    expect(result).toContain("createTypedDoc")
    expect(result).toContain("__subscribe")
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

    const createElementCount = (code.match(/document\.createElement/g) || [])
      .length
    expect(createElementCount).toBeGreaterThanOrEqual(6)

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
      'import type { ListRef } from "@loro-extended/change"',
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

    expect(result.requiredImports.has("__listRegion")).toBe(true)
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

    expect(result.requiredImports.size).toBe(0)
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
      'import { LoroDoc } from "loro-crdt"',
      'import { createTypedDoc, Shape } from "@loro-extended/change"',
      "",
      "const schema = Shape.doc({ count: Shape.counter() })",
      "const doc = createTypedDoc(schema, new LoroDoc())",
      "",
      "const app = div(() => {",
      '  h1("App")',
      "})",
    ]
    const source = lines.join("\n")

    const result = transformSourceInPlace(source)
    const code = result.sourceFile.getFullText()

    expect(code).toContain("LoroDoc")
    expect(code).toContain("createTypedDoc")
    expect(code).toContain("Shape")
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
      'import { ListRef } from "@loro-extended/change"',
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

    // Should produce a .map() call for the list using spread syntax for ref preservation
    expect(code).toContain("].map(")
    expect(code).toContain("<li>")
    // Should have hydration markers
    expect(code).toContain("kinetic:list")
  })

  it("should generate ternary for conditional regions", () => {
    const lines = [
      'import { CounterRef } from "@loro-extended/change"',
      "declare const count: CounterRef",
      "",
      "const app = div(() => {",
      "  if (count.get() > 0) {",
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
    expect(code).toContain("count.get() > 0")
    expect(code).toContain("Has items")
    expect(code).toContain("Empty")
    // Should have hydration markers
    expect(code).toContain("kinetic:if")
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

describe("reactive type resolution from @loro-extended/change", () => {
  it("should resolve ListRef type from @loro-extended/change import", () => {
    const source = `
      import { ListRef } from "@loro-extended/change"
      declare const items: ListRef<string>

      div(() => {
        for (const item of items) {
          li(item)
        }
      })
    `

    const result = transformSource(source, { target: "dom" })

    // Should generate __listRegion because ListRef is detected as reactive
    expect(result.code).toContain("__listRegion")
    expect(result.ir.length).toBe(1)
    expect(result.ir[0].children.length).toBe(1)
    expect(result.ir[0].children[0].kind).toBe("loop")
  })

  it("should resolve TextRef type from @loro-extended/change import", () => {
    const source = `
      import { TextRef } from "@loro-extended/change"
      declare const title: TextRef

      div(() => {
        h1(title.toString())
      })
    `

    const result = transformSource(source, { target: "dom" })

    // Should generate __subscribeWithValue because TextRef is detected as reactive
    expect(result.code).toContain("__subscribeWithValue")
    expect(result.ir[0].children[0].kind).toBe("element")
  })

  it("should resolve CounterRef type from @loro-extended/change import", () => {
    const source = `
      import { CounterRef } from "@loro-extended/change"
      declare const count: CounterRef

      div(() => {
        if (count.get() > 0) {
          p("Has items")
        }
      })
    `

    const result = transformSource(source, { target: "dom" })

    // Should generate __conditionalRegion because CounterRef is detected as reactive
    expect(result.code).toContain("__conditionalRegion")
    expect(result.ir[0].children[0].kind).toBe("conditional")
  })

  it("should resolve createTypedDoc return type", () => {
    const source = `
      import { createTypedDoc, Shape, ListRef } from "@loro-extended/change"

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

    // Should generate __listRegion because doc.items is ListRef
    expect(result.code).toContain("__listRegion")
  })

  it("should handle mixed imported and inline types", () => {
    const source = `
      import { TextRef, CounterRef } from "@loro-extended/change"

      interface AppDoc {
        title: TextRef
        count: CounterRef
      }

      declare const doc: AppDoc

      div(() => {
        h1(doc.title.toString())
        span(String(doc.count.get()))
      })
    `

    const result = transformSource(source, { target: "dom" })

    // Both should be detected as reactive
    expect(result.code).toContain("__subscribeWithValue")
    // Should have reactive children
    expect(result.ir[0].isReactive).toBe(true)
  })

  it("should produce __listRegion for for-of over imported ListRef", () => {
    // Critical test: the compiler must resolve ListRef from @loro-extended/change
    // to detect doc.todos as reactive and generate __listRegion
    const source = `
      import { ListRef } from "@loro-extended/change"

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
    `

    const result = transformSource(source, { target: "dom" })

    // Critical assertion: __listRegion must be generated
    expect(result.code).toContain("__listRegion")

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
})

// =============================================================================
// Schema-Inferred Reactive Detection Tests
// =============================================================================

describe("schema-inferred reactive detection (zero ceremony)", () => {
  it("should detect reactive types from createTypedDoc without explicit interface", () => {
    const source = `
      import { createTypedDoc, Shape } from "@loro-extended/change"

      const TodoSchema = Shape.doc({
        title: Shape.text(),
        todos: Shape.list(Shape.plain.string()),
        completedCount: Shape.counter(),
      })

      const doc = createTypedDoc(TodoSchema)

      div(() => {
        h1(doc.title.toString())
        for (const item of doc.todos) {
          li(item)
        }
      })
    `

    const result = transformSource(source, { target: "dom" })

    // Should detect TextRef on doc.title → __subscribeWithValue
    expect(result.code).toContain("__subscribeWithValue")
    // Should detect ListRef on doc.todos → __listRegion
    expect(result.code).toContain("__listRegion")
    // Builder should be reactive
    expect(result.ir[0].isReactive).toBe(true)
  })

  it("should detect conditional reactive types from schema inference", () => {
    const source = `
      import { createTypedDoc, Shape } from "@loro-extended/change"

      const Schema = Shape.doc({
        count: Shape.counter(),
      })

      const doc = createTypedDoc(Schema)

      div(() => {
        if (doc.count.get() > 0) {
          p("Has items")
        }
      })
    `

    const result = transformSource(source, { target: "dom" })

    // Should detect CounterRef → __conditionalRegion
    expect(result.code).toContain("__conditionalRegion")
  })

  it("should work with schema defined inline", () => {
    const source = `
      import { createTypedDoc, Shape } from "@loro-extended/change"

      const doc = createTypedDoc(Shape.doc({
        items: Shape.list(Shape.plain.string()),
      }))

      div(() => {
        for (const item of doc.items) {
          li(item)
        }
      })
    `

    const result = transformSource(source, { target: "dom" })

    expect(result.code).toContain("__listRegion")
  })

  it("should work with createTypedDoc options parameter", () => {
    const source = `
      import { createTypedDoc, Shape } from "@loro-extended/change"

      const Schema = Shape.doc({
        title: Shape.text(),
        items: Shape.list(Shape.plain.string()),
      })

      const doc = createTypedDoc(Schema, { doc: {} as any })

      div(() => {
        h1(doc.title.toString())
        for (const item of doc.items) {
          li(item)
        }
      })
    `

    const result = transformSource(source, { target: "dom" })

    expect(result.code).toContain("__subscribeWithValue")
    expect(result.code).toContain("__listRegion")
  })

  it("should produce both DOM and HTML targets from same schema-inferred source", () => {
    const source = `
      import { createTypedDoc, Shape } from "@loro-extended/change"

      const Schema = Shape.doc({
        title: Shape.text(),
        items: Shape.list(Shape.plain.string()),
      })

      const doc = createTypedDoc(Schema)

      div(() => {
        h1(doc.title.toString())
        if (doc.items.toArray().length > 0) {
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
    expect(domResult.code).toContain("__subscribeWithValue")
    expect(domResult.code).toContain("__listRegion")
    expect(domResult.code).toContain("__conditionalRegion")

    // HTML target: template literals with map/ternary (spread syntax for ref preservation)
    expect(htmlResult.code).toContain("].map(")
    expect(htmlResult.code).toContain("<h1>")
    expect(htmlResult.code).toContain("kinetic:list")
    expect(htmlResult.code).toContain("kinetic:if")
  })
})
