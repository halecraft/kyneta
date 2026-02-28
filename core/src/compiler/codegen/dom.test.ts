/**
 * Unit tests for DOM code generation.
 *
 * These tests verify that the DOM code generator produces correct
 * JavaScript code from IR nodes.
 */

import { describe, expect, it } from "vitest"
import {
  type AttributeNode,
  createBuilder,
  createConditional,
  createConditionalBranch,
  createContent,
  createElement,
  createLiteral,
  createLoop,
  createSpan,
  createStatement,
  type EventHandlerNode,
} from "../ir.js"
import { generateDOM, generateElementFactory } from "./dom.js"

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
 * Normalize whitespace for comparison.
 */
function normalizeWhitespace(code: string): string {
  return code
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join("\n")
}

// =============================================================================
// generateDOM Tests - Static Elements
// =============================================================================

describe("generateDOM", () => {
  describe("static elements", () => {
    it("should generate code for empty element", () => {
      const builder = createBuilder("div", [], [], [], span(1, 0, 1, 10))

      const code = generateDOM(builder)

      expect(code).toContain('document.createElement("div")')
      expect(code).toContain("return")
    })

    it("should generate code for element with text child", () => {
      const textNode = createLiteral("Hello, World!", span(1, 4, 1, 20))
      const builder = createBuilder("p", [], [], [textNode], span(1, 0, 1, 22))

      const code = generateDOM(builder)

      expect(code).toContain('document.createElement("p")')
      expect(code).toContain("Hello, World!")
      expect(code).toContain("createTextNode")
      expect(code).toContain("appendChild")
    })

    it("should generate code for element with static expression child", () => {
      const expr = createContent("42", "render", [], span(1, 4, 1, 6))
      const builder = createBuilder("span", [], [], [expr], span(1, 0, 1, 10))

      const code = generateDOM(builder)

      expect(code).toContain('document.createElement("span")')
      expect(code).toContain("String(42)")
      expect(code).toContain("createTextNode")
    })

    it("should generate code for nested elements", () => {
      const innerText = createLiteral("Title", span(2, 6, 2, 13))
      const h1Element = createElement(
        "h1",
        [],
        [],
        [],
        [innerText],
        span(2, 4, 2, 15),
      )

      const builder = createBuilder(
        "div",
        [],
        [],
        [h1Element],
        span(1, 0, 3, 1),
      )

      const code = generateDOM(builder)

      expect(code).toContain('document.createElement("div")')
      expect(code).toContain('document.createElement("h1")')
      expect(code).toContain("Title")
      expect(code).toContain("appendChild")
    })
  })

  describe("attributes", () => {
    it("should generate code for static class attribute", () => {
      const classAttr: AttributeNode = {
        name: "class",
        value: createLiteral("container", span(1, 5, 1, 18)),
      }
      const builder = createBuilder(
        "div",
        [classAttr],
        [],
        [],
        span(1, 0, 1, 20),
      )

      const code = generateDOM(builder)

      expect(code).toContain(".className =")
      expect(code).toContain('"container"')
    })

    it("should generate code for static id attribute", () => {
      const idAttr: AttributeNode = {
        name: "id",
        value: createLiteral("main", span(1, 5, 1, 12)),
      }
      const builder = createBuilder("div", [idAttr], [], [], span(1, 0, 1, 15))

      const code = generateDOM(builder)

      expect(code).toContain("setAttribute")
      expect(code).toContain('"id"')
      expect(code).toContain('"main"')
    })

    it("should generate code for data attributes", () => {
      const dataAttr: AttributeNode = {
        name: "data-testid",
        value: createLiteral("my-test", span(1, 5, 1, 20)),
      }
      const builder = createBuilder(
        "div",
        [dataAttr],
        [],
        [],
        span(1, 0, 1, 25),
      )

      const code = generateDOM(builder)

      expect(code).toContain("dataset")
      expect(code).toContain("testid")
    })

    it("should generate code for value attribute on input", () => {
      const valueAttr: AttributeNode = {
        name: "value",
        value: createLiteral("initial", span(1, 10, 1, 20)),
      }
      const builder = createBuilder(
        "input",
        [valueAttr],
        [],
        [],
        span(1, 0, 1, 25),
      )

      const code = generateDOM(builder)

      expect(code).toContain(".value =")
    })

    it("should generate code for reactive class attribute", () => {
      const classAttr: AttributeNode = {
        name: "class",
        value: createContent(
          'isActive ? "active" : "inactive"',
          "reactive",
          ["isActive"],
          span(1, 5, 1, 40),
        ),
      }
      const builder = createBuilder(
        "div",
        [classAttr],
        [],
        [],
        span(1, 0, 1, 45),
      )

      const code = generateDOM(builder)

      expect(code).toContain(".className =")
      expect(code).toContain("__subscribe")
    })
  })

  describe("event handlers", () => {
    it("should generate code for click handler", () => {
      const handler: EventHandlerNode = {
        event: "click",
        handlerSource: "() => console.log('clicked')",
        span: span(1, 5, 1, 40),
      }
      const builder = createBuilder(
        "button",
        [],
        [handler],
        [],
        span(1, 0, 1, 45),
      )

      const code = generateDOM(builder)

      expect(code).toContain('addEventListener("click"')
      expect(code).toContain("console.log")
    })

    it("should generate code for multiple event handlers", () => {
      const clickHandler: EventHandlerNode = {
        event: "click",
        handlerSource: "handleClick",
        span: span(1, 5, 1, 25),
      }
      const mouseEnterHandler: EventHandlerNode = {
        event: "mouseenter",
        handlerSource: "handleHover",
        span: span(1, 26, 1, 50),
      }
      const builder = createBuilder(
        "div",
        [],
        [clickHandler, mouseEnterHandler],
        [],
        span(1, 0, 1, 55),
      )

      const code = generateDOM(builder)

      expect(code).toContain('addEventListener("click"')
      expect(code).toContain('addEventListener("mouseenter"')
    })
  })

  describe("reactive expressions", () => {
    it("should generate subscription for reactive text content", () => {
      const reactiveExpr = createContent(
        "count.get()",
        "reactive",
        ["count"],
        span(1, 4, 1, 15),
      )
      const builder = createBuilder(
        "span",
        [],
        [],
        [reactiveExpr],
        span(1, 0, 1, 20),
      )

      const code = generateDOM(builder)

      expect(code).toContain("__subscribeWithValue")
      expect(code).toContain("count.get()")
      expect(code).toContain("textContent")
    })

    it("should generate subscription for template literal content", () => {
      const reactiveExpr = createContent(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: testing template literal source code
        "`Count: ${count.get()}`",
        "reactive",
        ["count"],
        span(1, 4, 1, 27),
      )
      const builder = createBuilder(
        "p",
        [],
        [],
        [reactiveExpr],
        span(1, 0, 1, 32),
      )

      const code = generateDOM(builder)

      expect(code).toContain("__subscribeWithValue")
      expect(code).toContain("count")
    })
  })
})

