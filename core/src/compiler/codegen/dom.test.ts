/**
 * Unit tests for DOM code generation.
 *
 * These tests verify that the DOM code generator produces correct
 * JavaScript code from IR nodes.
 */

import { describe, expect, it } from "vitest"
import {
  type AttributeNode,
  type ConditionalBranch,
  createBuilder,
  createConditionalRegion,
  createElement,
  createListRegion,
  createReactiveExpression,
  createSpan,
  createStaticExpression,
  createTextNode,
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
      const textNode = createTextNode("Hello, World!", span(1, 4, 1, 20))
      const builder = createBuilder("p", [], [], [textNode], span(1, 0, 1, 22))

      const code = generateDOM(builder)

      expect(code).toContain('document.createElement("p")')
      expect(code).toContain("Hello, World!")
      expect(code).toContain("createTextNode")
      expect(code).toContain("appendChild")
    })

    it("should generate code for element with static expression child", () => {
      const expr = createStaticExpression("42", span(1, 4, 1, 6))
      const builder = createBuilder("span", [], [], [expr], span(1, 0, 1, 10))

      const code = generateDOM(builder)

      expect(code).toContain('document.createElement("span")')
      expect(code).toContain("String(42)")
      expect(code).toContain("createTextNode")
    })

    it("should generate code for nested elements", () => {
      const innerText = createTextNode("Title", span(2, 6, 2, 13))
      const h1Element = createElement(
        "h1",
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
        value: createTextNode("container", span(1, 5, 1, 18)),
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
        value: createTextNode("main", span(1, 5, 1, 12)),
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
        value: createTextNode("my-test", span(1, 5, 1, 20)),
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
        value: createTextNode("initial", span(1, 10, 1, 20)),
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
        value: createReactiveExpression(
          'isActive ? "active" : "inactive"',
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
      const reactiveExpr = createReactiveExpression(
        "count.get()",
        ["count"],
        span(1, 4, 1, 16),
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
      const reactiveExpr = createReactiveExpression(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: This is source code, not a template literal
        "`Count: ${count.get()}`",
        ["count"],
        span(1, 4, 1, 28),
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
      [createStaticExpression("item", span(3, 8, 3, 12))],
      span(3, 4, 3, 15),
    )
    const listRegion = createListRegion(
      "items",
      "item",
      null,
      [liElement],
      span(2, 2, 4, 3),
    )
    const builder = createBuilder("ul", [], [], [listRegion], span(1, 0, 5, 1))

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
      [createStaticExpression("item", span(3, 8, 3, 12))],
      span(3, 4, 3, 15),
    )
    const listRegion = createListRegion(
      "items",
      "item",
      "i",
      [liElement],
      span(2, 2, 4, 3),
    )
    const builder = createBuilder("ul", [], [], [listRegion], span(1, 0, 5, 1))

    const code = generateDOM(builder)

    expect(code).toContain("(item, i)")
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
      [createTextNode("Has items", span(3, 6, 3, 17))],
      span(3, 4, 3, 19),
    )
    const branch: ConditionalBranch = {
      condition: createReactiveExpression(
        "count.get() > 0",
        ["count"],
        span(2, 6, 2, 22),
      ),
      body: [pElement],
      span: span(2, 4, 4, 3),
    }
    const conditionalRegion = createConditionalRegion(
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

  it("should generate __conditionalRegion with else branch", () => {
    const trueBranch: ConditionalBranch = {
      condition: createReactiveExpression(
        "count.get() > 0",
        ["count"],
        span(2, 6, 2, 22),
      ),
      body: [
        createElement(
          "p",
          [],
          [],
          [createTextNode("Has items", span(3, 6, 3, 17))],
          span(3, 4, 3, 19),
        ),
      ],
      span: span(2, 4, 4, 3),
    }
    const falseBranch: ConditionalBranch = {
      condition: null,
      body: [
        createElement(
          "p",
          [],
          [],
          [createTextNode("No items", span(5, 6, 5, 16))],
          span(5, 4, 5, 18),
        ),
      ],
      span: span(4, 4, 6, 3),
    }
    const conditionalRegion = createConditionalRegion(
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

    expect(code).toContain("whenTrue")
    expect(code).toContain("whenFalse")
  })

  it("should generate __staticConditionalRegion for static condition", () => {
    const pElement = createElement(
      "p",
      [],
      [],
      [createTextNode("Visible", span(3, 6, 3, 15))],
      span(3, 4, 3, 17),
    )
    const branch: ConditionalBranch = {
      condition: createStaticExpression("true", span(2, 6, 2, 10)),
      body: [pElement],
      span: span(2, 4, 4, 3),
    }
    const conditionalRegion = createConditionalRegion(
      [branch],
      null, // No subscription target - static condition
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

    expect(code).toContain("__staticConditionalRegion")
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
      [createTextNode("Hello", span(1, 4, 1, 11))],
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
    const listRegion = createListRegion(
      "items",
      "item",
      null,
      [
        createElement(
          "li",
          [],
          [],
          [createReactiveExpression("item.text", ["item"], span(3, 0, 3, 10))],
          span(2, 0, 4, 1),
        ),
      ],
      span(1, 0, 5, 1),
    )

    const conditionalBranch = {
      condition: createReactiveExpression(
        "count.get() > 0",
        ["count"],
        span(1, 0, 1, 15),
      ),
      body: [
        createElement(
          "p",
          [],
          [],
          [createTextNode("Yes", span(1, 0, 1, 5))],
          span(1, 0, 1, 10),
        ),
      ],
      span: span(1, 0, 2, 1),
    }
    const conditionalRegion = createConditionalRegion(
      [conditionalBranch],
      "count",
      span(1, 0, 3, 1),
    )

    const builder = createBuilder(
      "div",
      [
        {
          name: "class",
          value: createReactiveExpression("cls", ["cls"], span(1, 0, 1, 5)),
        },
      ],
      [{ event: "click", handlerSource: "() => {}", span: span(1, 0, 1, 10) }],
      [listRegion, conditionalRegion],
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
          value: createTextNode("container", span(1, 5, 1, 18)),
        },
      ],
      [],
      [
        createElement(
          "h1",
          [],
          [],
          [createTextNode("Title", span(2, 6, 2, 13))],
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
          [
            createReactiveExpression(
              "count.get()",
              ["count"],
              span(2, 5, 2, 17),
            ),
          ],
          span(2, 2, 2, 20),
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
