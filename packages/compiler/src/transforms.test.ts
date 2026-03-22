/**
 * Tests for consumer-side IR transforms: filterTargetBlocks and dissolveConditionals.
 *
 * These tests verify:
 * - `filterTargetBlocks`: strips/unwraps client:/server: target blocks
 *   based on the compilation target (html vs dom).
 * - `dissolveConditionals`: merges structurally compatible conditional
 *   branches into reactive ternary expressions, eliminating runtime branching.
 */

import { describe, expect, it } from "vitest"
import {
  createBinding,
  createBuilder,
  createConditional,
  createConditionalBranch,
  createContent,
  createElement,
  createLiteral,
  createLoop,
  createSpan,
  createStatement,
  createLabeledBlock,
  type BindingNode,
  type Dependency,
  type DeltaKind,
} from "./ir.js"
import { dissolveConditionals, filterTargetBlocks } from "./transforms.js"

// =============================================================================
// Test Helpers
// =============================================================================

function dep(source: string, deltaKind: DeltaKind = "replace"): Dependency {
  return { source, deltaKind }
}

function span() {
  return createSpan(1, 0, 1, 10)
}

// =============================================================================
// filterTargetBlocks Tests
// =============================================================================

describe("filterTargetBlocks", () => {
  it("should strip client: blocks when target is html", () => {
    const stmt = createStatement('console.log("client")', span())
    const clientBlock = createLabeledBlock("client", [stmt], span())
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
    const clientBlock = createLabeledBlock("client", [stmt], span())
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
    const serverBlock = createLabeledBlock("server", [stmt], span())
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
    const serverBlock = createLabeledBlock("server", [stmt], span())
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
    const clientBlock = createLabeledBlock("client", [stmt], span())
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
    const serverBlock = createLabeledBlock("server", [stmt], span())
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
    const clientBlock = createLabeledBlock("client", [stmt], span())
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
    const innerBlock = createLabeledBlock("client", [innerStmt], span())
    const outerBlock = createLabeledBlock("client", [innerBlock], span())
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
    const clientBlock = createLabeledBlock("client", [stmt], span())
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
    const clientBlock = createLabeledBlock("client", [stmt1, stmt2, h1], span())
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
    const clientBlock = createLabeledBlock("client", [stmt], span())
    const builder = createBuilder("div", [], [], [clientBlock], span())

    const filtered = filterTargetBlocks(builder, "html")

    // Original unchanged
    expect(builder.children).toHaveLength(1)
    expect(builder.children[0].kind).toBe("labeled-block")

    // Filtered has it stripped
    expect(filtered.children).toHaveLength(0)
  })
})

// =============================================================================
// dissolveConditionals Tests
// =============================================================================