// =============================================================================
// generateDOM Tests - List Regions
// =============================================================================

describe("generateDOM - list regions", () => {
  it("should generate __listRegion call", () => {
    const liElement = createElement(
      "li",
      [],
      [],
      [],
      [createContent("item.text", "render", [], span(3, 6, 3, 15))],
      span(3, 4, 3, 17),
    )
    const loop = createLoop(
      "items",
      "reactive",
      "item",
      null,
      [liElement],
      ["items"],
      span(2, 2, 4, 3),
    )
    const builder = createBuilder("ul", [], [], [loop], span(1, 0, 5, 1))

    const code = generateDOM(builder)

    expect(code).toContain("__listRegion")
    expect(code).toContain("items")
    expect(code).toContain("create:")
    expect(code).toContain("item")
  })

  it("should generate list region with index variable", () => {
    const liElement = createElement(
      "li",
      [],
      [],
      [],
      [createContent("item", "render", [], span(3, 6, 3, 10))],
      span(3, 4, 3, 17),
    )
    const loop = createLoop(
      "items",
      "reactive",
      "item",
      "i",
      [liElement],
      ["items"],
      span(2, 2, 4, 3),
    )
    const builder = createBuilder("ul", [], [], [loop], span(1, 0, 5, 1))

    const code = generateDOM(builder)

    expect(code).toContain("(item, i)")
  })

  // Optimization tests: single element should return directly, not wrapped in fragment
  it("should return element directly when create body has single element", () => {
    const liElement = createElement(
      "li",
      [],
      [],
      [],
      [createContent("item", "render", [], span(3, 6, 3, 10))],
      span(3, 4, 3, 12),
    )
    const loop = createLoop(
      "items",
      "reactive",
      "item",
      null,
      [liElement],
      ["items"],
      span(2, 2, 4, 3),
    )
    const builder = createBuilder("ul", [], [], [loop], span(1, 0, 5, 1))

    const code = generateDOM(builder)

    // Should return the element directly, not a fragment
    expect(code).toContain("return _li")
    expect(code).not.toContain("createDocumentFragment")
  })

  it("should use fragment when create body has multiple elements", () => {
    const li1 = createElement(
      "li",
      [],
      [],
      [],
      [createLiteral("first", span(3, 6, 3, 11))],
      span(3, 4, 3, 13),
    )
    const li2 = createElement(
      "li",
      [],
      [],
      [],
      [createLiteral("second", span(4, 6, 4, 12))],
      span(4, 4, 4, 14),
    )
    const loop = createLoop(
      "items",
      "reactive",
      "item",
      null,
      [li1, li2],
      ["items"],
      span(2, 2, 5, 3),
    )
    const builder = createBuilder("ul", [], [], [loop], span(1, 0, 6, 1))

    const code = generateDOM(builder)

    // Should use fragment for multiple elements
    expect(code).toContain("createDocumentFragment")
    expect(code).toContain("return _frag")
  })
})

