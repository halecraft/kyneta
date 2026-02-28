/**
 * Unit tests for HTML code generation.
 *
 * These tests verify that the HTML code generator produces correct
 * JavaScript code that generates HTML strings from IR nodes.
 */

import { describe, expect, it } from "vitest"
import {
  type ConditionalBranch,
  createBuilder,
  createConditionalRegion,
  createElement,
  createListRegion,
  createSpan,
  createStatement,
  createStaticConditional,
  createStaticExpression,
  createStaticLoop,
  createTextNode,
} from "../ir.js"
import { generateHTML } from "./html.js"

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create a simple span for testing.
 */
function span(
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
) {
  return createSpan(startLine, startCol, endLine, endCol)
}

// =============================================================================
// generateHTML Tests - Basic Elements
// =============================================================================

describe("generateHTML", () => {
  describe("basic elements", () => {
    it("should generate HTML for empty element", () => {
      const builder = createBuilder("div", [], [], [], span(1, 0, 1, 10))

      const code = generateHTML(builder)

      expect(code).toContain("<div>")
      expect(code).toContain("</div>")
    })

    it("should generate HTML for element with text child", () => {
      const textNode = createTextNode("Hello", span(1, 4, 1, 11))
      const builder = createBuilder("p", [], [], [textNode], span(1, 0, 1, 13))

      const code = generateHTML(builder)

      expect(code).toContain("<p>")
      expect(code).toContain("Hello")
      expect(code).toContain("</p>")
    })
  })
})

// =============================================================================
// generateHTML Tests - Statements
// =============================================================================

describe("generateHTML - statements", () => {
  it("should emit statement in list region body", () => {
    const stmt = createStatement(
      "const item = itemRef.get()",
      span(3, 6, 3, 32),
    )
    const liElement = createElement(
      "li",
      [],
      [],
      [],
      [createTextNode("item", span(4, 6, 4, 12))],
      span(4, 4, 4, 14),
    )
    const listRegion = createListRegion(
      "items",
      "itemRef",
      null,
      [stmt, liElement],
      span(2, 2, 5, 3),
    )
    const builder = createBuilder("ul", [], [], [listRegion], span(1, 0, 6, 1))

    const code = generateHTML(builder)

    // Should contain the statement source in the generated code
    expect(code).toContain("const item = itemRef.get()")
    // Should also generate the list HTML
    expect(code).toContain("<li>")
  })

  it("should emit statement in conditional region body", () => {
    const stmt = createStatement("const msg = 'hello'", span(3, 6, 3, 25))
    const pElement = createElement(
      "p",
      [],
      [],
      [],
      [createTextNode("msg", span(4, 6, 4, 11))],
      span(4, 4, 4, 13),
    )
    const branch: ConditionalBranch = {
      condition: createStaticExpression("showMessage", span(2, 6, 2, 17)),
      body: [stmt, pElement],
      span: span(2, 4, 5, 3),
    }
    const conditionalRegion = createConditionalRegion(
      [branch],
      "showMessage",
      span(2, 2, 5, 3),
    )
    const builder = createBuilder(
      "div",
      [],
      [],
      [conditionalRegion],
      span(1, 0, 6, 1),
    )

    const code = generateHTML(builder)

    // Should contain the statement in the generated code
    expect(code).toContain("const msg = 'hello'")
  })

  it("should preserve interleaving of statements and elements in list region", () => {
    const stmt1 = createStatement('console.log("before")', span(3, 6, 3, 27))
    const liElement = createElement(
      "li",
      [],
      [],
      [],
      [createTextNode("item", span(4, 6, 4, 12))],
      span(4, 4, 4, 14),
    )
    const stmt2 = createStatement('console.log("after")', span(5, 6, 5, 26))
    const listRegion = createListRegion(
      "items",
      "item",
      null,
      [stmt1, liElement, stmt2],
      span(2, 2, 6, 3),
    )
    const builder = createBuilder("ul", [], [], [listRegion], span(1, 0, 7, 1))

    const code = generateHTML(builder)

    // Verify order: stmt1 before li, stmt2 after
    const beforeIndex = code.indexOf('console.log("before")')
    const liIndex = code.indexOf("<li>")
    const afterIndex = code.indexOf('console.log("after")')

    expect(beforeIndex).toBeGreaterThan(-1)
    expect(liIndex).toBeGreaterThan(-1)
    expect(afterIndex).toBeGreaterThan(-1)
    expect(beforeIndex).toBeLessThan(liIndex)
    expect(liIndex).toBeLessThan(afterIndex)
  })
})

// =============================================================================
// generateHTML Tests - Static Loops
// =============================================================================

