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
  computeHasReactiveItems,
  createBuilder,
  createConditionalRegion,
  createContent,
  createElement,
  createLiteral,
  createLoop,
  createSpan,
  createStatement,
  createStaticConditional,
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
        [createLiteral("Hello", span())],
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
        [createContent("count.get()", "reactive", ["count"], span())],
        span(),
      )

      expect(builder.isReactive).toBe(true)
      expect(builder.allDependencies.length).toBeGreaterThan(0)
    })
  })

  describe("collects dependencies from nested structures", () => {
    it("collects from deeply nested elements", () => {
      // div > section > p > reactive expression
      const reactiveExpr = createContent(
        "doc.title.toString()",
        "reactive",
        ["doc.title"],
        span(),
      )
      const p = createElement("p", [], [], [], [reactiveExpr], span())
      const section = createElement("section", [], [], [], [p], span())
      const builder = createBuilder("div", [], [], [section], span())

      expect(builder.allDependencies).toContain("doc.title")
      expect(builder.isReactive).toBe(true)
    })

    it("collects from reactive loop iterableSource", () => {
      const li = createElement(
        "li",
        [],
        [],
        [],
        [createContent("item.text", "render", [], span())],
        span(),
      )
      const loop = createLoop(
        "doc.items",
        "reactive",
        "item",
        null,
        [li],
        ["doc.items"],
        span(),
      )
      const builder = createBuilder("ul", [], [], [loop], span())

      expect(builder.allDependencies).toContain("doc.items")
    })

    it("collects from reactive loop body (nested reactive content)", () => {
      // List where each item has reactive content
      const reactiveExpr = createContent(
        "item.count.get()",
        "reactive",
        ["item.count"],
        span(),
      )
      const li = createElement("li", [], [], [], [reactiveExpr], span())
      const loop = createLoop(
        "doc.items",
        "reactive",
        "item",
        null,
        [li],
        ["doc.items"],
        span(),
      )
      const builder = createBuilder("ul", [], [], [loop], span())

      expect(builder.allDependencies).toContain("doc.items")
      expect(builder.allDependencies).toContain("item.count")
    })

    it("collects from conditional region subscriptionTarget", () => {
      const p = createElement(
        "p",
        [],
        [],
        [],
        [createLiteral("Visible", span())],
        span(),
      )
      const branch: ConditionalBranch = {
        condition: createContent(
          "doc.visible.get()",
          "reactive",
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
          createContent(
            "doc.message.toString()",
            "reactive",
            ["doc.message"],
            span(),
          ),
        ],
        span(),
      )
      const branch: ConditionalBranch = {
        condition: createContent(
          "doc.show.get()",
          "reactive",
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
        value: createContent(
          'doc.active.get() ? "active" : "inactive"',
          "reactive",
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
        value: createContent(
          "item.className",
          "reactive",
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
      const expr1 = createContent("count.get()", "reactive", ["count"], span())
      const expr2 = createContent(
        "count.get() * 2",
        "reactive",
        ["count"],
        span(),
      )
      const builder = createBuilder("div", [], [], [expr1, expr2], span())

      const countOccurrences = builder.allDependencies.filter(
        d => d === "count",
      ).length
      expect(countOccurrences).toBe(1)
    })
  })

  describe("does NOT collect from static content", () => {
    it("render-time expressions do not add dependencies", () => {
      const renderExpr = createContent("42", "render", [], span())
      const builder = createBuilder("p", [], [], [renderExpr], span())

      expect(builder.allDependencies).toHaveLength(0)
      expect(builder.isReactive).toBe(false)
    })

    it("literal content does not add dependencies", () => {
      const builder = createBuilder(
        "div",
        [{ name: "title", value: createLiteral("Hello", span()) }],
        [],
        [],
        span(),
      )

      expect(builder.allDependencies).toHaveLength(0)
      expect(builder.isReactive).toBe(false)
    })

    it("render-time props do not add dependencies", () => {
      const classAttr: AttributeNode = {
        name: "class",
        value: createContent('"container"', "render", [], span()),
      }
      const builder = createBuilder("div", [classAttr], [], [], span())

      expect(builder.isReactive).toBe(false)
      expect(builder.allDependencies).toHaveLength(0)
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
        value: createContent(
          "activeClass",
          "reactive",
          ["activeClass"],
          span(),
        ),
      }

      const h1 = createElement(
        "h1",
        [],
        [],
        [],
        [
          createContent(
            "doc.title.toString()",
            "reactive",
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
        [createContent("item.text", "reactive", ["item.text"], span())],
        span(),
      )
      const loop = createLoop(
        "items",
        "reactive",
        "item",
        null,
        [li],
        ["items"],
        span(),
      )
      const ul = createElement("ul", [], [], [], [loop], span())

      const emptyP = createElement(
        "p",
        [],
        [],
        [],
        [createLiteral("No items", span())],
        span(),
      )

      const thenBranch: ConditionalBranch = {
        condition: createContent(
          "items.length > 0",
          "reactive",
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

// =============================================================================
// computeHasReactiveItems Tests
// =============================================================================

describe("computeHasReactiveItems", () => {
  it("returns false for empty body", () => {
    expect(computeHasReactiveItems([])).toBe(false)
  })

  it("returns false for purely static body", () => {
    const body = [
      createLiteral("Hello", span()),
      createElement("p", [], [], [], [createLiteral("World", span())], span()),
    ]
    expect(computeHasReactiveItems(body)).toBe(false)
  })

  it("returns false for render-time content", () => {
    const body = [createContent("someVar", "render", [], span())]
    expect(computeHasReactiveItems(body)).toBe(false)
  })

  it("returns false for statements only", () => {
    const body = [createStatement("console.log('hi')", span())]
    expect(computeHasReactiveItems(body)).toBe(false)
  })

  it("returns true for reactive content", () => {
    const body = [
      createContent("item.text.get()", "reactive", ["item.text"], span()),
    ]
    expect(computeHasReactiveItems(body)).toBe(true)
  })

  it("returns true for element with reactive attributes", () => {
    const attr: AttributeNode = {
      name: "class",
      value: createContent(
        "item.active.get() ? 'on' : 'off'",
        "reactive",
        ["item.active"],
        span(),
      ),
    }
    const body = [createElement("div", [attr], [], [], [], span())]
    expect(computeHasReactiveItems(body)).toBe(true)
  })

  it("returns true for element with reactive children", () => {
    const reactiveChild = createContent(
      "item.count.get()",
      "reactive",
      ["item.count"],
      span(),
    )
    const body = [createElement("span", [], [], [], [reactiveChild], span())]
    expect(computeHasReactiveItems(body)).toBe(true)
  })

  it("returns true when body contains a reactive loop", () => {
    const li = createElement(
      "li",
      [],
      [],
      [],
      [createLiteral("x", span())],
      span(),
    )
    const loop = createLoop(
      "items",
      "reactive",
      "item",
      null,
      [li],
      ["items"],
      span(),
    )
    expect(computeHasReactiveItems([loop])).toBe(true)
  })

  it("returns true when body contains a conditional region", () => {
    const p = createElement(
      "p",
      [],
      [],
      [],
      [createLiteral("Yes", span())],
      span(),
    )
    const branch: ConditionalBranch = {
      condition: createContent("cond.get()", "reactive", ["cond"], span()),
      body: [p],
      slotKind: "single",
      span: span(),
    }
    const condRegion = createConditionalRegion([branch], "cond", span())
    expect(computeHasReactiveItems([condRegion])).toBe(true)
  })

  it("returns false for render-time loop (shallow — does not recurse)", () => {
    const reactiveChild = createContent("x.get()", "reactive", ["x"], span())
    const li = createElement("li", [], [], [], [reactiveChild], span())
    const renderLoop = createLoop(
      "[1, 2, 3]",
      "render",
      "x",
      null,
      [li],
      [],
      span(),
    )
    // Shallow check: render-time loop is not itself reactive at this level
    expect(computeHasReactiveItems([renderLoop])).toBe(false)
  })

  it("returns false for static conditional (shallow — does not recurse)", () => {
    const reactiveChild = createContent("x.get()", "reactive", ["x"], span())
    const p = createElement("p", [], [], [], [reactiveChild], span())
    const staticCond = createStaticConditional("true", [p], null, span())
    // Shallow check: static-conditional is not itself reactive at this level
    expect(computeHasReactiveItems([staticCond])).toBe(false)
  })

  it("returns true when mixed with non-reactive siblings", () => {
    const body = [
      createLiteral("static", span()),
      createContent("item.name.get()", "reactive", ["item.name"], span()),
      createElement("br", [], [], [], [], span()),
    ]
    expect(computeHasReactiveItems(body)).toBe(true)
  })
})
