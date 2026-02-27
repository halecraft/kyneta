/**
 * Unit tests for IR types and dependency collection.
 *
 * These tests focus on the high-risk `createBuilder` function which
 * recursively collects dependencies from the entire IR tree. Bugs here
 * silently cause stale UI (missing subscriptions).
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
} from "./ir.js"

// =============================================================================
// Test Helpers
// =============================================================================

function span() {
  return createSpan(1, 0, 1, 10)
}

// =============================================================================
// Dependency Collection Tests
// =============================================================================

describe("createBuilder - dependency collection", () => {
  describe("invariant: isReactive === (allDependencies.length > 0)", () => {
    it("static builder has isReactive=false and empty dependencies", () => {
      const builder = createBuilder(
        "div",
        [],
        [],
        [createTextNode("Hello", span())],
        span(),
      )

      expect(builder.isReactive).toBe(false)
      expect(builder.allDependencies).toHaveLength(0)
    })

    it("reactive builder has isReactive=true and non-empty dependencies", () => {
      const builder = createBuilder(
        "div",
        [],
        [],
        [createReactiveExpression("count.get()", ["count"], span())],
        span(),
      )

      expect(builder.isReactive).toBe(true)
      expect(builder.allDependencies.length).toBeGreaterThan(0)
    })
  })

  describe("collects dependencies from nested structures", () => {
    it("collects from deeply nested elements", () => {
      // div > section > p > reactive expression
      const reactiveExpr = createReactiveExpression(
        "doc.title.toString()",
        ["doc.title"],
        span(),
      )
      const p = createElement("p", [], [], [], [reactiveExpr], span())
      const section = createElement("section", [], [], [], [p], span())
      const builder = createBuilder("div", [], [], [section], span())

      expect(builder.allDependencies).toContain("doc.title")
      expect(builder.isReactive).toBe(true)
    })

    it("collects from list region listSource", () => {
      const li = createElement(
        "li",
        [],
        [],
        [],
        [createStaticExpression("item.text", span())],
        span(),
      )
      const listRegion = createListRegion(
        "doc.items",
        "item",
        null,
        [li],
        span(),
      )
      const builder = createBuilder("ul", [], [], [listRegion], span())

      expect(builder.allDependencies).toContain("doc.items")
    })

    it("collects from list region body (nested reactive content)", () => {
      // List where each item has reactive content
      const reactiveExpr = createReactiveExpression(
        "item.count.get()",
        ["item.count"],
        span(),
      )
      const li = createElement("li", [], [], [], [reactiveExpr], span())
      const listRegion = createListRegion(
        "doc.items",
        "item",
        null,
        [li],
        span(),
      )
      const builder = createBuilder("ul", [], [], [listRegion], span())

      expect(builder.allDependencies).toContain("doc.items")
      expect(builder.allDependencies).toContain("item.count")
    })

    it("collects from conditional region subscriptionTarget", () => {
      const p = createElement(
        "p",
        [],
        [],
        [],
        [createTextNode("Visible", span())],
        span(),
      )
      const branch: ConditionalBranch = {
        condition: createReactiveExpression(
          "doc.visible.get()",
          ["doc.visible"],
          span(),
        ),
        body: [p],
        span: span(),
      }
      const conditional = createConditionalRegion(
        [branch],
        "doc.visible",
        span(),
      )
      const builder = createBuilder("div", [], [], [conditional], span())

      expect(builder.allDependencies).toContain("doc.visible")
    })

    it("collects from conditional region branch body", () => {
      const reactiveP = createElement(
        "p",
        [],
        [],
        [],
        [
          createReactiveExpression(
            "doc.message.toString()",
            ["doc.message"],
            span(),
          ),
        ],
        span(),
      )
      const branch: ConditionalBranch = {
        condition: createReactiveExpression(
          "doc.show.get()",
          ["doc.show"],
          span(),
        ),
        body: [reactiveP],
        span: span(),
      }
      const conditional = createConditionalRegion([branch], "doc.show", span())
      const builder = createBuilder("div", [], [], [conditional], span())

      expect(builder.allDependencies).toContain("doc.show")
      expect(builder.allDependencies).toContain("doc.message")
    })

    it("collects from reactive props", () => {
      const classAttr: AttributeNode = {
        name: "class",
        value: createReactiveExpression(
          'doc.active.get() ? "active" : "inactive"',
          ["doc.active"],
          span(),
        ),
      }
      const builder = createBuilder("div", [classAttr], [], [], span())

      expect(builder.allDependencies).toContain("doc.active")
    })

    it("collects from element attributes (not just props)", () => {
      const classAttr: AttributeNode = {
        name: "class",
        value: createReactiveExpression(
          "item.className",
          ["item.className"],
          span(),
        ),
      }
      const innerDiv = createElement("div", [classAttr], [], [], [], span())
      const builder = createBuilder("section", [], [], [innerDiv], span())

      expect(builder.allDependencies).toContain("item.className")
    })
  })

  describe("deduplicates dependencies", () => {
    it("same dependency used multiple times appears once", () => {
      const expr1 = createReactiveExpression("count.get()", ["count"], span())
      const expr2 = createReactiveExpression(
        "count.get() * 2",
        ["count"],
        span(),
      )
      const builder = createBuilder(
        "div",
        [],
        [],
        [
          createElement("p", [], [], [], [expr1], span()),
          createElement("p", [], [], [], [expr2], span()),
        ],
        span(),
      )

      const countOccurrences = builder.allDependencies.filter(
        d => d === "count",
      ).length
      expect(countOccurrences).toBe(1)
    })
  })

  describe("does NOT collect from static content", () => {
    it("static expressions do not add dependencies", () => {
      const staticExpr = createStaticExpression("42", span())
      const builder = createBuilder("p", [], [], [staticExpr], span())

      expect(builder.allDependencies).toHaveLength(0)
      expect(builder.isReactive).toBe(false)
    })

    it("text nodes do not add dependencies", () => {
      const builder = createBuilder(
        "p",
        [],
        [],
        [createTextNode("Hello, World!", span())],
        span(),
      )

      expect(builder.allDependencies).toHaveLength(0)
      expect(builder.isReactive).toBe(false)
    })

    it("static props do not add dependencies", () => {
      const staticAttr: AttributeNode = {
        name: "class",
        value: createTextNode("container", span()),
      }
      const builder = createBuilder("div", [staticAttr], [], [], span())

      expect(builder.allDependencies).toHaveLength(0)
      expect(builder.isReactive).toBe(false)
    })
  })

  describe("complex real-world scenario", () => {
    it("todo list with multiple reactive sources", () => {
      // Simulates:
      // div({ class: activeClass }, () => {
      //   h1(title.toString())
      //   if (items.length > 0) {
      //     ul(() => {
      //       for (const item of items) {
      //         li(item.text)
      //       }
      //     })
      //   } else {
      //     p("No items")
      //   }
      // })

      const classAttr: AttributeNode = {
        name: "class",
        value: createReactiveExpression("activeClass", ["activeClass"], span()),
      }

      const h1 = createElement(
        "h1",
        [],
        [],
        [],
        [
          createReactiveExpression(
            "doc.title.toString()",
            ["doc.title"],
            span(),
          ),
        ],
        span(),
      )

      const li = createElement(
        "li",
        [],
        [],
        [],
        [createReactiveExpression("item.text", ["item.text"], span())],
        span(),
      )
      const listRegion = createListRegion("items", "item", null, [li], span())
      const ul = createElement("ul", [], [], [], [listRegion], span())

      const emptyP = createElement(
        "p",
        [],
        [],
        [],
        [createTextNode("No items", span())],
        span(),
      )

      const thenBranch: ConditionalBranch = {
        condition: createReactiveExpression(
          "items.length > 0",
          ["items"],
          span(),
        ),
        body: [ul],
        span: span(),
      }
      const elseBranch: ConditionalBranch = {
        condition: null,
        body: [emptyP],
        span: span(),
      }
      const conditional = createConditionalRegion(
        [thenBranch, elseBranch],
        "items",
        span(),
      )

      const builder = createBuilder(
        "div",
        [classAttr],
        [],
        [h1, conditional],
        span(),
      )

      // Should collect all unique dependencies
      expect(builder.allDependencies).toContain("activeClass")
      expect(builder.allDependencies).toContain("doc.title")
      expect(builder.allDependencies).toContain("items")
      expect(builder.allDependencies).toContain("item.text")
      expect(builder.isReactive).toBe(true)

      // Should not have duplicates
      const itemsCount = builder.allDependencies.filter(
        d => d === "items",
      ).length
      expect(itemsCount).toBe(1)
    })
  })
})
