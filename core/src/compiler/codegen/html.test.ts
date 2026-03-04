/**
 * Unit tests for HTML code generation.
 *
 * These tests verify that the HTML code generator produces correct
 * JavaScript code that generates HTML strings from IR nodes.
 *
 * After the unification to a single accumulation-line calling convention,
 * all codegen output uses `_html +=` lines. Loops use `for...of` instead
 * of `.map().join("")`, and conditionals use `if/else` instead of ternaries
 * with IIFEs.
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
import { generateHTML, generateRenderFunction } from "./html.js"

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

/**
 * Join generateHTML's string[] output into a single string for assertions.
 */
function htmlLines(
  ...args: Parameters<typeof generateHTML>
): string {
  return generateHTML(...args).join("; ")
}

// =============================================================================
// generateHTML Tests - Basic Elements
// =============================================================================

describe("generateHTML", () => {
  describe("basic elements", () => {
    it("should generate HTML for empty element", () => {
      const builder = createBuilder("div", [], [], [], span(1, 0, 1, 10))

      const code = htmlLines(builder)

      expect(code).toContain("<div>")
      expect(code).toContain("</div>")
    })

    it("should generate HTML for element with text child", () => {
      const textNode = createLiteral("Hello", span(1, 4, 1, 11))
      const builder = createBuilder("p", [], [], [textNode], span(1, 0, 1, 13))

      const code = htmlLines(builder)

      expect(code).toContain("<p>")
      expect(code).toContain("Hello")
      expect(code).toContain("</p>")
    })
  })
})

// =============================================================================
// generateHTML Tests - Top-Level Statements (Bug Fix)
// =============================================================================

describe("generateHTML - top-level statements", () => {
  it("should preserve variable declaration before element child", () => {
    const stmt = createStatement("const x = 1", span(2, 4, 2, 15))
    const h1Element = createElement(
      "h1",
      [],
      [],
      [],
      [createLiteral("x", span(3, 6, 3, 9))],
      span(3, 4, 3, 11),
    )
    const builder = createBuilder(
      "div",
      [],
      [],
      [stmt, h1Element],
      span(1, 0, 4, 1),
    )

    const code = htmlLines(builder)

    // Statement must be preserved in output
    expect(code).toContain("const x = 1")
    // Element must still render
    expect(code).toContain("<h1>")
    expect(code).toContain("</h1>")
    // Statement must come before the element
    const stmtIndex = code.indexOf("const x = 1")
    const h1Index = code.indexOf("<h1>")
    expect(stmtIndex).toBeGreaterThan(-1)
    expect(h1Index).toBeGreaterThan(-1)
    expect(stmtIndex).toBeLessThan(h1Index)
  })

  it("should preserve interleaved statements and elements at builder level", () => {
    const stmt1 = createStatement("const x = 1", span(2, 4, 2, 15))
    const h1 = createElement(
      "h1",
      [],
      [],
      [],
      [createLiteral("Title", span(3, 6, 3, 13))],
      span(3, 4, 3, 15),
    )
    const stmt2 = createStatement("const y = 2", span(4, 4, 4, 15))
    const p = createElement(
      "p",
      [],
      [],
      [],
      [createLiteral("Body", span(5, 6, 5, 12))],
      span(5, 4, 5, 14),
    )
    const builder = createBuilder(
      "div",
      [],
      [],
      [stmt1, h1, stmt2, p],
      span(1, 0, 6, 1),
    )

    const code = htmlLines(builder)

    // All pieces present
    expect(code).toContain("const x = 1")
    expect(code).toContain("<h1>")
    expect(code).toContain("const y = 2")
    expect(code).toContain("<p>")

    // Correct ordering
    const idx1 = code.indexOf("const x = 1")
    const idxH1 = code.indexOf("<h1>")
    const idx2 = code.indexOf("const y = 2")
    const idxP = code.indexOf("<p>")
    expect(idx1).toBeLessThan(idxH1)
    expect(idxH1).toBeLessThan(idx2)
    expect(idx2).toBeLessThan(idxP)
  })

  it("should handle statement-only builder body", () => {
    const stmt = createStatement("console.log('hi')", span(2, 4, 2, 21))
    const builder = createBuilder("div", [], [], [stmt], span(1, 0, 3, 1))

    const code = htmlLines(builder)

    // Statement preserved
    expect(code).toContain("console.log('hi')")
    // Tags still produced
    expect(code).toContain("<div>")
    expect(code).toContain("</div>")
  })

  it("should preserve statement after element child", () => {
    const h1 = createElement(
      "h1",
      [],
      [],
      [],
      [createLiteral("Title", span(2, 6, 2, 13))],
      span(2, 4, 2, 15),
    )
    const stmt = createStatement("console.log('done')", span(3, 4, 3, 23))
    const builder = createBuilder(
      "div",
      [],
      [],
      [h1, stmt],
      span(1, 0, 4, 1),
    )

    const code = htmlLines(builder)

    expect(code).toContain("<h1>")
    expect(code).toContain("console.log('done')")
    // Statement must come after the element
    const h1Index = code.indexOf("</h1>")
    const stmtIndex = code.indexOf("console.log('done')")
    expect(h1Index).toBeLessThan(stmtIndex)
  })
})