describe("generateHTML - static loops", () => {
  it("should generate .map() expression for static loop", () => {
    const liElement = createElement(
      "li",
      [],
      [],
      [],
      [createTextNode("x", span(3, 6, 3, 9))],
      span(3, 4, 3, 11),
    )
    const staticLoop = createStaticLoop(
      "[1, 2, 3]",
      "x",
      null,
      [liElement],
      span(2, 2, 4, 3),
    )
    const builder = createBuilder("ul", [], [], [staticLoop], span(1, 0, 5, 1))

    const code = generateHTML(builder)

    // Should generate a map expression
    expect(code).toContain("[1, 2, 3].map")
    expect(code).toContain(".join")
  })

  it("should generate static loop with index variable", () => {
    const liElement = createElement(
      "li",
      [],
      [],
      [],
      [createTextNode("item", span(3, 6, 3, 12))],
      span(3, 4, 3, 14),
    )
    const staticLoop = createStaticLoop(
      "items.entries()",
      "item",
      "i",
      [liElement],
      span(2, 2, 4, 3),
    )
    const builder = createBuilder("ul", [], [], [staticLoop], span(1, 0, 5, 1))

    const code = generateHTML(builder)

    // Should include destructuring pattern
    expect(code).toContain("[i, item]")
  })

  it("should handle statements inside static loop", () => {
    const stmt = createStatement("const doubled = x * 2", span(3, 6, 3, 27))
    const liElement = createElement(
      "li",
      [],
      [],
      [],
      [createTextNode("doubled", span(4, 6, 4, 15))],
      span(4, 4, 4, 17),
    )
    const staticLoop = createStaticLoop(
      "[1, 2, 3]",
      "x",
      null,
      [stmt, liElement],
      span(2, 2, 5, 3),
    )
    const builder = createBuilder("ul", [], [], [staticLoop], span(1, 0, 6, 1))

    const code = generateHTML(builder)

    expect(code).toContain("[1, 2, 3].map")
    expect(code).toContain("const doubled = x * 2")
    expect(code).toContain("<li>")
  })
})

// =============================================================================
// generateHTML Tests - Static Conditionals
// =============================================================================

describe("generateHTML - static conditionals", () => {
  it("should generate IIFE for static conditional", () => {
    const pElement = createElement(
      "p",
      [],
      [],
      [],
      [createTextNode("Shown", span(3, 6, 3, 13))],
      span(3, 4, 3, 15),
    )
    const staticCond = createStaticConditional(
      "true",
      [pElement],
      null,
      span(2, 2, 4, 3),
    )
    const builder = createBuilder("div", [], [], [staticCond], span(1, 0, 5, 1))

    const code = generateHTML(builder)

    // Should generate a conditional expression
    expect(code).toContain("true")
    expect(code).toContain("<p>")
  })

  it("should generate static conditional with else branch", () => {
    const pYes = createElement(
      "p",
      [],
      [],
      [],
      [createTextNode("Yes", span(3, 6, 3, 11))],
      span(3, 4, 3, 13),
    )
    const pNo = createElement(
      "p",
      [],
      [],
      [],
      [createTextNode("No", span(5, 6, 5, 10))],
      span(5, 4, 5, 12),
    )
    const staticCond = createStaticConditional(
      "condition",
      [pYes],
      [pNo],
      span(2, 2, 6, 3),
    )
    const builder = createBuilder("div", [], [], [staticCond], span(1, 0, 7, 1))

    const code = generateHTML(builder)

    // Should have if/else structure
    expect(code).toContain("condition")
    expect(code).toContain("else")
  })

  it("should handle statements inside static conditional", () => {
    const stmt = createStatement("const msg = 'hello'", span(3, 6, 3, 25))
    const pElement = createElement(
      "p",
      [],
      [],
      [],
      [createTextNode("msg", span(4, 6, 4, 11))],
      span(4, 4, 4, 13),
    )
    const staticCond = createStaticConditional(
      "showMessage",
      [stmt, pElement],
      null,
      span(2, 2, 5, 3),
    )
    const builder = createBuilder("div", [], [], [staticCond], span(1, 0, 6, 1))

    const code = generateHTML(builder)

    expect(code).toContain("showMessage")
    expect(code).toContain("const msg = 'hello'")
    expect(code).toContain("<p>")
  })
})

// =============================================================================
// generateHTML Tests - Code Validity
// =============================================================================

describe("generateHTML - code validity", () => {
  it("should generate balanced template literal", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [createTextNode("Hello", span(1, 4, 1, 11))],
      span(1, 0, 1, 13),
    )

    const code = generateHTML(builder)

    // Should have balanced backticks
    const backticks = (code.match(/`/g) || []).length
    expect(backticks % 2).toBe(0)
  })

  it("should generate valid JavaScript for complex nested structure", () => {
    const stmt = createStatement("const x = 1", span(3, 6, 3, 17))
    const liElement = createElement(
      "li",
      [],
      [],
      [],
      [createTextNode("item", span(4, 6, 4, 12))],
      span(4, 4, 4, 14),
    )
    const listRegion = createListRegion(
      "items",
      "item",
      null,
      [stmt, liElement],
      span(2, 2, 5, 3),
    )
    const builder = createBuilder("ul", [], [], [listRegion], span(1, 0, 6, 1))

    const code = generateHTML(builder)

    // Check for balanced braces (basic syntax check)
    const openBraces = (code.match(/{/g) || []).length
    const closeBraces = (code.match(/}/g) || []).length
    expect(openBraces).toBe(closeBraces)

    // Check for balanced parentheses
    const openParens = (code.match(/\(/g) || []).length
    const closeParens = (code.match(/\)/g) || []).length
    expect(openParens).toBe(closeParens)
  })
})