// =============================================================================
// generateDOM Tests - Conditional Regions
// =============================================================================

describe("generateDOM - conditional regions", () => {
  it("should generate __conditionalRegion call for reactive condition", () => {
    const pElement = createElement(
      "p",
      [],
      [],
      [],
      [createLiteral("Static content", span(3, 6, 3, 22))],
      span(3, 4, 3, 24),
    )
    const branch = createConditionalBranch(
      createContent(
        "count.get() > 0",
        "reactive",
        ["count"],
        span(2, 6, 2, 22),
      ),
      [pElement],
      span(2, 4, 4, 3),
    )
    const conditionalRegion = createConditional(
      [branch],
      "count",
      span(2, 2, 4, 3),
    )
    const builder = createBuilder(
      "div",
      [],
      [],
      [conditionalRegion],
      span(1, 0, 5, 1),
    )

    const code = generateDOM(builder)

    expect(code).toContain("__conditionalRegion")
    expect(code).toContain("count")
    expect(code).toContain("whenTrue")
    expect(code).toContain("createComment")
  })

  it("should dissolve conditional with identical structure (Level 2)", () => {
    // Conditional with identical structure but different literal content
    // Should be dissolved into direct element creation with ternary
    const trueBranch = createConditionalBranch(
      createContent(
        "count.get() > 0",
        "reactive",
        ["count"],
        span(2, 6, 2, 22),
      ),
      [
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("Yes", span(3, 6, 3, 11))],
          span(3, 4, 3, 13),
        ),
      ],
      span(2, 4, 4, 3),
    )
    const falseBranch = createConditionalBranch(
      null,
      [
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("No", span(5, 6, 5, 10))],
          span(5, 4, 5, 12),
        ),
      ],
      span(4, 4, 6, 3),
    )
    const conditionalRegion = createConditional(
      [trueBranch, falseBranch],
      "count",
      span(2, 2, 6, 3),
    )
    const builder = createBuilder(
      "div",
      [],
      [],
      [conditionalRegion],
      span(1, 0, 7, 1),
    )

    const code = generateDOM(builder)

    // Should NOT contain __conditionalRegion (dissolved)
    expect(code).not.toContain("__conditionalRegion")
    expect(code).not.toContain("whenTrue")
    expect(code).not.toContain("whenFalse")
    expect(code).not.toContain("createComment")

    // Should contain direct element creation
    expect(code).toContain('createElement("p")')

    // Should contain ternary expression
    expect(code).toContain("?")
    expect(code).toContain('"Yes"')
    expect(code).toContain('"No"')
  })

  it("should fallback to __conditionalRegion when structure differs", () => {
    // Conditional with different element types - cannot dissolve
    const trueBranch = createConditionalBranch(
      createContent(
        "count.get() > 0",
        "reactive",
        ["count"],
        span(2, 6, 2, 22),
      ),
      [
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("Paragraph", span(3, 6, 3, 11))],
          span(3, 4, 3, 13),
        ),
      ],
      span(2, 4, 4, 3),
    )
    const falseBranch = createConditionalBranch(
      null,
      [
        createElement(
          "div",
          [],
          [],
          [],
          [createLiteral("Div", span(5, 6, 5, 10))],
          span(5, 4, 5, 12),
        ),
      ],
      span(4, 4, 6, 3),
    )
    const conditionalRegion = createConditional(
      [trueBranch, falseBranch],
      "count",
      span(2, 2, 6, 3),
    )
    const builder = createBuilder(
      "div",
      [],
      [],
      [conditionalRegion],
      span(1, 0, 7, 1),
    )

    const code = generateDOM(builder)

    // Should contain __conditionalRegion (not dissolved)
    expect(code).toContain("__conditionalRegion")
    expect(code).toContain("whenTrue")
    expect(code).toContain("whenFalse")
    expect(code).toContain("createComment")
  })

  it("should generate inline if for render-time condition", () => {
    const pElement = createElement(
      "p",
      [],
      [],
      [],
      [createLiteral("Static content", span(3, 6, 3, 22))],
      span(3, 4, 3, 24),
    )
    const branch = createConditionalBranch(
      createContent("true", "render", [], span(2, 6, 2, 10)),
      [pElement],
      span(2, 4, 4, 3),
    )
    const conditionalNode = createConditional(
      [branch],
      null, // No subscription target - render-time condition
      span(2, 2, 4, 3),
    )
    const builder = createBuilder(
      "div",
      [],
      [],
      [conditionalNode],
      span(1, 0, 5, 1),
    )

    const code = generateDOM(builder)

    // Render-time conditionals emit inline if, not __staticConditionalRegion
    expect(code).toContain("if (true)")
    expect(code).not.toContain("__staticConditionalRegion")
    expect(code).not.toContain("__conditionalRegion")
  })
})

