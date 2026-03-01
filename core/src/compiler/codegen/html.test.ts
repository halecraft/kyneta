/**
 * Unit tests for HTML code generation.
 *
 * These tests verify that the HTML code generator produces correct
 * JavaScript code that generates HTML strings from IR nodes.
 */

import { describe, expect, it } from "vitest"
import {
  createBuilder,
  createConditional,
  createConditionalBranch,
  createContent,
  createElement,
  createLiteral,
  createLoop,
  createSpan,
  createStatement,
  type Dependency,
  type DeltaKind,
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

/**
 * Create a dependency with a given source and optional delta kind.
 * Defaults to "replace" for simplicity in tests.
 */
function dep(source: string, deltaKind: DeltaKind = "replace"): Dependency {
  return { source, deltaKind }
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
      const textNode = createLiteral("Hello", span(1, 4, 1, 11))
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
      [createLiteral("item", span(4, 6, 4, 12))],
      span(4, 4, 4, 14),
    )
    const loop = createLoop(
      "items",
      "reactive",
      "itemRef",
      null,
      [stmt, liElement],
      [dep("items")],
      span(2, 2, 5, 3),
    )
    const builder = createBuilder("ul", [], [], [loop], span(1, 0, 6, 1))

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
      [createLiteral("msg", span(4, 6, 4, 11))],
      span(4, 4, 4, 13),
    )
    const branch = createConditionalBranch(
      createContent(
        "showMessage",
        "reactive",
        [dep("showMessage")],
        span(2, 6, 2, 17),
      ),
      [stmt, pElement],
      span(2, 4, 5, 3),
    )
    const conditionalRegion = createConditional(
      [branch],
      dep("showMessage"),
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
      [createLiteral("item", span(4, 6, 4, 12))],
      span(4, 4, 4, 14),
    )
    const stmt2 = createStatement('console.log("after")', span(5, 6, 5, 26))
    const loop = createLoop(
      "items",
      "reactive",
      "item",
      null,
      [stmt1, liElement, stmt2],
      [dep("items")],
      span(2, 2, 6, 3),
    )
    const builder = createBuilder("ul", [], [], [loop], span(1, 0, 7, 1))

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
      [createLiteral("x", span(3, 6, 3, 9))],
      span(3, 4, 3, 11),
    )
    const renderLoop = createLoop(
      "[1, 2, 3]",
      "render",
      "x",
      null,
      [liElement],
      [],
      span(2, 2, 4, 3),
    )
    const builder = createBuilder("ul", [], [], [renderLoop], span(1, 0, 5, 1))

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
      [createLiteral("item", span(3, 6, 3, 12))],
      span(3, 4, 3, 14),
    )
    const renderLoop = createLoop(
      "items.entries()",
      "render",
      "item",
      "i",
      [liElement],
      [],
      span(2, 2, 4, 3),
    )
    const builder = createBuilder("ul", [], [], [renderLoop], span(1, 0, 5, 1))

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
      [createLiteral("doubled", span(4, 6, 4, 15))],
      span(4, 4, 4, 17),
    )
    const renderLoop = createLoop(
      "[1, 2, 3]",
      "render",
      "x",
      null,
      [stmt, liElement],
      [],
      span(2, 2, 5, 3),
    )
    const builder = createBuilder("ul", [], [], [renderLoop], span(1, 0, 6, 1))

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
      [createLiteral("Shown", span(3, 6, 3, 13))],
      span(3, 4, 3, 15),
    )
    const branch = createConditionalBranch(
      createContent("true", "render", [], span(2, 4, 2, 8)),
      [pElement],
      span(2, 2, 4, 3),
    )
    const staticCond = createConditional([branch], null, span(2, 2, 4, 3))
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
      [createLiteral("Yes", span(3, 6, 3, 11))],
      span(3, 4, 3, 13),
    )
    const pNo = createElement(
      "p",
      [],
      [],
      [],
      [createLiteral("No", span(5, 6, 5, 10))],
      span(5, 4, 5, 12),
    )
    const thenBranch = createConditionalBranch(
      createContent("condition", "render", [], span(2, 4, 2, 13)),
      [pYes],
      span(2, 2, 4, 3),
    )
    const elseBranch = createConditionalBranch(null, [pNo], span(4, 2, 6, 3))
    const staticCond = createConditional(
      [thenBranch, elseBranch],
      null,
      span(2, 2, 6, 3),
    )
    const builder = createBuilder("div", [], [], [staticCond], span(1, 0, 7, 1))

    const code = generateHTML(builder)

    // Should have ternary structure with both branches
    expect(code).toContain("condition")
    expect(code).toContain("<p>Yes</p>")
    expect(code).toContain("<p>No</p>")
  })

  it("should handle statements inside static conditional", () => {
    const stmt = createStatement("const msg = 'hello'", span(3, 6, 3, 25))
    const pElement = createElement(
      "p",
      [],
      [],
      [],
      [createLiteral("msg", span(4, 6, 4, 11))],
      span(4, 4, 4, 13),
    )
    const branch = createConditionalBranch(
      createContent("showMessage", "render", [], span(2, 4, 2, 15)),
      [stmt, pElement],
      span(2, 2, 5, 3),
    )
    const staticCond = createConditional([branch], null, span(2, 2, 5, 3))
    const builder = createBuilder("div", [], [], [staticCond], span(1, 0, 6, 1))

    const code = generateHTML(builder)

    expect(code).toContain("showMessage")
    expect(code).toContain("const msg = 'hello'")
    expect(code).toContain("<p>")
  })

  it("should generate nested if/else-if/else for static else-if chain", () => {
    const pFirst = createElement(
      "p",
      [],
      [],
      [],
      [createLiteral("First", span(3, 6, 3, 13))],
      span(3, 4, 3, 15),
    )
    const pSecond = createElement(
      "p",
      [],
      [],
      [],
      [createLiteral("Second", span(5, 6, 5, 14))],
      span(5, 4, 5, 16),
    )
    const pThird = createElement(
      "p",
      [],
      [],
      [],
      [createLiteral("Third", span(7, 6, 7, 13))],
      span(7, 4, 7, 15),
    )

    // Post-unification: static else-if uses flat branches array
    const branchA = createConditionalBranch(
      createContent("condA", "render", [], span(2, 4, 2, 9)),
      [pFirst],
      span(2, 2, 4, 3),
    )
    const branchB = createConditionalBranch(
      createContent("condB", "render", [], span(4, 4, 4, 9)),
      [pSecond],
      span(4, 2, 6, 3),
    )
    const elseBranch = createConditionalBranch(null, [pThird], span(6, 2, 8, 3))
    const staticCond = createConditional(
      [branchA, branchB, elseBranch],
      null,
      span(2, 2, 8, 3),
    )
    const builder = createBuilder("div", [], [], [staticCond], span(1, 0, 9, 1))

    const code = generateHTML(builder)

    // Should produce flat conditional structure with else-if
    expect(code).toContain("condA")
    expect(code).toContain("condB")
    expect(code).toContain("<p>First</p>")
    expect(code).toContain("<p>Second</p>")
    expect(code).toContain("<p>Third</p>")
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
      [createLiteral("Hello", span(1, 4, 1, 11))],
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
      [createLiteral("item", span(4, 6, 4, 12))],
      span(4, 4, 4, 14),
    )
    const loop = createLoop(
      "items",
      "reactive",
      "item",
      null,
      [stmt, liElement],
      [dep("items")],
      span(2, 2, 5, 3),
    )
    const builder = createBuilder("ul", [], [], [loop], span(1, 0, 6, 1))

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
