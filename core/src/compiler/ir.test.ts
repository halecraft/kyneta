/**
 * Unit tests for IR types, dependency collection, and target block filtering.
 *
 * These tests focus on:
 * - The high-risk `createBuilder` function which recursively collects
 *   dependencies from the entire IR tree. Bugs here silently cause
 *   stale UI (missing subscriptions).
 * - The `filterTargetBlocks` function which strips/unwraps client:/server:
 *   blocks before codegen. Bugs here cause wrong code in wrong target.
 */

import { describe, expect, it } from "vitest"
import {
  type AttributeNode,
  computeHasReactiveItems,
  createBuilder,
  createConditional,
  createConditionalBranch,
  createContent,
  createElement,
  createLiteral,
  createLoop,
  createSpan,
  createStatement,
  createTargetBlock,
  type Dependency,
  type DeltaKind,
  filterTargetBlocks,
} from "./ir.js"

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create a dependency with a given source and optional delta kind.
 * Defaults to "replace" for simplicity in tests.
 */
function dep(source: string, deltaKind: DeltaKind = "replace"): Dependency {
  return { source, deltaKind }
}

/**
 * Check if allDependencies contains a dependency with the given source.
 */
function hasDep(deps: Dependency[], source: string): boolean {
  return deps.some(d => d.source === source)
}

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
        [createContent("count.get()", "reactive", [dep("count")], span())],
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
        [dep("doc.title", "text")],
        span(),
      )
      const p = createElement("p", [], [], [], [reactiveExpr], span())
      const section = createElement("section", [], [], [], [p], span())
      const builder = createBuilder("div", [], [], [section], span())

      expect(hasDep(builder.allDependencies, "doc.title")).toBe(true)
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
        [dep("doc.items", "list")],
        span(),
      )
      const builder = createBuilder("ul", [], [], [loop], span())

      expect(hasDep(builder.allDependencies, "doc.items")).toBe(true)
    })

    it("collects from reactive loop body (nested reactive content)", () => {
      // List where each item has reactive content
      const reactiveExpr = createContent(
        "item.count.get()",
        "reactive",
        [dep("item.count")],
        span(),
      )
      const li = createElement("li", [], [], [], [reactiveExpr], span())
      const loop = createLoop(
        "doc.items",
        "reactive",
        "item",
        null,
        [li],
        [dep("doc.items", "list")],
        span(),
      )
      const builder = createBuilder("ul", [], [], [loop], span())

      expect(hasDep(builder.allDependencies, "doc.items")).toBe(true)
      expect(hasDep(builder.allDependencies, "item.count")).toBe(true)
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
      const branch = createConditionalBranch(
        createContent(
          "doc.visible.get()",
          "reactive",
          [dep("doc.visible")],
          span(),
        ),
        [p],
        span(),
      )
      const conditional = createConditional(
        [branch],
        dep("doc.visible"),
        span(),
      )
      const builder = createBuilder("div", [], [], [conditional], span())

      expect(hasDep(builder.allDependencies, "doc.visible")).toBe(true)
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
            [dep("doc.message", "text")],
            span(),
          ),
        ],
        span(),
      )
      const branch = createConditionalBranch(
        createContent("doc.show.get()", "reactive", [dep("doc.show")], span()),
        [reactiveP],
        span(),
      )
      const conditional = createConditional([branch], dep("doc.show"), span())
      const builder = createBuilder("div", [], [], [conditional], span())

      expect(hasDep(builder.allDependencies, "doc.show")).toBe(true)
      expect(hasDep(builder.allDependencies, "doc.message")).toBe(true)
    })

    it("collects from reactive props", () => {
      const classAttr: AttributeNode = {
        name: "class",
        value: createContent(
          'doc.active.get() ? "active" : "inactive"',
          "reactive",
          [dep("doc.active")],
          span(),
        ),
      }
      const builder = createBuilder("div", [classAttr], [], [], span())

      expect(hasDep(builder.allDependencies, "doc.active")).toBe(true)
    })

    it("collects from element attributes (not just props)", () => {
      const classAttr: AttributeNode = {
        name: "class",
        value: createContent(
          "item.className",
          "reactive",
          [dep("item.className")],
          span(),
        ),
      }
      const innerDiv = createElement("div", [classAttr], [], [], [], span())
      const builder = createBuilder("section", [], [], [innerDiv], span())

      expect(hasDep(builder.allDependencies, "item.className")).toBe(true)
    })
  })

  describe("deduplicates dependencies", () => {
    it("same dependency used multiple times appears once", () => {
      const expr1 = createContent(
        "count.get()",
        "reactive",
        [dep("count")],
        span(),
      )
      const expr2 = createContent(
        "count.get() * 2",
        "reactive",
        [dep("count")],
        span(),
      )
      const builder = createBuilder("div", [], [], [expr1, expr2], span())

      const countOccurrences = builder.allDependencies.filter(
        d => d.source === "count",
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
          [dep("activeClass")],
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
            [dep("doc.title", "text")],
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
        [createContent("item.text", "reactive", [dep("item.text")], span())],
        span(),
      )
      const loop = createLoop(
        "doc.items",
        "reactive",
        "item",
        null,
        [li],
        [dep("doc.items", "list")],
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

      // Conditional branches
      const ifBranch = createConditionalBranch(
        createContent(
          "doc.items.length > 0",
          "reactive",
          [dep("doc.items", "list")],
          span(),
        ),
        [ul],
        span(),
      )
      const elseBranch = createConditionalBranch(null, [emptyP], span())
      const conditional = createConditional(
        [ifBranch, elseBranch],
        dep("doc.items", "list"),
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
      expect(hasDep(builder.allDependencies, "activeClass")).toBe(true)
      expect(hasDep(builder.allDependencies, "doc.title")).toBe(true)
      expect(hasDep(builder.allDependencies, "doc.items")).toBe(true)
      expect(hasDep(builder.allDependencies, "item.text")).toBe(true)
      expect(builder.isReactive).toBe(true)

      // Should not have duplicates
      const itemsCount = builder.allDependencies.filter(
        d => d.source === "doc.items",
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
      createContent("count.get()", "reactive", [dep("count")], span()),
    ]
    expect(computeHasReactiveItems(body)).toBe(true)
  })

  it("returns true for element with reactive attributes", () => {
    const attr: AttributeNode = {
      name: "class",
      value: createContent(
        "item.active.get() ? 'on' : 'off'",
        "reactive",
        [dep("item.active")],
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
      [dep("item.count")],
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
      [dep("items", "list")],
      span(),
    )
    expect(computeHasReactiveItems([loop])).toBe(true)
  })

  it("returns true when body contains a reactive conditional", () => {
    const p = createElement(
      "p",
      [],
      [],
      [],
      [createLiteral("Yes", span())],
      span(),
    )
    const branch = createConditionalBranch(
      createContent("cond.get()", "reactive", [dep("cond")], span()),
      [p],
      span(),
    )
    const condRegion = createConditional([branch], dep("cond"), span())
    expect(computeHasReactiveItems([condRegion])).toBe(true)
  })

  it("returns false for render-time loop (shallow — does not recurse)", () => {
    const reactiveChild = createContent(
      "x.get()",
      "reactive",
      [dep("x")],
      span(),
    )
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

  it("returns false for render-time conditional (shallow — does not recurse)", () => {
    const reactiveChild = createContent(
      "x.get()",
      "reactive",
      [dep("x")],
      span(),
    )
    const p = createElement("p", [], [], [], [reactiveChild], span())
    const branch = createConditionalBranch(
      createContent("true", "render", [], span()),
      [p],
      span(),
    )
    const renderCond = createConditional([branch], null, span())
    // Shallow check: render-time conditional is not itself reactive at this level
    expect(computeHasReactiveItems([renderCond])).toBe(false)
  })

  it("returns true when mixed with non-reactive siblings", () => {
    const body = [
      createLiteral("static", span()),
      createContent("item.name.get()", "reactive", [dep("item.name")], span()),
      createElement("br", [], [], [], [], span()),
    ]
    expect(computeHasReactiveItems(body)).toBe(true)
  })
})

// =============================================================================
// createBuilder — Target Block Dependency Collection
// =============================================================================

describe("createBuilder - target block dependency collection", () => {
  it("collects dependencies from inside client: target block", () => {
    const reactiveExpr = createContent(
      "count.get()",
      "reactive",
      [dep("count")],
      span(),
    )
    const targetBlock = createTargetBlock("dom", [reactiveExpr], span())
    const builder = createBuilder("div", [], [], [targetBlock], span())

    expect(hasDep(builder.allDependencies, "count")).toBe(true)
    expect(builder.isReactive).toBe(true)
  })

  it("collects dependencies from inside server: target block", () => {
    const reactiveExpr = createContent(
      "doc.title.toString()",
      "reactive",
      [dep("doc.title", "text")],
      span(),
    )
    const targetBlock = createTargetBlock("html", [reactiveExpr], span())
    const builder = createBuilder("div", [], [], [targetBlock], span())

    expect(hasDep(builder.allDependencies, "doc.title")).toBe(true)
    expect(builder.isReactive).toBe(true)
  })

  it("collects dependencies from both client: and server: blocks", () => {
    const clientExpr = createContent(
      "clientRef.get()",
      "reactive",
      [dep("clientRef")],
      span(),
    )
    const serverExpr = createContent(
      "serverRef.get()",
      "reactive",
      [dep("serverRef")],
      span(),
    )
    const clientBlock = createTargetBlock("dom", [clientExpr], span())
    const serverBlock = createTargetBlock("html", [serverExpr], span())
    const builder = createBuilder(
      "div",
      [],
      [],
      [clientBlock, serverBlock],
      span(),
    )

    expect(hasDep(builder.allDependencies, "clientRef")).toBe(true)
    expect(hasDep(builder.allDependencies, "serverRef")).toBe(true)
  })

  it("collects dependencies from nested elements inside target block", () => {
    const reactiveP = createElement(
      "p",
      [],
      [],
      [],
      [
        createContent(
          "doc.message.toString()",
          "reactive",
          [dep("doc.message", "text")],
          span(),
        ),
      ],
      span(),
    )
    const targetBlock = createTargetBlock("dom", [reactiveP], span())
    const builder = createBuilder("div", [], [], [targetBlock], span())

    expect(hasDep(builder.allDependencies, "doc.message")).toBe(true)
  })
})

// =============================================================================
// filterTargetBlocks Tests
// =============================================================================

describe("filterTargetBlocks", () => {
  it("should strip client: blocks when target is html", () => {
    const stmt = createStatement('console.log("client")', span())
    const clientBlock = createTargetBlock("dom", [stmt], span())
    const h1 = createElement(
      "h1",
      [],
      [],
      [],
      [createLiteral("Hello", span())],
      span(),
    )
    const builder = createBuilder("div", [], [], [clientBlock, h1], span())

    const filtered = filterTargetBlocks(builder, "html")

    expect(filtered.children).toHaveLength(1)
    expect(filtered.children[0].kind).toBe("element")
  })

  it("should unwrap client: blocks when target is dom", () => {
    const stmt = createStatement('console.log("client")', span())
    const clientBlock = createTargetBlock("dom", [stmt], span())
    const h1 = createElement(
      "h1",
      [],
      [],
      [],
      [createLiteral("Hello", span())],
      span(),
    )
    const builder = createBuilder("div", [], [], [clientBlock, h1], span())

    const filtered = filterTargetBlocks(builder, "dom")

    expect(filtered.children).toHaveLength(2)
    expect(filtered.children[0].kind).toBe("statement")
    expect((filtered.children[0] as { source: string }).source).toBe(
      'console.log("client")',
    )
    expect(filtered.children[1].kind).toBe("element")
  })

  it("should strip server: blocks when target is dom", () => {
    const stmt = createStatement('console.log("server")', span())
    const serverBlock = createTargetBlock("html", [stmt], span())
    const h1 = createElement(
      "h1",
      [],
      [],
      [],
      [createLiteral("Hello", span())],
      span(),
    )
    const builder = createBuilder("div", [], [], [serverBlock, h1], span())

    const filtered = filterTargetBlocks(builder, "dom")

    expect(filtered.children).toHaveLength(1)
    expect(filtered.children[0].kind).toBe("element")
  })

  it("should unwrap server: blocks when target is html", () => {
    const stmt = createStatement('console.log("server")', span())
    const serverBlock = createTargetBlock("html", [stmt], span())
    const h1 = createElement(
      "h1",
      [],
      [],
      [],
      [createLiteral("Hello", span())],
      span(),
    )
    const builder = createBuilder("div", [], [], [serverBlock, h1], span())

    const filtered = filterTargetBlocks(builder, "html")

    expect(filtered.children).toHaveLength(2)
    expect(filtered.children[0].kind).toBe("statement")
    expect(filtered.children[1].kind).toBe("element")
  })

  it("should recurse into element children", () => {
    const stmt = createStatement('console.log("client")', span())
    const clientBlock = createTargetBlock("dom", [stmt], span())
    const inner = createElement("section", [], [], [], [clientBlock], span())
    const builder = createBuilder("div", [], [], [inner], span())

    // HTML target: client: block stripped from inside element
    const filtered = filterTargetBlocks(builder, "html")
    const section = filtered.children[0]
    expect(section.kind).toBe("element")
    expect((section as { children: unknown[] }).children).toHaveLength(0)

    // DOM target: client: block unwrapped inside element
    const filteredDom = filterTargetBlocks(builder, "dom")
    const sectionDom = filteredDom.children[0]
    expect(sectionDom.kind).toBe("element")
    expect((sectionDom as { children: unknown[] }).children).toHaveLength(1)
    expect(
      ((sectionDom as { children: Array<{ kind: string }> }).children[0]).kind,
    ).toBe("statement")
  })

  it("should recurse into loop bodies", () => {
    const stmt = createStatement('console.log("server")', span())
    const serverBlock = createTargetBlock("html", [stmt], span())
    const li = createElement(
      "li",
      [],
      [],
      [],
      [createLiteral("item", span())],
      span(),
    )
    const loop = createLoop(
      "items",
      "render",
      "item",
      null,
      [serverBlock, li],
      [],
      span(),
    )
    const builder = createBuilder("ul", [], [], [loop], span())

    // DOM target: server: block stripped from loop body
    const filtered = filterTargetBlocks(builder, "dom")
    const filteredLoop = filtered.children[0]
    expect(filteredLoop.kind).toBe("loop")
    expect((filteredLoop as { body: unknown[] }).body).toHaveLength(1)
    expect(
      ((filteredLoop as { body: Array<{ kind: string }> }).body[0]).kind,
    ).toBe("element")

    // HTML target: server: block unwrapped in loop body
    const filteredHtml = filterTargetBlocks(builder, "html")
    const htmlLoop = filteredHtml.children[0]
    expect((htmlLoop as { body: unknown[] }).body).toHaveLength(2)
  })

  it("should recurse into conditional branches", () => {
    const stmt = createStatement('console.log("client")', span())
    const clientBlock = createTargetBlock("dom", [stmt], span())
    const p = createElement(
      "p",
      [],
      [],
      [],
      [createLiteral("Yes", span())],
      span(),
    )
    const branch = createConditionalBranch(
      createContent("true", "render", [], span()),
      [clientBlock, p],
      span(),
    )
    const cond = createConditional([branch], null, span())
    const builder = createBuilder("div", [], [], [cond], span())

    // HTML target: client: block stripped from conditional branch
    const filtered = filterTargetBlocks(builder, "html")
    const filteredCond = filtered.children[0]
    expect(filteredCond.kind).toBe("conditional")
    const branches = (filteredCond as { branches: Array<{ body: unknown[] }> })
      .branches
    expect(branches[0].body).toHaveLength(1)
    expect((branches[0].body[0] as { kind: string }).kind).toBe("element")

    // DOM target: client: block unwrapped in conditional branch
    const filteredDom = filterTargetBlocks(builder, "dom")
    const domCond = filteredDom.children[0]
    const domBranches = (
      domCond as { branches: Array<{ body: unknown[] }> }
    ).branches
    expect(domBranches[0].body).toHaveLength(2)
  })

  it("should handle nested target blocks (target block inside target block)", () => {
    const innerStmt = createStatement("const x = 1", span())
    const innerBlock = createTargetBlock("dom", [innerStmt], span())
    const outerBlock = createTargetBlock("dom", [innerBlock], span())
    const builder = createBuilder("div", [], [], [outerBlock], span())

    // DOM target: both layers unwrap
    const filtered = filterTargetBlocks(builder, "dom")
    expect(filtered.children).toHaveLength(1)
    expect(filtered.children[0].kind).toBe("statement")

    // HTML target: outer strip removes everything
    const filteredHtml = filterTargetBlocks(builder, "html")
    expect(filteredHtml.children).toHaveLength(0)
  })

  it("should handle deeply nested: target block inside element inside loop", () => {
    const stmt = createStatement('console.log("deep")', span())
    const clientBlock = createTargetBlock("dom", [stmt], span())
    const li = createElement("li", [], [], [], [clientBlock], span())
    const loop = createLoop(
      "items",
      "render",
      "item",
      null,
      [li],
      [],
      span(),
    )
    const builder = createBuilder("ul", [], [], [loop], span())

    // HTML target: statement stripped from deep inside
    const filtered = filterTargetBlocks(builder, "html")
    const filteredLoop = filtered.children[0] as { body: Array<{ children: unknown[] }> }
    expect(filteredLoop.body[0].children).toHaveLength(0)

    // DOM target: statement preserved deep inside
    const filteredDom = filterTargetBlocks(builder, "dom")
    const domLoop = filteredDom.children[0] as { body: Array<{ children: Array<{ kind: string }> }> }
    expect(domLoop.body[0].children).toHaveLength(1)
    expect(domLoop.body[0].children[0].kind).toBe("statement")
  })

  it("should unwrap multiple children from a single target block", () => {
    const stmt1 = createStatement("const x = 1", span())
    const stmt2 = createStatement("const y = 2", span())
    const h1 = createElement(
      "h1",
      [],
      [],
      [],
      [createLiteral("Hello", span())],
      span(),
    )
    const clientBlock = createTargetBlock("dom", [stmt1, stmt2, h1], span())
    const builder = createBuilder("div", [], [], [clientBlock], span())

    const filtered = filterTargetBlocks(builder, "dom")

    // All three children should be spliced in
    expect(filtered.children).toHaveLength(3)
    expect(filtered.children[0].kind).toBe("statement")
    expect(filtered.children[1].kind).toBe("statement")
    expect(filtered.children[2].kind).toBe("element")
  })

  it("should not mutate the original builder", () => {
    const stmt = createStatement('console.log("client")', span())
    const clientBlock = createTargetBlock("dom", [stmt], span())
    const builder = createBuilder("div", [], [], [clientBlock], span())

    const filtered = filterTargetBlocks(builder, "html")

    // Original unchanged
    expect(builder.children).toHaveLength(1)
    expect(builder.children[0].kind).toBe("target-block")

    // Filtered has it stripped
    expect(filtered.children).toHaveLength(0)
  })
})