// =============================================================================
// generateElementFactory Tests
// =============================================================================

describe("generateElementFactory", () => {
  it("should wrap generated code in a function", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [createLiteral("Hello", span(1, 4, 1, 11))],
      span(1, 0, 1, 13),
    )

    const code = generateElementFactory(builder)

    expect(code).toContain("(scope) => {")
    expect(code).toContain("return")
    expect(code).toContain("}")
  })

  it("should use custom scope variable name", () => {
    const builder = createBuilder("div", [], [], [], span(1, 0, 1, 10))

    const code = generateElementFactory(builder, { scopeVar: "myScope" })

    expect(code).toContain("(myScope) => {")
  })
})

// =============================================================================
// Snapshot-style Tests
// =============================================================================

describe("generateDOM - code validity", () => {
  it("should generate syntactically balanced braces and parentheses", () => {
    // Complex structure that exercises all code paths
    const loop = createLoop(
      "items",
      "reactive",
      "item",
      null,
      [
        createElement(
          "li",
          [],
          [],
          [],
          [createContent("item.text", "reactive", ["item"], span(3, 0, 3, 10))],
          span(2, 0, 4, 1),
        ),
      ],
      ["items"],
      span(1, 0, 5, 1),
    )

    const conditionalBranch = createConditionalBranch(
      createContent(
        "count.get() > 0",
        "reactive",
        ["count"],
        span(1, 0, 1, 15),
      ),
      [
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("Yes", span(1, 0, 1, 5))],
          span(1, 0, 1, 10),
        ),
      ],
      span(1, 0, 2, 1),
    )
    const conditionalRegion = createConditional(
      [conditionalBranch],
      "count",
      span(1, 0, 3, 1),
    )

    const builder = createBuilder(
      "div",
      [
        {
          name: "class",
          value: createContent("cls", "reactive", ["cls"], span(1, 0, 1, 5)),
        },
      ],
      [{ event: "click", handlerSource: "() => {}", span: span(1, 0, 1, 10) }],
      [loop, conditionalRegion],
      span(1, 0, 10, 1),
    )

    const code = generateDOM(builder)

    // Verify balanced delimiters (syntax validity proxy)
    const openBraces = (code.match(/{/g) || []).length
    const closeBraces = (code.match(/}/g) || []).length
    expect(openBraces).toBe(closeBraces)

    const openParens = (code.match(/\(/g) || []).length
    const closeParens = (code.match(/\)/g) || []).length
    expect(openParens).toBe(closeParens)

    const openBrackets = (code.match(/\[/g) || []).length
    const closeBrackets = (code.match(/\]/g) || []).length
    expect(openBrackets).toBe(closeBrackets)

    // Verify no obvious syntax errors
    expect(code).not.toContain("undefined")
    expect(code).not.toContain("[object Object]")
  })

  it("should generate expected output for simple element", () => {
    const builder = createBuilder(
      "div",
      [
        {
          name: "class",
          value: createLiteral("container", span(1, 5, 1, 18)),
        },
      ],
      [],
      [
        createElement(
          "h1",
          [],
          [],
          [],
          [createLiteral("Title", span(2, 6, 2, 13))],
          span(2, 4, 2, 15),
        ),
      ],
      span(1, 0, 3, 1),
    )

    const code = generateDOM(builder)
    const normalized = normalizeWhitespace(code)

    // Verify key structural elements are present
    expect(normalized).toContain('document.createElement("div")')
    expect(normalized).toContain(".className =")
    expect(normalized).toContain('"container"')
    expect(normalized).toContain('document.createElement("h1")')
    expect(normalized).toContain('"Title"')
    expect(normalized).toContain("appendChild")
    expect(normalized).toContain("return")
  })

  it("should generate valid JavaScript syntax", () => {
    const builder = createBuilder(
      "div",
      [],
      [],
      [
        createElement(
          "p",
          [],
          [],
          [],
          [
            createContent(
              "count.get()",
              "reactive",
              ["count"],
              span(3, 6, 3, 18),
            ),
          ],
          span(2, 4, 2, 19),
        ),
      ],
      span(1, 0, 3, 1),
    )

    const code = generateDOM(builder)

    // Should not throw when evaluated as JavaScript (basic syntax check)
    // We can't actually evaluate it without the runtime, but we can check
    // for balanced braces and proper structure
    const openBraces = (code.match(/{/g) || []).length
    const closeBraces = (code.match(/}/g) || []).length
    expect(openBraces).toBe(closeBraces)

    const openParens = (code.match(/\(/g) || []).length
    const closeParens = (code.match(/\)/g) || []).length
    expect(openParens).toBe(closeParens)
  })
})

