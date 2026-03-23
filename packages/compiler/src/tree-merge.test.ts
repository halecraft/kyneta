/**
 * Unit tests for tree merge functions.
 *
 * These tests verify the tree merge algorithm that enables conditional
 * dissolution (Level 2 optimization).
 */

import { describe, expect, it } from "vitest"
import {
  createConditionalBranch,
  createContent,
  createElement,
  createLiteral,
  createSpan,
  createStatement,
  type DeltaKind,
  type Dependency,
  mergeConditionalBodies,
  mergeContentValue,
  mergeNode,
} from "./ir.js"

// =============================================================================
// Test Helpers
// =============================================================================

function span() {
  return createSpan(1, 0, 1, 10)
}

/**
 * Create a dependency with a given source and optional delta kind.
 * Defaults to "replace" for simplicity in tests.
 */
function dep(source: string, deltaKind: DeltaKind = "replace"): Dependency {
  return { source, deltaKind }
}

// =============================================================================
// mergeContentValue Tests
// =============================================================================

describe("mergeContentValue", () => {
  const condition = createContent("x", "reactive", [dep("x")], span())

  it("keeps identical literals as-is", () => {
    const a = createLiteral("Hello", span())
    const b = createLiteral("Hello", span())

    const result = mergeContentValue(a, b, condition)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.value.source).toBe('"Hello"')
      expect(result.value.bindingTime).toBe("literal")
    }
  })

  it("promotes different literals to reactive with ternary", () => {
    const a = createLiteral("Yes", span())
    const b = createLiteral("No", span())

    const result = mergeContentValue(a, b, condition)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.value.bindingTime).toBe("reactive")
      expect(result.value.source).toContain("?")
      expect(result.value.source).toContain('"Yes"')
      expect(result.value.source).toContain('"No"')
    }
  })

  it("promotes literal + render to reactive", () => {
    const a = createLiteral("Static", span())
    const b = createContent("someVar", "render", [], span())

    const result = mergeContentValue(a, b, condition)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.value.bindingTime).toBe("reactive")
      expect(result.value.source).toContain("?")
      expect(result.value.source).toContain('"Static"')
      expect(result.value.source).toContain("someVar")
    }
  })

  it("promotes two render-time values to reactive with ternary", () => {
    const a = createContent("varA", "render", [], span())
    const b = createContent("varB", "render", [], span())

    const result = mergeContentValue(a, b, condition)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.value.bindingTime).toBe("reactive")
      expect(result.value.source).toContain("?")
      expect(result.value.source).toContain("varA")
      expect(result.value.source).toContain("varB")
    }
  })

  it("keeps identical reactive expressions as-is", () => {
    const a = createContent("doc.count", "reactive", [dep("doc.count")], span())
    const b = createContent("doc.count", "reactive", [dep("doc.count")], span())

    const result = mergeContentValue(a, b, condition)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.value.source).toBe("doc.count")
      expect(result.value.bindingTime).toBe("reactive")
    }
  })

  it("returns failure for reactive with different deps", () => {
    const a = createContent("doc.count", "reactive", [dep("doc.count")], span())
    const b = createContent("doc.total", "reactive", [dep("doc.total")], span())

    const result = mergeContentValue(a, b, condition)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason.kind).toBe("incompatible-binding-times")
    }
  })

  it("merges reactive + literal into nested ternary", () => {
    const a = createContent("doc.count", "reactive", [dep("doc.count")], span())
    const b = createLiteral("Static", span())

    const result = mergeContentValue(a, b, condition)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.value.bindingTime).toBe("reactive")
      expect(result.value.source).toContain("?")
      expect(result.value.source).toContain("doc.count")
      expect(result.value.source).toContain('"Static"')
    }
  })
})

// =============================================================================
// mergeNode Tests
// =============================================================================