describe("dissolveConditionals", () => {
  // ---------------------------------------------------------------------------
  // Positive cases: dissolution succeeds
  // ---------------------------------------------------------------------------

  it("should dissolve two-branch conditional with same-tag elements and different literal text", () => {
    const trueBranch = createConditionalBranch(
      createContent("count.get() > 0", "reactive", [dep("count")], span()),
      [
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("Yes", span())],
          span(),
        ),
      ],
      span(),
    )
    const falseBranch = createConditionalBranch(
      null,
      [
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("No", span())],
          span(),
        ),
      ],
      span(),
    )
    const cond = createConditional(
      [trueBranch, falseBranch],
      dep("count"),
      span(),
    )
    const builder = createBuilder("div", [], [], [cond], span())

    const dissolved = dissolveConditionals(builder)

    // Conditional should be gone — replaced by the merged element
    expect(dissolved.children).toHaveLength(1)
    expect(dissolved.children[0].kind).toBe("element")

    const element = dissolved.children[0] as { kind: string; tag: string; children: Array<{ kind: string; source: string; bindingTime: string }> }
    expect(element.tag).toBe("p")
    expect(element.children).toHaveLength(1)

    // The text child should be a ternary (reactive content)
    const textChild = element.children[0]
    expect(textChild.kind).toBe("content")
    expect(textChild.bindingTime).toBe("reactive")
    expect(textChild.source).toContain("?")
    expect(textChild.source).toContain('"Yes"')
    expect(textChild.source).toContain('"No"')
  })

  it("should dissolve two-branch conditional with same-tag elements and different literal attributes", () => {
    const trueAttr = {
      name: "class",
      value: createLiteral("active", span()),
    }
    const falseAttr = {
      name: "class",
      value: createLiteral("inactive", span()),
    }
    const trueBranch = createConditionalBranch(
      createContent("isActive.get()", "reactive", [dep("isActive")], span()),
      [createElement("div", [trueAttr], [], [], [], span())],
      span(),
    )
    const falseBranch = createConditionalBranch(
      null,
      [createElement("div", [falseAttr], [], [], [], span())],
      span(),
    )
    const cond = createConditional(
      [trueBranch, falseBranch],
      dep("isActive"),
      span(),
    )
    const builder = createBuilder("section", [], [], [cond], span())

    const dissolved = dissolveConditionals(builder)

    expect(dissolved.children).toHaveLength(1)
    expect(dissolved.children[0].kind).toBe("element")

    const element = dissolved.children[0] as { kind: string; tag: string; attributes: Array<{ name: string; value: { source: string; bindingTime: string } }> }
    expect(element.tag).toBe("div")
    expect(element.attributes).toHaveLength(1)

    // Attribute value should be a ternary (reactive)
    const classAttr = element.attributes[0]
    expect(classAttr.name).toBe("class")
    expect(classAttr.value.bindingTime).toBe("reactive")
    expect(classAttr.value.source).toContain("?")
    expect(classAttr.value.source).toContain('"active"')
    expect(classAttr.value.source).toContain('"inactive"')
  })

  it("should dissolve three-branch (if/else-if/else) into nested ternary", () => {
    const branch1 = createConditionalBranch(
      createContent("x.get() === 1", "reactive", [dep("x")], span()),
      [
        createElement(
          "span",
          [],
          [],
          [],
          [createLiteral("One", span())],
          span(),
        ),
      ],
      span(),
    )
    const branch2 = createConditionalBranch(
      createContent("x.get() === 2", "reactive", [dep("x")], span()),
      [
        createElement(
          "span",
          [],
          [],
          [],
          [createLiteral("Two", span())],
          span(),
        ),
      ],
      span(),
    )
    const elseBranch = createConditionalBranch(
      null,
      [
        createElement(
          "span",
          [],
          [],
          [],
          [createLiteral("Other", span())],
          span(),
        ),
      ],
      span(),
    )
    const cond = createConditional(
      [branch1, branch2, elseBranch],
      dep("x"),
      span(),
    )
    const builder = createBuilder("div", [], [], [cond], span())

    const dissolved = dissolveConditionals(builder)

    expect(dissolved.children).toHaveLength(1)
    expect(dissolved.children[0].kind).toBe("element")

    const element = dissolved.children[0] as { kind: string; tag: string; children: Array<{ kind: string; source: string; bindingTime: string }> }
    expect(element.tag).toBe("span")

    // The text should be a nested ternary
    const textChild = element.children[0]
    expect(textChild.kind).toBe("content")
    expect(textChild.bindingTime).toBe("reactive")
    expect(textChild.source).toContain('"One"')
    expect(textChild.source).toContain('"Two"')
    expect(textChild.source).toContain('"Other"')
  })

  it("should dissolve conditional nested inside an element", () => {
    const trueBranch = createConditionalBranch(
      createContent("flag.get()", "reactive", [dep("flag")], span()),
      [createLiteral("On", span())],
      span(),
    )
    const falseBranch = createConditionalBranch(
      null,
      [createLiteral("Off", span())],
      span(),
    )
    // mergeConditionalBodies merges ContentValue nodes directly
    // (literal + literal → reactive ternary)
    const cond = createConditional(
      [trueBranch, falseBranch],
      dep("flag"),
      span(),
    )
    const outerDiv = createElement("div", [], [], [], [cond], span())
    const builder = createBuilder("section", [], [], [outerDiv], span())

    const dissolved = dissolveConditionals(builder)

    // The outer div should still be there
    expect(dissolved.children).toHaveLength(1)
    expect(dissolved.children[0].kind).toBe("element")
    const div = dissolved.children[0] as { kind: string; tag: string; children: Array<{ kind: string }> }
    expect(div.tag).toBe("div")

    // The conditional inside should be dissolved into content
    expect(div.children).toHaveLength(1)
    expect(div.children[0].kind).toBe("content")
    const content = div.children[0] as { kind: string; source: string; bindingTime: string }
    expect(content.bindingTime).toBe("reactive")
    expect(content.source).toContain("?")
  })

  it("should dissolve conditional nested inside a loop body", () => {
    const trueBranch = createConditionalBranch(
      createContent("item.get()", "reactive", [dep("item")], span()),
      [
        createElement(
          "b",
          [],
          [],
          [],
          [createLiteral("Active", span())],
          span(),
        ),
      ],
      span(),
    )
    const falseBranch = createConditionalBranch(
      null,
      [
        createElement(
          "b",
          [],
          [],
          [],
          [createLiteral("Inactive", span())],
          span(),
        ),
      ],
      span(),
    )
    const cond = createConditional(
      [trueBranch, falseBranch],
      dep("item"),
      span(),
    )
    const loop = createLoop(
      "items",
      "reactive",
      "item",
      null,
      [cond],
      [dep("items")],
      span(),
    )
    const builder = createBuilder("ul", [], [], [loop], span())

    const dissolved = dissolveConditionals(builder)

    // Loop should still be there
    expect(dissolved.children).toHaveLength(1)
    expect(dissolved.children[0].kind).toBe("loop")
    const loopNode = dissolved.children[0] as { kind: string; body: Array<{ kind: string; tag: string }> }

    // The conditional inside the loop should be dissolved into a <b> element
    expect(loopNode.body).toHaveLength(1)
    expect(loopNode.body[0].kind).toBe("element")
    expect(loopNode.body[0].tag).toBe("b")
  })

  // ---------------------------------------------------------------------------
  // Negative cases: conditional preserved
  // ---------------------------------------------------------------------------

  it("should preserve render-time conditional (subscriptionTarget === null)", () => {
    const branch = createConditionalBranch(
      createContent("true", "render", [], span()),
      [
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("Always", span())],
          span(),
        ),
      ],
      span(),
    )
    const elseBranch = createConditionalBranch(
      null,
      [
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("Never", span())],
          span(),
        ),
      ],
      span(),
    )
    // subscriptionTarget = null → render-time
    const cond = createConditional([branch, elseBranch], null, span())
    const builder = createBuilder("div", [], [], [cond], span())

    const dissolved = dissolveConditionals(builder)

    expect(dissolved.children).toHaveLength(1)
    expect(dissolved.children[0].kind).toBe("conditional")
  })

  it("should preserve conditional with no else branch", () => {
    const branch = createConditionalBranch(
      createContent("count.get() > 0", "reactive", [dep("count")], span()),
      [
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("Has items", span())],
          span(),
        ),
      ],
      span(),
    )
    // No else branch — only one branch
    const cond = createConditional([branch], dep("count"), span())
    const builder = createBuilder("div", [], [], [cond], span())

    const dissolved = dissolveConditionals(builder)

    expect(dissolved.children).toHaveLength(1)
    expect(dissolved.children[0].kind).toBe("conditional")
  })

  it("should preserve conditional with different element tags in branches", () => {
    const trueBranch = createConditionalBranch(
      createContent("flag.get()", "reactive", [dep("flag")], span()),
      [
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("Paragraph", span())],
          span(),
        ),
      ],
      span(),
    )
    const falseBranch = createConditionalBranch(
      null,
      [
        createElement(
          "div",
          [],
          [],
          [],
          [createLiteral("Div", span())],
          span(),
        ),
      ],
      span(),
    )
    const cond = createConditional(
      [trueBranch, falseBranch],
      dep("flag"),
      span(),
    )
    const builder = createBuilder("section", [], [], [cond], span())

    const dissolved = dissolveConditionals(builder)

    // Different tags → merge fails → conditional preserved
    expect(dissolved.children).toHaveLength(1)
    expect(dissolved.children[0].kind).toBe("conditional")
  })

  it("should preserve conditional with different child counts in branches", () => {
    const trueBranch = createConditionalBranch(
      createContent("flag.get()", "reactive", [dep("flag")], span()),
      [
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("One", span())],
          span(),
        ),
      ],
      span(),
    )
    const falseBranch = createConditionalBranch(
      null,
      [
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("A", span())],
          span(),
        ),
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("B", span())],
          span(),
        ),
      ],
      span(),
    )
    const cond = createConditional(
      [trueBranch, falseBranch],
      dep("flag"),
      span(),
    )
    const builder = createBuilder("div", [], [], [cond], span())

    const dissolved = dissolveConditionals(builder)

    // Different body lengths → merge fails → conditional preserved
    expect(dissolved.children).toHaveLength(1)
    expect(dissolved.children[0].kind).toBe("conditional")
  })

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it("should dissolve one conditional and preserve another in the same builder", () => {
    // Dissolvable: same tags, different text
    const dissolvableTrueBranch = createConditionalBranch(
      createContent("a.get()", "reactive", [dep("a")], span()),
      [
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("Yes", span())],
          span(),
        ),
      ],
      span(),
    )
    const dissolvableFalseBranch = createConditionalBranch(
      null,
      [
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("No", span())],
          span(),
        ),
      ],
      span(),
    )
    const dissolvableCond = createConditional(
      [dissolvableTrueBranch, dissolvableFalseBranch],
      dep("a"),
      span(),
    )

    // Non-dissolvable: different tags
    const nonDissolvableTrueBranch = createConditionalBranch(
      createContent("b.get()", "reactive", [dep("b")], span()),
      [
        createElement(
          "span",
          [],
          [],
          [],
          [createLiteral("Span", span())],
          span(),
        ),
      ],
      span(),
    )
    const nonDissolvableFalseBranch = createConditionalBranch(
      null,
      [
        createElement(
          "div",
          [],
          [],
          [],
          [createLiteral("Div", span())],
          span(),
        ),
      ],
      span(),
    )
    const nonDissolvableCond = createConditional(
      [nonDissolvableTrueBranch, nonDissolvableFalseBranch],
      dep("b"),
      span(),
    )

    const builder = createBuilder(
      "div",
      [],
      [],
      [dissolvableCond, nonDissolvableCond],
      span(),
    )

    const dissolved = dissolveConditionals(builder)

    // First conditional dissolved → element; second preserved → conditional
    expect(dissolved.children).toHaveLength(2)
    expect(dissolved.children[0].kind).toBe("element")
    expect((dissolved.children[0] as { tag: string }).tag).toBe("p")
    expect(dissolved.children[1].kind).toBe("conditional")
  })

  it("should not mutate the original builder", () => {
    const trueBranch = createConditionalBranch(
      createContent("x.get()", "reactive", [dep("x")], span()),
      [createLiteral("A", span())],
      span(),
    )
    const falseBranch = createConditionalBranch(
      null,
      [createLiteral("B", span())],
      span(),
    )
    const cond = createConditional(
      [trueBranch, falseBranch],
      dep("x"),
      span(),
    )
    const builder = createBuilder("div", [], [], [cond], span())

    const dissolved = dissolveConditionals(builder)

    // Original still has the conditional
    expect(builder.children).toHaveLength(1)
    expect(builder.children[0].kind).toBe("conditional")

    // Dissolved has content instead
    expect(dissolved.children).toHaveLength(1)
    expect(dissolved.children[0].kind).toBe("content")
  })

  it("should handle builder with no conditionals (no-op)", () => {
    const h1 = createElement(
      "h1",
      [],
      [],
      [],
      [createLiteral("Hello", span())],
      span(),
    )
    const builder = createBuilder("div", [], [], [h1], span())

    const dissolved = dissolveConditionals(builder)

    expect(dissolved.children).toHaveLength(1)
    expect(dissolved.children[0].kind).toBe("element")
  })

  it("should recurse into non-dissolvable conditional branch bodies", () => {
    // Inner conditional is dissolvable
    const innerTrue = createConditionalBranch(
      createContent("inner.get()", "reactive", [dep("inner")], span()),
      [createLiteral("X", span())],
      span(),
    )
    const innerFalse = createConditionalBranch(
      null,
      [createLiteral("Y", span())],
      span(),
    )
    const innerCond = createConditional(
      [innerTrue, innerFalse],
      dep("inner"),
      span(),
    )

    // Outer conditional is NOT dissolvable (no else branch)
    const outerBranch = createConditionalBranch(
      createContent("outer.get()", "reactive", [dep("outer")], span()),
      [innerCond],
      span(),
    )
    const outerCond = createConditional([outerBranch], dep("outer"), span())
    const builder = createBuilder("div", [], [], [outerCond], span())

    const dissolved = dissolveConditionals(builder)

    // Outer conditional preserved
    expect(dissolved.children).toHaveLength(1)
    expect(dissolved.children[0].kind).toBe("conditional")

    // But inner conditional inside the branch body was dissolved
    const branches = (dissolved.children[0] as { branches: Array<{ body: Array<{ kind: string }> }> }).branches
    expect(branches[0].body).toHaveLength(1)
    expect(branches[0].body[0].kind).toBe("content")
  })
})