// =============================================================================
// generateHTML Tests - Nested Element Statements (Bug Fix)
// =============================================================================

describe("generateHTML - nested element statements", () => {
  it("should preserve statements in nested element children", () => {
    const stmt = createStatement("const x = 1", span(3, 6, 3, 17))
    const h1 = createElement(
      "h1",
      [],
      [],
      [],
      [createLiteral("x", span(4, 6, 4, 9))],
      span(4, 4, 4, 11),
    )
    const header = createElement(
      "header",
      [],
      [],
      [],
      [stmt, h1],
      span(2, 2, 5, 3),
    )
    const builder = createBuilder("div", [], [], [header], span(1, 0, 6, 1))

    const code = htmlLines(builder)

    // Statement preserved inside nested element
    expect(code).toContain("const x = 1")
    // Nested structure correct
    expect(code).toContain("<header>")
    expect(code).toContain("<h1>")
    expect(code).toContain("</h1>")
    expect(code).toContain("</header>")
    // Statement comes after opening <header> and before <h1>
    const headerIdx = code.indexOf("<header>")
    const stmtIdx = code.indexOf("const x = 1")
    const h1Idx = code.indexOf("<h1>")
    expect(headerIdx).toBeLessThan(stmtIdx)
    expect(stmtIdx).toBeLessThan(h1Idx)
  })

  it("should preserve interleaved statements in deeply nested elements", () => {
    const stmt = createStatement("const msg = 'hi'", span(4, 8, 4, 25))
    const span1 = createElement(
      "span",
      [],
      [],
      [],
      [createLiteral("msg", span(5, 8, 5, 13))],
      span(5, 6, 5, 15),
    )
    const p = createElement("p", [], [], [], [stmt, span1], span(3, 4, 6, 5))
    const section = createElement(
      "section",
      [],
      [],
      [],
      [p],
      span(2, 2, 7, 3),
    )
    const builder = createBuilder("div", [], [], [section], span(1, 0, 8, 1))

    const code = htmlLines(builder)

    expect(code).toContain("const msg = 'hi'")
    expect(code).toContain("<section>")
    expect(code).toContain("<p>")
    expect(code).toContain("<span>")
  })
})

// =============================================================================
// generateHTML Tests - Statements in List/Conditional (existing)
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

    const code = htmlLines(builder)

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

    const code = htmlLines(builder)

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

    const code = htmlLines(builder)

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
  it("should generate for...of loop for static loop", () => {
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

    const code = htmlLines(builder)

    // Should generate a for...of loop (not .map().join())
    expect(code).toContain("for (const x of [1, 2, 3])")
    // Should contain the list item HTML
    expect(code).toContain("<li>")
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

    const code = htmlLines(builder)

    // Should include destructuring pattern
    expect(code).toContain("[i, item]")
    // Should be a for...of loop
    expect(code).toContain("for (const [i, item] of items.entries())")
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

    const code = htmlLines(builder)

    // Should use for...of loop
    expect(code).toContain("for (const x of [1, 2, 3])")
    expect(code).toContain("const doubled = x * 2")
    expect(code).toContain("<li>")
  })
})

// =============================================================================
// generateHTML Tests - Static Conditionals
// =============================================================================

describe("generateHTML - static conditionals", () => {
  it("should generate if block for static conditional", () => {
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

    const code = htmlLines(builder)

    // Should generate an if block (not ternary/IIFE)
    expect(code).toContain("if (true)")
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

    const code = htmlLines(builder)

    // Should have if/else structure with both branches
    expect(code).toContain("if (condition)")
    expect(code).toContain("} else {")
    // Both branches produce HTML (now as separate _html += lines)
    expect(code).toContain("<p>")
    expect(code).toContain("Yes")
    expect(code).toContain("No")
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

    const code = htmlLines(builder)

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

    const code = htmlLines(builder)

    // Should produce flat if/else-if/else structure
    expect(code).toContain("if (condA)")
    expect(code).toContain("} else if (condB)")
    expect(code).toContain("} else {")
    // All branches produce HTML
    expect(code).toContain("<p>")
    expect(code).toContain("First")
    expect(code).toContain("Second")
    expect(code).toContain("Third")
  })
})

// =============================================================================
// generateHTML Tests - Accumulation Pattern
// =============================================================================

describe("generateHTML - accumulation pattern", () => {
  it("should start with let _html and end with return _html", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [createLiteral("Hello", span(1, 4, 1, 11))],
      span(1, 0, 1, 13),
    )

    const code = htmlLines(builder)

    expect(code).toContain('let _html = ""')
    expect(code).toContain("return _html")
  })

  it("should use _html += for all HTML fragments", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [createLiteral("Hello", span(1, 4, 1, 11))],
      span(1, 0, 1, 13),
    )

    const code = htmlLines(builder)

    // Opening tag, content, closing tag — all via _html +=
    expect(code).toContain("_html += `<div>`")
    expect(code).toContain("_html += `</div>`")
  })
})