describe("mergeNode", () => {
  const condition = createContent("x", "reactive", [dep("x")], span())

  it("merges same element with different literal content children", () => {
    const a = createElement(
      "div",
      [],
      [],
      [],
      [createLiteral("A", span())],
      span(),
    )
    const b = createElement(
      "div",
      [],
      [],
      [],
      [createLiteral("B", span())],
      span(),
    )

    const result = mergeNode(a, b, condition)

    expect(result.success).toBe(true)
    if (result.success && result.value.kind === "element") {
      expect(result.value.tag).toBe("div")
      expect(result.value.children.length).toBe(1)
      const child = result.value.children[0]
      if (child.kind === "content") {
        expect(child.bindingTime).toBe("reactive")
        expect(child.source).toContain("?")
      }
    }
  })

  it("merges same element with different static attribute values", () => {
    const a = createElement(
      "div",
      [{ name: "class", value: createLiteral("active", span()) }],
      [],
      [],
      [],
      span(),
    )
    const b = createElement(
      "div",
      [{ name: "class", value: createLiteral("inactive", span()) }],
      [],
      [],
      [],
      span(),
    )

    const result = mergeNode(a, b, condition)

    expect(result.success).toBe(true)
    if (result.success && result.value.kind === "element") {
      expect(result.value.attributes.length).toBe(1)
      const attr = result.value.attributes[0]
      expect(attr.name).toBe("class")
      expect(attr.value.bindingTime).toBe("reactive")
    }
  })

  it("keeps identical reactive content as-is", () => {
    const expr = createContent(
      "doc.title",
      "reactive",
      [dep("doc.title")],
      span(),
    )
    const a = createElement("p", [], [], [], [expr], span())
    const b = createElement("p", [], [], [], [expr], span())

    const result = mergeNode(a, b, condition)

    expect(result.success).toBe(true)
    if (result.success && result.value.kind === "element") {
      const child = result.value.children[0]
      if (child.kind === "content") {
        expect(child.bindingTime).toBe("reactive")
        expect(child.source).toBe("doc.title")
      }
    }
  })

  it("returns failure for reactive content with different deps", () => {
    const a = createElement(
      "p",
      [],
      [],
      [],
      [createContent("doc.a", "reactive", [dep("doc.a")], span())],
      span(),
    )
    const b = createElement(
      "p",
      [],
      [],
      [],
      [createContent("doc.b", "reactive", [dep("doc.b")], span())],
      span(),
    )

    const result = mergeNode(a, b, condition)

    expect(result.success).toBe(false)
  })

  it("returns failure for different element tags", () => {
    const a = createElement("p", [], [], [], [], span())
    const b = createElement("div", [], [], [], [], span())

    const result = mergeNode(a, b, condition)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason.kind).toBe("different-tags")
    }
  })

  it("returns failure for different child counts", () => {
    const a = createElement(
      "div",
      [],
      [],
      [],
      [createLiteral("A", span())],
      span(),
    )
    const b = createElement(
      "div",
      [],
      [],
      [],
      [createLiteral("A", span()), createLiteral("B", span())],
      span(),
    )

    const result = mergeNode(a, b, condition)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason.kind).toBe("different-child-counts")
    }
  })

  it("returns failure for different event handler sources", () => {
    const a = createElement(
      "button",
      [],
      [
        {
          event: "click",
          propName: "onClick",
          handlerSource: "() => a()",
          span: span(),
        },
      ],
      [],
      [],
      span(),
    )
    const b = createElement(
      "button",
      [],
      [
        {
          event: "click",
          propName: "onClick",
          handlerSource: "() => b()",
          span: span(),
        },
      ],
      [],
      [],
      span(),
    )

    const result = mergeNode(a, b, condition)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason.kind).toBe("different-event-handlers")
    }
  })

  it("returns failure for different attribute name sets", () => {
    const a = createElement(
      "div",
      [{ name: "class", value: createLiteral("a", span()) }],
      [],
      [],
      [],
      span(),
    )
    const b = createElement(
      "div",
      [{ name: "id", value: createLiteral("b", span()) }],
      [],
      [],
      [],
      span(),
    )

    const result = mergeNode(a, b, condition)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason.kind).toBe("different-attribute-sets")
    }
  })

  it("keeps identical statements as-is", () => {
    const a = createStatement("const x = 1", span())
    const b = createStatement("const x = 1", span())

    const result = mergeNode(a, b, condition)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.value.kind).toBe("statement")
    }
  })

  it("returns failure for different statement sources", () => {
    const a = createStatement("const x = 1", span())
    const b = createStatement("const y = 2", span())

    const result = mergeNode(a, b, condition)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason.kind).toBe("different-statement-sources")
    }
  })

  it("recursively merges nested elements", () => {
    const a = createElement(
      "div",
      [],
      [],
      [],
      [createElement("span", [], [], [], [createLiteral("A", span())], span())],
      span(),
    )
    const b = createElement(
      "div",
      [],
      [],
      [],
      [createElement("span", [], [], [], [createLiteral("B", span())], span())],
      span(),
    )

    const result = mergeNode(a, b, condition)

    expect(result.success).toBe(true)
    if (result.success && result.value.kind === "element") {
      const child = result.value.children[0]
      if (child.kind === "element") {
        const innerChild = child.children[0]
        if (innerChild.kind === "content") {
          expect(innerChild.bindingTime).toBe("reactive")
        }
      }
    }
  })
})