// =============================================================================
// generateDOM Tests - Statements
// =============================================================================

describe("generateDOM - statements", () => {
  it("should emit statement source verbatim", () => {
    const stmt = createStatement("const x = 1", span(2, 4, 2, 15))
    const builder = createBuilder("div", [], [], [stmt], span(1, 0, 3, 1))

    const code = generateDOM(builder)

    expect(code).toContain("const x = 1")
  })

  it("should emit statements in list region create callback", () => {
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
      ["items"],
      span(2, 2, 5, 3),
    )
    const builder = createBuilder("ul", [], [], [loop], span(1, 0, 6, 1))

    const code = generateDOM(builder)

    expect(code).toContain("__listRegion")
    expect(code).toContain("const item = itemRef.get()")
  })

  it("should preserve interleaving of statements and elements", () => {
    const stmt1 = createStatement('console.log("before")', span(2, 4, 2, 25))
    const pElement = createElement(
      "p",
      [],
      [],
      [],
      [createLiteral("Hello", span(3, 6, 3, 13))],
      span(3, 4, 3, 15),
    )
    const stmt2 = createStatement('console.log("after")', span(4, 4, 4, 24))
    const builder = createBuilder(
      "div",
      [],
      [],
      [stmt1, pElement, stmt2],
      span(1, 0, 5, 1),
    )

    const code = generateDOM(builder)

    // Verify order: stmt1 before p element, stmt2 after
    const beforeIndex = code.indexOf('console.log("before")')
    const pIndex = code.indexOf('document.createElement("p")')
    const afterIndex = code.indexOf('console.log("after")')

    expect(beforeIndex).toBeGreaterThan(-1)
    expect(pIndex).toBeGreaterThan(-1)
    expect(afterIndex).toBeGreaterThan(-1)
    expect(beforeIndex).toBeLessThan(pIndex)
    expect(pIndex).toBeLessThan(afterIndex)
  })

  it("should generate static loop as for...of with body", () => {
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

    const code = generateDOM(builder)

    expect(code).toContain("for (const x of [1, 2, 3])")
    expect(code).toContain('createElement("li")')
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

    const code = generateDOM(builder)

    expect(code).toContain("for (const [i, item] of items.entries())")
  })

  it("should generate static conditional as if statement", () => {
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

    const code = generateDOM(builder)

    expect(code).toContain("if (true)")
    expect(code).toContain('createElement("p")')
    expect(code).not.toContain("else")
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

    const code = generateDOM(builder)

    expect(code).toContain("if (condition)")
    expect(code).toContain("} else {")
  })

  it("should handle statements inside static loop body", () => {
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

    const code = generateDOM(builder)

    expect(code).toContain("for (const x of [1, 2, 3])")
    expect(code).toContain("const doubled = x * 2")
    expect(code).toContain('createElement("li")')
  })

  it("should handle statements inside static conditional branches", () => {
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

    const code = generateDOM(builder)

    expect(code).toContain("if (showMessage)")
    expect(code).toContain("const msg = 'hello'")
    expect(code).toContain('createElement("p")')
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

    const code = generateDOM(builder)

    // Should produce nested if/else structure
    expect(code).toContain("if (condA)")
    expect(code).toContain("} else {")
    expect(code).toContain("if (condB)")
    expect(code).toContain('createElement("p")')
  })
})