// =============================================================================
// generateHTML Tests - Code Validity
// =============================================================================

describe("generateHTML - code validity", () => {
  it("should generate balanced braces and parentheses", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [createLiteral("Hello", span(1, 4, 1, 11))],
      span(1, 0, 1, 13),
    )

    const code = htmlLines(builder)

    // Should have balanced braces
    const openBraces = (code.match(/{/g) || []).length
    const closeBraces = (code.match(/}/g) || []).length
    expect(openBraces).toBe(closeBraces)

    // Should have balanced parentheses
    const openParens = (code.match(/\(/g) || []).length
    const closeParens = (code.match(/\)/g) || []).length
    expect(openParens).toBe(closeParens)
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

    const code = htmlLines(builder)

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

// =============================================================================
// generateRenderFunction Tests
// =============================================================================

describe("generateRenderFunction", () => {
  it("should wrap generateHTML in an arrow function with block body", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [createLiteral("Hello", span(1, 4, 1, 11))],
      span(1, 0, 1, 13),
    )

    const code = generateRenderFunction(builder)

    expect(code).toContain("() => {")
    expect(code).toContain('let _html = ""')
    expect(code).toContain("return _html")
    expect(code).toContain("}")
  })

  it("should preserve top-level statements in render function", () => {
    const stmt = createStatement("const x = 1", span(2, 4, 2, 15))
    const h1 = createElement(
      "h1",
      [],
      [],
      [],
      [createLiteral("x", span(3, 6, 3, 9))],
      span(3, 4, 3, 11),
    )
    const builder = createBuilder(
      "div",
      [],
      [],
      [stmt, h1],
      span(1, 0, 4, 1),
    )

    const code = generateRenderFunction(builder)

    // Statement preserved in the render function
    expect(code).toContain("const x = 1")
    expect(code).toContain("<h1>")
  })
})

// =============================================================================
// generateHTML Tests - Reactive Loops with Hydration Markers
// =============================================================================

describe("generateHTML - reactive loops", () => {
  it("should include hydration markers for reactive loops", () => {
    const liElement = createElement(
      "li",
      [],
      [],
      [],
      [createLiteral("item", span(3, 6, 3, 12))],
      span(3, 4, 3, 14),
    )
    const loop = createLoop(
      "items",
      "reactive",
      "item",
      null,
      [liElement],
      [dep("items")],
      span(2, 2, 4, 3),
    )
    const builder = createBuilder("ul", [], [], [loop], span(1, 0, 5, 1))

    const code = htmlLines(builder)

    // Should contain hydration markers
    expect(code).toContain("kinetic:list:")
    expect(code).toContain("/kinetic:list")
    // Should use for...of with spread for reactive loops
    expect(code).toContain("for (const item of [...items])")
  })

  it("should not include hydration markers when hydratable is false", () => {
    const liElement = createElement(
      "li",
      [],
      [],
      [],
      [createLiteral("item", span(3, 6, 3, 12))],
      span(3, 4, 3, 14),
    )
    const loop = createLoop(
      "items",
      "reactive",
      "item",
      null,
      [liElement],
      [dep("items")],
      span(2, 2, 4, 3),
    )
    const builder = createBuilder("ul", [], [], [loop], span(1, 0, 5, 1))

    const code = htmlLines(builder, { hydratable: false })

    // Should NOT contain hydration markers
    expect(code).not.toContain("kinetic:list")
  })
})

// =============================================================================
// generateHTML Tests - Reactive Conditionals with Hydration Markers
// =============================================================================

describe("generateHTML - reactive conditionals", () => {
  it("should include hydration markers for reactive conditionals", () => {
    const pElement = createElement(
      "p",
      [],
      [],
      [],
      [createLiteral("Shown", span(3, 6, 3, 13))],
      span(3, 4, 3, 15),
    )
    const branch = createConditionalBranch(
      createContent(
        "visible",
        "reactive",
        [dep("visible")],
        span(2, 4, 2, 11),
      ),
      [pElement],
      span(2, 2, 4, 3),
    )
    const cond = createConditional(
      [branch],
      dep("visible"),
      span(2, 2, 4, 3),
    )
    const builder = createBuilder("div", [], [], [cond], span(1, 0, 5, 1))

    const code = htmlLines(builder)

    // Should contain hydration markers
    expect(code).toContain("kinetic:if:")
    expect(code).toContain("/kinetic:if")
    // Should use if/else structure
    expect(code).toContain("if (visible)")
  })

  it("should not include hydration markers for render-time conditionals", () => {
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

    const code = htmlLines(builder)

    // Should NOT contain hydration markers
    expect(code).not.toContain("kinetic:if")
  })
})