// =============================================================================
// mergeConditionalBodies Tests
// =============================================================================

describe("mergeConditionalBodies", () => {
  it("merges two fully compatible branches", () => {
    const bodyA = [
      createElement("p", [], [], [], [createLiteral("A", span())], span()),
    ]
    const bodyB = [
      createElement("p", [], [], [], [createLiteral("B", span())], span()),
    ]

    const branches = [
      createConditionalBranch(
        createContent("x", "reactive", [dep("x")], span()),
        bodyA,
        span(),
      ),
      createConditionalBranch(null, bodyB, span()),
    ]

    const result = mergeConditionalBodies(branches)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.value.length).toBe(1)
      const node = result.value[0]
      if (node.kind === "element") {
        expect(node.tag).toBe("p")
        const child = node.children[0]
        if (child.kind === "content") {
          expect(child.bindingTime).toBe("reactive")
          expect(child.source).toContain("?")
        }
      }
    }
  })

  it("returns failure when branches are not compatible", () => {
    const bodyA = [createElement("p", [], [], [], [], span())]
    const bodyB = [createElement("div", [], [], [], [], span())]

    const branches = [
      createConditionalBranch(
        createContent("x", "reactive", [dep("x")], span()),
        bodyA,
        span(),
      ),
      createConditionalBranch(null, bodyB, span()),
    ]

    const result = mergeConditionalBodies(branches)

    expect(result.success).toBe(false)
  })

  it("merges three branches with nested ternaries", () => {
    const bodyA = [
      createElement("p", [], [], [], [createLiteral("A", span())], span()),
    ]
    const bodyB = [
      createElement("p", [], [], [], [createLiteral("B", span())], span()),
    ]
    const bodyC = [
      createElement("p", [], [], [], [createLiteral("C", span())], span()),
    ]

    const branches = [
      createConditionalBranch(
        createContent("a", "reactive", [dep("a")], span()),
        bodyA,
        span(),
      ),
      createConditionalBranch(
        createContent("b", "reactive", [dep("b")], span()),
        bodyB,
        span(),
      ),
      createConditionalBranch(null, bodyC, span()),
    ]

    const result = mergeConditionalBodies(branches)

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.value.length).toBe(1)
      const node = result.value[0]
      if (node.kind === "element") {
        const child = node.children[0]
        if (child.kind === "content") {
          expect(child.bindingTime).toBe("reactive")
          // Should have nested ternary
          const ternaryCount = (child.source.match(/\?/g) || []).length
          expect(ternaryCount).toBeGreaterThanOrEqual(2)
        }
      }
    }
  })

  it("returns failure when bodies have different lengths", () => {
    const bodyA = [
      createElement("p", [], [], [], [createLiteral("A", span())], span()),
    ]
    const bodyB = [
      createElement("p", [], [], [], [createLiteral("B", span())], span()),
      createElement("span", [], [], [], [], span()),
    ]

    const branches = [
      createConditionalBranch(
        createContent("x", "reactive", [dep("x")], span()),
        bodyA,
        span(),
      ),
      createConditionalBranch(null, bodyB, span()),
    ]

    const result = mergeConditionalBodies(branches)

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.reason.kind).toBe("different-child-counts")
    }
  })

  it("returns failure for single branch", () => {
    const bodyA = [createElement("p", [], [], [], [], span())]

    const branches = [
      createConditionalBranch(
        createContent("x", "reactive", [dep("x")], span()),
        bodyA,
        span(),
      ),
    ]

    const result = mergeConditionalBodies(branches)

    expect(result.success).toBe(false)
  })
})
