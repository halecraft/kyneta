/**
 * Unit tests for DOM code generation.
 *
 * These tests verify that the DOM code generator produces correct
 * JavaScript code from IR nodes.
 */

import {
  type AttributeNode,
  type ClassifiedDependency,
  createBuilder,
  createConditional,
  createConditionalBranch,
  createContent,
  createElement,
  createLiteral,
  createLoop,
  createSpan,
  createStatement,
  type DeltaKind,
  type Dependency,
  type EventHandlerNode,
  type FilterMetadata,
} from "@kyneta/compiler"
import { dissolveConditionals } from "@kyneta/compiler/transforms"
import { describe, expect, it } from "vitest"
import {
  generateDOM,
  generateElementFactory,
  generateElementFactoryWithResult,
} from "./dom.js"

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
          [dep("isActive")],
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

      // valueRegion handles both init and subscription; no separate static set
      expect(code).toContain("valueRegion(")
      expect(code).toContain("[isActive]")
      expect(code).toContain('isActive ? "active" : "inactive"')
      expect(code).toContain(".className = v")
      expect(code).not.toContain("subscribe(")
    })
  })

  describe("event handlers", () => {
    it("should generate code for click handler", () => {
      const handler: EventHandlerNode = {
        event: "click",
        propName: "onClick",
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
  })

  describe("reactive expressions", () => {
    it("should generate subscription for reactive text content", () => {
      const reactiveExpr = createContent(
        "count.get()",
        "reactive",
        [dep("count")],
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

      expect(code).toContain("valueRegion(")
      expect(code).toContain("[count]")
      expect(code).toContain("count.get()")
      expect(code).toContain("textContent")
    })
  })

  describe("multi-dependency subscriptions", () => {
    it("should generate valueRegion for text content with multiple dependencies", () => {
      const reactiveExpr = createContent(
        "first.get() + ' ' + last.get()",
        "reactive",
        [dep("first"), dep("last")],
        span(1, 4, 1, 35),
      )
      const builder = createBuilder(
        "span",
        [],
        [],
        [reactiveExpr],
        span(1, 0, 1, 40),
      )

      const code = generateDOM(builder)

      // Uses valueRegion with array of deps
      expect(code).toContain("valueRegion(")
      expect(code).toContain("[first, last]")
      expect(code).toContain("textContent")
    })
  })

  describe("text patching with textRegion", () => {
    it("should generate textRegion for direct TextRef read", () => {
      // doc.title.get() where doc.title is a TextRef
      // directReadSource = "doc.title", dep has deltaKind = "text"
      const directRead = createContent(
        "doc.title.get()",
        "reactive",
        [dep("doc.title", "text")],
        span(1, 4, 1, 20),
        "doc.title", // directReadSource
      )
      const builder = createBuilder(
        "p",
        [],
        [],
        [directRead],
        span(1, 0, 1, 22),
      )

      const code = generateDOM(builder)

      // Should use textRegion instead of valueRegion
      expect(code).toContain("textRegion")
      expect(code).toContain("doc.title")
      expect(code).not.toContain("textContent")
    })

    it("should generate valueRegion for non-direct TextRef read", () => {
      // doc.title.get().toUpperCase() — directReadSource is undefined
      const nonDirectRead = createContent(
        "doc.title.get().toUpperCase()",
        "reactive",
        [dep("doc.title", "text")],
        span(1, 4, 1, 32),
        // no directReadSource — this is not a direct read
      )
      const builder = createBuilder(
        "p",
        [],
        [],
        [nonDirectRead],
        span(1, 0, 1, 34),
      )

      const code = generateDOM(builder)

      // Should use valueRegion, NOT textRegion
      expect(code).toContain("valueRegion(")
      expect(code).toContain("textContent")
      expect(code).not.toContain("textRegion")
    })

    it("should generate valueRegion for multi-dep expression with TextRef", () => {
      // doc.title.get() + doc.subtitle.get() — two deps, uses valueRegion
      const multiDepRead = createContent(
        "doc.title.get() + ' - ' + doc.subtitle.get()",
        "reactive",
        [dep("doc.title", "text"), dep("doc.subtitle", "text")],
        span(1, 4, 1, 48),
        // no directReadSource — multi-dep is never a direct read
      )
      const builder = createBuilder(
        "span",
        [],
        [],
        [multiDepRead],
        span(1, 0, 1, 50),
      )

      const code = generateDOM(builder)

      // Should use valueRegion, NOT textRegion
      expect(code).toContain("valueRegion(")
      expect(code).toContain("[doc.title, doc.subtitle]")
      expect(code).not.toContain("textRegion")
    })

    it("should generate valueRegion for non-text deltaKind even with directReadSource", () => {
      // Edge case: directReadSource is set but deltaKind is not "text"
      // This shouldn't happen in practice, but codegen should handle it safely
      const replaceRead = createContent(
        "count.get()",
        "reactive",
        [dep("count", "replace")], // deltaKind is "replace", not "text"
        span(1, 4, 1, 16),
        "count", // directReadSource is set
      )
      const builder = createBuilder(
        "span",
        [],
        [],
        [replaceRead],
        span(1, 0, 1, 18),
      )

      const code = generateDOM(builder)

      // Should use valueRegion because deltaKind is not "text"
      expect(code).toContain("valueRegion(")
      expect(code).not.toContain("textRegion")
    })
  })

  describe("inputTextRegion dispatch for value attributes", () => {
    it("should generate inputTextRegion for value attr with direct TextRef read", () => {
      // value: doc.title.toString() where doc.title is a TextRef
      const valueAttr: AttributeNode = {
        name: "value",
        value: createContent(
          "doc.title.toString()",
          "reactive",
          [dep("doc.title", "text")],
          span(1, 10, 1, 30),
          "doc.title", // directReadSource
        ),
      }
      const builder = createBuilder(
        "input",
        [valueAttr],
        [],
        [],
        span(1, 0, 1, 35),
      )

      const code = generateDOM(builder)

      // Should use inputTextRegion instead of naive subscribe
      expect(code).toContain("inputTextRegion")
      expect(code).toContain("doc.title")
      expect(code).not.toContain("subscribe(")
      // Should NOT set initial value (inputTextRegion handles it)
      expect(code).not.toContain(".value =")
    })

    it("should generate naive subscribe for value attr with deltaKind replace", () => {
      const valueAttr: AttributeNode = {
        name: "value",
        value: createContent(
          "doc.selected.get()",
          "reactive",
          [dep("doc.selected", "replace")],
          span(1, 10, 1, 30),
          "doc.selected", // directReadSource set, but deltaKind is "replace"
        ),
      }
      const builder = createBuilder(
        "input",
        [valueAttr],
        [],
        [],
        span(1, 0, 1, 35),
      )

      const code = generateDOM(builder)

      expect(code).toContain("valueRegion(")
      expect(code).toContain("[doc.selected]")
      expect(code).toContain(".value = v")
      expect(code).not.toContain("inputTextRegion")
      expect(code).not.toContain("subscribe(")
    })

    it("should generate naive subscribe for value attr without directReadSource", () => {
      const valueAttr: AttributeNode = {
        name: "value",
        value: createContent(
          "doc.title.toString().toUpperCase()",
          "reactive",
          [dep("doc.title", "text")],
          span(1, 10, 1, 40),
          // no directReadSource — this is not a direct read
        ),
      }
      const builder = createBuilder(
        "input",
        [valueAttr],
        [],
        [],
        span(1, 0, 1, 45),
      )

      const code = generateDOM(builder)

      expect(code).toContain("valueRegion(")
      expect(code).toContain("[doc.title]")
      expect(code).toContain(".value = v")
      expect(code).not.toContain("inputTextRegion")
      expect(code).not.toContain("subscribe(")
    })

    it("should NOT use inputTextRegion for non-value attributes even with TextRef", () => {
      // class: doc.theme.toString() — not a value attribute
      const classAttr: AttributeNode = {
        name: "class",
        value: createContent(
          "doc.theme.toString()",
          "reactive",
          [dep("doc.theme", "text")],
          span(1, 10, 1, 30),
          "doc.theme",
        ),
      }
      const builder = createBuilder(
        "div",
        [classAttr],
        [],
        [],
        span(1, 0, 1, 35),
      )

      const code = generateDOM(builder)

      expect(code).toContain("valueRegion(")
      expect(code).toContain("[doc.theme]")
      expect(code).toContain(".className = v")
      expect(code).not.toContain("inputTextRegion")
      expect(code).not.toContain("subscribe(")
    })
  })
})

// =============================================================================
// generateElementFactoryWithResult Tests - Template Cloning Attribute Fixes
// =============================================================================

describe("generateElementFactoryWithResult - template cloning attributes", () => {
  it("should use .value = for value attribute hole (not setAttribute)", () => {
    const valueAttr: AttributeNode = {
      name: "value",
      value: createContent("currentText", "render", [], span(1, 15, 1, 26)),
    }
    const builder = createBuilder(
      "input",
      [valueAttr],
      [],
      [],
      span(1, 0, 1, 30),
    )

    const result = generateElementFactoryWithResult(builder)

    expect(result.code).toContain(".value =")
    expect(result.code).toContain("currentText")
    expect(result.code).not.toContain("setAttribute")
  })

  it("should use .checked = for checked attribute hole (not setAttribute)", () => {
    const checkedAttr: AttributeNode = {
      name: "checked",
      value: createContent("isChecked", "render", [], span(1, 15, 1, 24)),
    }
    const builder = createBuilder(
      "input",
      [checkedAttr],
      [],
      [],
      span(1, 0, 1, 30),
    )

    const result = generateElementFactoryWithResult(builder)

    expect(result.code).toContain(".checked =")
    expect(result.code).toContain("isChecked")
    expect(result.code).not.toContain("setAttribute")
  })

  it("should use Object.assign for style attribute hole (not setAttribute)", () => {
    const styleAttr: AttributeNode = {
      name: "style",
      value: createContent(
        "{ color: 'red' }",
        "render",
        [],
        span(1, 15, 1, 32),
      ),
    }
    const builder = createBuilder("div", [styleAttr], [], [], span(1, 0, 1, 35))

    const result = generateElementFactoryWithResult(builder)

    expect(result.code).toContain("Object.assign")
    expect(result.code).toContain(".style")
    expect(result.code).not.toContain("setAttribute")
  })

  it("should use .className = for reactive class attribute in cloning path", () => {
    const classAttr: AttributeNode = {
      name: "class",
      value: createContent(
        'isActive ? "on" : "off"',
        "reactive",
        [dep("isActive")],
        span(1, 15, 1, 38),
      ),
    }
    const builder = createBuilder("div", [classAttr], [], [], span(1, 0, 1, 40))

    const result = generateElementFactoryWithResult(builder)

    expect(result.code).toContain(".className =")
    expect(result.code).not.toContain("setAttribute")
  })

  it("should use .disabled = for reactive disabled attribute in cloning path", () => {
    const disabledAttr: AttributeNode = {
      name: "disabled",
      value: createContent(
        "isDisabled.get()",
        "reactive",
        [dep("isDisabled")],
        span(1, 15, 1, 31),
      ),
    }
    const builder = createBuilder(
      "button",
      [disabledAttr],
      [],
      [],
      span(1, 0, 1, 35),
    )

    const result = generateElementFactoryWithResult(builder)

    expect(result.code).toContain(".disabled =")
    expect(result.code).not.toContain("setAttribute")
  })

  it("should generate inputTextRegion for value attr with TextRef in cloning path", () => {
    const valueAttr: AttributeNode = {
      name: "value",
      value: createContent(
        "doc.title.toString()",
        "reactive",
        [dep("doc.title", "text")],
        span(1, 15, 1, 35),
        "doc.title", // directReadSource
      ),
    }
    const builder = createBuilder(
      "input",
      [valueAttr],
      [],
      [],
      span(1, 0, 1, 40),
    )

    const result = generateElementFactoryWithResult(builder)

    expect(result.code).toContain("inputTextRegion")
    expect(result.code).toContain("doc.title")
    // Should not have a separate .value = set (inputTextRegion handles init)
    expect(result.code).not.toContain(".value =")
    expect(result.code).not.toContain("setAttribute")
  })

  it("should still use setAttribute for unknown attributes in cloning path", () => {
    const ariaAttr: AttributeNode = {
      name: "aria-label",
      value: createContent("labelText", "render", [], span(1, 15, 1, 24)),
    }
    const builder = createBuilder(
      "button",
      [ariaAttr],
      [],
      [],
      span(1, 0, 1, 30),
    )

    const result = generateElementFactoryWithResult(builder)

    expect(result.code).toContain("setAttribute")
    expect(result.code).toContain('"aria-label"')
  })
})

// =============================================================================
// generateDOM Tests - List Regions
// =============================================================================

describe("generateDOM - list regions", () => {
  it("should generate listRegion call", () => {
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
      [dep("items")],
      span(2, 2, 4, 3),
    )
    const builder = createBuilder("ul", [], [], [loop], span(1, 0, 5, 1))

    const code = generateDOM(builder)

    expect(code).toContain("listRegion")
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
      [dep("items")],
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
      [dep("items")],
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
      [dep("items")],
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
  it("should generate conditionalRegion call for reactive condition", () => {
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
        [dep("count")],
        span(2, 6, 2, 22),
      ),
      [pElement],
      span(2, 4, 4, 3),
    )
    const conditionalRegion = createConditional(
      [branch],
      dep("count"),
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

    expect(code).toContain("conditionalRegion")
    expect(code).toContain("count")
    expect(code).toContain("whenTrue")
    expect(code).toContain("createComment")
  })

  it("should dissolve conditional with identical structure (Level 2)", () => {
    // Conditional with identical structure but different literal content
    // Dissolution happens at the IR level (dissolveConditionals), before codegen
    const trueBranch = createConditionalBranch(
      createContent(
        "count.get() > 0",
        "reactive",
        [dep("count")],
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
      dep("count"),
      span(2, 2, 6, 3),
    )
    const builder = createBuilder(
      "div",
      [],
      [],
      [conditionalRegion],
      span(1, 0, 7, 1),
    )

    // Apply IR-level dissolution before codegen (mirrors transform pipeline)
    const dissolved = dissolveConditionals(builder)
    const code = generateDOM(dissolved)

    // Should NOT contain conditionalRegion (dissolved)
    expect(code).not.toContain("conditionalRegion")
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

  it("should fallback to conditionalRegion when structure differs", () => {
    // Conditional with different element types - cannot dissolve
    const trueBranch = createConditionalBranch(
      createContent(
        "count.get() > 0",
        "reactive",
        [dep("count")],
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
      dep("count"),
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

    // Should contain conditionalRegion (not dissolved)
    expect(code).toContain("conditionalRegion")
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
    expect(code).not.toContain("conditionalRegion")
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
          [
            createContent(
              "item.text",
              "reactive",
              [dep("item")],
              span(3, 0, 3, 10),
            ),
          ],
          span(2, 0, 4, 1),
        ),
      ],
      [dep("items")],
      span(1, 0, 5, 1),
    )

    const conditionalBranch = createConditionalBranch(
      createContent(
        "count.get() > 0",
        "reactive",
        [dep("count")],
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
      dep("count"),
      span(1, 0, 3, 1),
    )

    const builder = createBuilder(
      "div",
      [
        {
          name: "class",
          value: createContent(
            "cls",
            "reactive",
            [dep("cls")],
            span(1, 0, 1, 5),
          ),
        },
      ],
      [
        {
          event: "click",
          propName: "onClick",
          handlerSource: "() => {}",
          span: span(1, 0, 1, 10),
        },
      ],
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
      [dep("items")],
      span(2, 2, 5, 3),
    )
    const builder = createBuilder("ul", [], [], [loop], span(1, 0, 6, 1))

    const code = generateDOM(builder)

    expect(code).toContain("listRegion")
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

// =============================================================================
// Template Cloning Path - Dissolution Integration Tests
// =============================================================================

describe("generateElementFactoryWithResult - dissolution on cloning path", () => {
  it("should produce dissolved output (no conditionalRegion, ternary in template) when IR is pre-dissolved", () => {
    // Build a dissolvable conditional: if (count > 0) p("Yes") else p("No")
    const trueBranch = createConditionalBranch(
      createContent(
        "count.get() > 0",
        "reactive",
        [dep("count")],
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
    const cond = createConditional(
      [trueBranch, falseBranch],
      dep("count"),
      span(2, 2, 6, 3),
    )
    const builder = createBuilder("div", [], [], [cond], span(1, 0, 7, 1))

    // Apply dissolution at IR level (simulating what the transform pipeline will do)
    const dissolved = dissolveConditionals(builder)

    // Generate via template cloning path
    const result = generateElementFactoryWithResult(dissolved)

    // Should NOT contain conditionalRegion (dissolved)
    expect(result.code).not.toContain("conditionalRegion")
    expect(result.code).not.toContain("whenTrue")
    expect(result.code).not.toContain("whenFalse")

    // Template HTML should NOT contain region comment markers
    for (const decl of result.moduleDeclarations) {
      expect(decl).not.toContain("kyneta:if")
    }

    // Should contain ternary expression (the dissolved merge result)
    expect(result.code).toContain("?")
    expect(result.code).toContain('"Yes"')
    expect(result.code).toContain('"No"')

    // Should contain a subscription call for the reactive ternary
    expect(
      result.code.includes("subscribe(") ||
        result.code.includes("valueRegion("),
    ).toBe(true)
  })

  it("should still emit conditionalRegion on cloning path for non-dissolvable conditional", () => {
    // Non-dissolvable: different tags (p vs div)
    const trueBranch = createConditionalBranch(
      createContent("flag.get()", "reactive", [dep("flag")], span(2, 6, 2, 16)),
      [
        createElement(
          "p",
          [],
          [],
          [],
          [createLiteral("Paragraph", span(3, 6, 3, 17))],
          span(3, 4, 3, 19),
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
          [createLiteral("Div", span(5, 6, 5, 11))],
          span(5, 4, 5, 13),
        ),
      ],
      span(4, 4, 6, 3),
    )
    const cond = createConditional(
      [trueBranch, falseBranch],
      dep("flag"),
      span(2, 2, 6, 3),
    )
    const builder = createBuilder("div", [], [], [cond], span(1, 0, 7, 1))

    // Apply dissolution — should be a no-op for this non-dissolvable conditional
    const dissolved = dissolveConditionals(builder)

    const result = generateElementFactoryWithResult(dissolved)

    // Should still contain conditionalRegion (not dissolved)
    expect(result.code).toContain("conditionalRegion")
    expect(result.code).toContain("whenTrue")

    // Template HTML should contain region comment markers
    const hasMarker = result.moduleDeclarations.some(decl =>
      decl.includes("kyneta:if"),
    )
    expect(hasMarker).toBe(true)
  })
})

// =============================================================================
// generateDOM - filtered list regions
// =============================================================================

describe("generateDOM - filtered list regions", () => {
  /**
   * Helper to create a ClassifiedDependency.
   */
  function classifiedDep(
    source: string,
    classification: "item" | "external" | "structural",
    deltaKind: DeltaKind = "replace",
  ): ClassifiedDependency {
    return { source, deltaKind, classification }
  }

  it("should generate filteredListRegion call when filter metadata is present", () => {
    // Build a loop body that matches the filter pattern:
    //   for (const recipe of doc.recipes) {
    //     if (recipe.vegetarian()) { p("veggie") }
    //   }
    const pElement = createElement(
      "p",
      [],
      [],
      [],
      [createLiteral("veggie", span(4, 6, 4, 14))],
      span(4, 4, 4, 16),
    )
    const branch = createConditionalBranch(
      createContent("recipe.vegetarian()", "reactive", [dep("recipe.vegetarian")], span(3, 8, 3, 30)),
      [pElement],
      span(3, 4, 5, 5),
    )
    const conditional = createConditional(
      [branch],
      dep("recipe.vegetarian"),
      span(3, 4, 5, 5),
    )

    const filter: FilterMetadata = {
      predicate: createContent(
        "recipe.vegetarian()",
        "reactive",
        [dep("recipe.vegetarian")],
        span(3, 8, 3, 30),
      ),
      itemDeps: [classifiedDep("recipe.vegetarian", "item")],
      externalDeps: [],
    }

    const loop = createLoop(
      "doc.recipes",
      "reactive",
      "recipe",
      null,
      [conditional],
      [dep("doc.recipes")],
      span(2, 2, 6, 3),
      filter,
    )
    const builder = createBuilder("div", [], [], [loop], span(1, 0, 7, 1))

    const code = generateDOM(builder)

    // Should use filteredListRegion, NOT listRegion
    expect(code).toContain("filteredListRegion")
    expect(code).not.toContain("listRegion(")
    // Should NOT contain conditionalRegion (the filter conditional is handled internally)
    expect(code).not.toContain("conditionalRegion")

    // Should contain the expected handler properties
    expect(code).toContain("create:")
    expect(code).toContain("predicate:")
    expect(code).toContain("externalRefs:")
    expect(code).toContain("itemRefs:")
    expect(code).toContain("slotKind:")
    expect(code).toContain("isReactive: true")

    // itemRefs should reference recipe.vegetarian
    expect(code).toContain("recipe.vegetarian")
  })

  it("should generate filteredListRegion with external deps", () => {
    // Build a loop body with mixed deps:
    //   for (const recipe of doc.recipes) {
    //     const nameMatch = recipe.name().toLowerCase().includes(filterText().toLowerCase())
    //     if (nameMatch) { p("match") }
    //   }
    const pElement = createElement(
      "p",
      [],
      [],
      [],
      [createLiteral("match", span(5, 6, 5, 13))],
      span(5, 4, 5, 15),
    )
    const branch = createConditionalBranch(
      createContent("nameMatch", "reactive", [dep("recipe.name"), dep("filterText")], span(4, 8, 4, 18)),
      [pElement],
      span(4, 4, 6, 5),
    )
    const conditional = createConditional(
      [branch],
      dep("recipe.name"),
      span(4, 4, 6, 5),
    )

    const filter: FilterMetadata = {
      predicate: createContent(
        "recipe.name().toLowerCase().includes(filterText().toLowerCase())",
        "reactive",
        [dep("recipe.name"), dep("filterText")],
        span(3, 8, 3, 70),
      ),
      itemDeps: [classifiedDep("recipe.name", "item")],
      externalDeps: [classifiedDep("filterText", "external")],
    }

    const loop = createLoop(
      "doc.recipes",
      "reactive",
      "recipe",
      null,
      [conditional],
      [dep("doc.recipes")],
      span(2, 2, 7, 3),
      filter,
    )
    const builder = createBuilder("div", [], [], [loop], span(1, 0, 8, 1))

    const code = generateDOM(builder)

    expect(code).toContain("filteredListRegion")
    // externalRefs should contain filterText
    expect(code).toContain("externalRefs: [filterText]")
    // itemRefs should contain recipe.name
    expect(code).toContain("recipe.name")
    expect(code).toContain("itemRefs:")
  })

})