// =============================================================================
// BindingNode Pass-Through Tests
// =============================================================================

describe("filterTargetBlocks - BindingNode pass-through", () => {
  it("should pass through bindings at top level", () => {
    const value = createContent("x.get()", "reactive", [dep("x")], span())
    const binding = createBinding("myVar", value, span())
    const h1 = createElement("h1", [], [], [], [createLiteral("Title", span())], span())
    const builder = createBuilder("div", [], [], [binding, h1], span())

    const filtered = filterTargetBlocks(builder, "dom")

    expect(filtered.children).toHaveLength(2)
    expect(filtered.children[0].kind).toBe("binding")
    const b = filtered.children[0] as BindingNode
    expect(b.name).toBe("myVar")
    expect(b.value.source).toBe("x.get()")
  })

  it("should pass through bindings inside element children", () => {
    const value = createContent("x.get()", "reactive", [dep("x")], span())
    const binding = createBinding("myVar", value, span())
    const p = createElement("p", [], [], [], [createLiteral("text", span())], span())
    const section = createElement("section", [], [], [], [binding, p], span())
    const builder = createBuilder("div", [], [], [section], span())

    const filtered = filterTargetBlocks(builder, "dom")

    const filteredSection = filtered.children[0]
    expect(filteredSection.kind).toBe("element")
    if (filteredSection.kind === "element") {
      expect(filteredSection.children).toHaveLength(2)
      expect(filteredSection.children[0].kind).toBe("binding")
    }
  })

  it("should pass through bindings inside loop body", () => {
    const value = createContent("item.get()", "reactive", [dep("item")], span())
    const binding = createBinding("val", value, span())
    const li = createElement("li", [], [], [], [createLiteral("item", span())], span())
    const loop = createLoop("items", "reactive", "item", null, [binding, li], [dep("items")], span())
    const builder = createBuilder("ul", [], [], [loop], span())

    const filtered = filterTargetBlocks(builder, "dom")

    const filteredLoop = filtered.children[0]
    expect(filteredLoop.kind).toBe("loop")
    if (filteredLoop.kind === "loop") {
      expect(filteredLoop.body).toHaveLength(2)
      expect(filteredLoop.body[0].kind).toBe("binding")
    }
  })

  it("should pass through bindings inside conditional branches", () => {
    const value = createContent("x.get()", "reactive", [dep("x")], span())
    const binding = createBinding("myVar", value, span())
    const p = createElement("p", [], [], [], [createLiteral("yes", span())], span())
    const branch = createConditionalBranch(
      createContent("cond", "reactive", [dep("cond")], span()),
      [binding, p],
      span(),
    )
    const cond = createConditional([branch], dep("cond"), span())
    const builder = createBuilder("div", [], [], [cond], span())

    const filtered = filterTargetBlocks(builder, "dom")

    const filteredCond = filtered.children[0]
    expect(filteredCond.kind).toBe("conditional")
    if (filteredCond.kind === "conditional") {
      expect(filteredCond.branches[0].body).toHaveLength(2)
      expect(filteredCond.branches[0].body[0].kind).toBe("binding")
    }
  })
})

