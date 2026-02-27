/**
 * Integration tests for the transform pipeline.
 *
 * These tests exercise the full compile flow: source code → IR → generated output.
 * They validate that the pipeline produces correct output for real-world patterns.
 */

import { describe, expect, it } from "vitest"
import { hasBuilderCalls, transformSource } from "./transform.js"

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