describe("dissolveConditionals - BindingNode pass-through", () => {
  it("should pass through bindings at top level alongside a non-dissolvable conditional", () => {
    const value = createContent("x.get()", "reactive", [dep("x")], span())
    const binding = createBinding("myVar", value, span())

    // A non-dissolvable conditional (no else branch)
    const branch = createConditionalBranch(
      createContent("cond", "reactive", [dep("cond")], span()),
      [createElement("p", [], [], [], [createLiteral("yes", span())], span())],
      span(),
    )
    const cond = createConditional([branch], dep("cond"), span())
    const builder = createBuilder("div", [], [], [binding, cond], span())

    const dissolved = dissolveConditionals(builder)

    expect(dissolved.children).toHaveLength(2)
    expect(dissolved.children[0].kind).toBe("binding")
    expect(dissolved.children[1].kind).toBe("conditional")
  })

  it("should pass through bindings inside loop body during dissolution", () => {
    const value = createContent("item.name()", "reactive", [dep("item.name")], span())
    const binding = createBinding("name", value, span())
    const li = createElement("li", [], [], [], [createLiteral("text", span())], span())
    const loop = createLoop("items", "reactive", "item", null, [binding, li], [dep("items")], span())
    const builder = createBuilder("ul", [], [], [loop], span())

    const dissolved = dissolveConditionals(builder)

    const loopNode = dissolved.children[0]
    expect(loopNode.kind).toBe("loop")
    if (loopNode.kind === "loop") {
      expect(loopNode.body).toHaveLength(2)
      expect(loopNode.body[0].kind).toBe("binding")
      const b = loopNode.body[0] as BindingNode
      expect(b.name).toBe("name")
    }
  })
})