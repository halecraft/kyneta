/**
 * Tests for template extraction from IR.
 */

import { describe, expect, it } from "vitest"
import {
  extractTemplate,
  hasHoles,
  isStatic,
  getHolesByKind,
  countHolesByKind,
} from "./template.js"
import {
  createBuilder,
  createConditional,
  createConditionalBranch,
  createElement,
  createLiteral,
  createLoop,
  createSpan,
  type BuilderNode,
  type ChildNode,
  type ElementNode,
} from "./ir.js"

// =============================================================================
// Test Helpers
// =============================================================================

function makeSpan() {
  return createSpan(1, 0, 1, 10)
}

function makeBuilder(
  tag: string,
  children: ChildNode[] = [],
  props: Parameters<typeof createBuilder>[1] = [],
  eventHandlers: Parameters<typeof createBuilder>[2] = [],
): BuilderNode {
  return createBuilder(tag, props, eventHandlers, children, makeSpan())
}

function makeElement(
  tag: string,
  children: ChildNode[] = [],
  attributes: Parameters<typeof createElement>[1] = [],
  eventHandlers: Parameters<typeof createElement>[2] = [],
  bindings: Parameters<typeof createElement>[3] = [],
): ElementNode {
  return createElement(
    tag,
    attributes,
    eventHandlers,
    bindings,
    children,
    makeSpan(),
  )
}

function makeLiteral(value: string) {
  return createLiteral(value, makeSpan())
}

function makeReactiveContent() {
  return {
    kind: "content" as const,
    source: "doc.title.get()",
    bindingTime: "reactive" as const,
    dependencies: [{ source: "doc.title", deltaKind: "text" as const }],
    span: makeSpan(),
  }
}

// =============================================================================
// Static Template Tests
// =============================================================================

describe("extractTemplate", () => {
  describe("static templates", () => {
    it("should extract empty element", () => {
      const node = makeBuilder("div")
      const template = extractTemplate(node)

      expect(template.html).toBe("<div></div>")
      expect(template.holes).toHaveLength(0)
    })

    it("should extract element with static text", () => {
      const node = makeBuilder("p", [makeLiteral("Hello, world!")])
      const template = extractTemplate(node)

      expect(template.html).toBe("<p>Hello, world!</p>")
      expect(template.holes).toHaveLength(0)
    })

    it("should extract element with static attribute", () => {
      const node = makeBuilder(
        "div",
        [],
        [{ name: "class", value: makeLiteral("container") }],
      )
      const template = extractTemplate(node)

      expect(template.html).toBe('<div class="container"></div>')
      expect(template.holes).toHaveLength(0)
    })

    it("should extract nested elements", () => {
      const inner = makeElement("span", [makeLiteral("text")])
      const node = makeBuilder("div", [inner])
      const template = extractTemplate(node)

      expect(template.html).toBe("<div><span>text</span></div>")
      expect(template.holes).toHaveLength(0)
    })

    it("should handle void elements", () => {
      const node = makeBuilder("div", [makeElement("br"), makeElement("hr")])
      const template = extractTemplate(node)

      expect(template.html).toBe("<div><br><hr></div>")
      expect(template.holes).toHaveLength(0)
    })

    it("should escape HTML in static text", () => {
      const node = makeBuilder("p", [
        makeLiteral("<script>alert('xss')</script>"),
      ])
      const template = extractTemplate(node)

      expect(template.html).toBe(
        "<p>&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;</p>",
      )
    })

    it("should escape HTML in static attributes", () => {
      const node = makeBuilder(
        "div",
        [],
        [{ name: "data-text", value: makeLiteral('He said "hello"') }],
      )
      const template = extractTemplate(node)

      expect(template.html).toBe(
        '<div data-text="He said &quot;hello&quot;"></div>',
      )
    })
  })

  // =============================================================================
  // Dynamic Content Tests
  // =============================================================================

  describe("dynamic content", () => {
    it("should record hole for dynamic text", () => {
      const reactive = makeReactiveContent()
      const node = makeBuilder("p", [reactive])
      const template = extractTemplate(node)

      expect(template.holes).toHaveLength(1)
      expect(template.holes[0]).toMatchObject({
        kind: "text",
        path: [0],
        contentNode: reactive,
      })
    })

    it("should record hole for dynamic attribute", () => {
      const reactive = makeReactiveContent()
      const node = makeBuilder("div", [], [{ name: "class", value: reactive }])
      const template = extractTemplate(node)

      expect(template.holes).toHaveLength(1)
      expect(template.holes[0]).toMatchObject({
        kind: "attribute",
        attributeName: "class",
        path: [],
      })
      // HTML should have empty placeholder
      expect(template.html).toContain('class=""')
    })

    it("should record hole for event handler", () => {
      const handler = {
        event: "click",
        handlerSource: "() => console.log('clicked')",
        span: makeSpan(),
      }
      const node = makeBuilder("button", [], [], [handler])
      const template = extractTemplate(node)

      expect(template.holes).toHaveLength(1)
      expect(template.holes[0]).toMatchObject({
        kind: "event",
        eventName: "click",
        path: [],
      })
      // No HTML output for events
      expect(template.html).toBe("<button></button>")
    })

    it("should record hole for two-way binding", () => {
      const binding = {
        attribute: "value",
        refSource: "doc.title",
        bindingType: "value" as const,
        span: makeSpan(),
      }
      const element = makeElement("input", [], [], [], [binding])
      const node = makeBuilder("div", [element])
      const template = extractTemplate(node)

      expect(template.holes).toHaveLength(1)
      expect(template.holes[0]).toMatchObject({
        kind: "binding",
        bindingType: "value",
        refSource: "doc.title",
        path: [0],
      })
    })
  })

  // =============================================================================
  // Region Tests
  // =============================================================================

  describe("regions", () => {
    it("should record hole for reactive loop", () => {
      const loop = createLoop(
        "doc.items",
        "reactive",
        "item",
        null,
        [makeLiteral("item")],
        [{ source: "doc.items", deltaKind: "list" }],
        makeSpan(),
      )
      const node = makeBuilder("ul", [loop])
      const template = extractTemplate(node)

      expect(template.holes).toHaveLength(1)
      expect(template.holes[0]).toMatchObject({
        kind: "region",
        path: [0],
        regionNode: loop,
      })
      // HTML should have comment markers
      expect(template.html).toContain("<!--kinetic:list:1-->")
      expect(template.html).toContain("<!--/kinetic:list-->")
    })

    it("should record hole for reactive conditional", () => {
      const reactiveDep = {
        source: "doc.visible",
        deltaKind: "replace" as const,
      }
      const conditional = createConditional(
        [
          createConditionalBranch(
            makeReactiveContent(),
            [makeLiteral("Visible")],
            makeSpan(),
          ),
        ],
        reactiveDep,
        makeSpan(),
      )
      const node = makeBuilder("div", [conditional])
      const template = extractTemplate(node)

      expect(template.holes).toHaveLength(1)
      expect(template.holes[0]).toMatchObject({
        kind: "region",
        path: [0],
        regionNode: conditional,
      })
      // HTML should have comment markers for conditional
      expect(template.html).toContain("<!--kinetic:if:1-->")
      expect(template.html).toContain("<!--/kinetic:if-->")
    })

    it("should assign unique marker IDs to multiple regions", () => {
      const loop1 = createLoop(
        "doc.items1",
        "reactive",
        "item",
        null,
        [makeLiteral("item")],
        [{ source: "doc.items1", deltaKind: "list" }],
        makeSpan(),
      )
      const loop2 = createLoop(
        "doc.items2",
        "reactive",
        "item",
        null,
        [makeLiteral("item")],
        [{ source: "doc.items2", deltaKind: "list" }],
        makeSpan(),
      )
      const node = makeBuilder("div", [loop1, loop2])
      const template = extractTemplate(node)

      expect(template.holes).toHaveLength(2)
      expect(template.html).toContain("<!--kinetic:list:1-->")
      expect(template.html).toContain("<!--kinetic:list:2-->")
      expect(template.markerIdCounter).toBe(2)
    })
  })

  // =============================================================================
  // Path Tests
  // =============================================================================

  describe("paths", () => {
    it("should have correct path for nested dynamic content", () => {
      const reactive = makeReactiveContent()
      const inner = makeElement("span", [reactive])
      const node = makeBuilder("div", [inner])
      const template = extractTemplate(node)

      expect(template.holes[0].path).toEqual([0, 0])
    })

    it("should have correct paths for sibling dynamic content", () => {
      const reactive1 = makeReactiveContent()
      const reactive2 = { ...makeReactiveContent(), source: "doc.other.get()" }
      const node = makeBuilder("div", [reactive1, reactive2])
      const template = extractTemplate(node)

      expect(template.holes).toHaveLength(2)
      expect(template.holes[0].path).toEqual([0])
      expect(template.holes[1].path).toEqual([1])
    })

    it("should have correct paths in complex nested structure", () => {
      const reactive = makeReactiveContent()
      const deepInner = makeElement("span", [reactive])
      const middle = makeElement("p", [deepInner])
      const node = makeBuilder("div", [middle])
      const template = extractTemplate(node)

      expect(template.holes[0].path).toEqual([0, 0, 0])
    })
  })

  // =============================================================================
  // Mixed Content Tests
  // =============================================================================

  describe("mixed content", () => {
    it("should handle mix of static and dynamic content", () => {
      const node = makeBuilder("p", [
        makeLiteral("Hello, "),
        makeReactiveContent(),
        makeLiteral("!"),
      ])
      const template = extractTemplate(node)

      expect(template.html).toBe("<p>Hello, !</p>")
      expect(template.holes).toHaveLength(1)
      expect(template.holes[0]).toMatchObject({
        kind: "text",
        path: [1],
      })
    })

    it("should handle static and dynamic attributes together", () => {
      const reactive = makeReactiveContent()
      const node = makeBuilder(
        "div",
        [],
        [
          { name: "id", value: makeLiteral("main") },
          { name: "class", value: reactive },
        ],
      )
      const template = extractTemplate(node)

      expect(template.html).toContain('id="main"')
      expect(template.html).toContain('class=""')
      expect(template.holes).toHaveLength(1)
      expect(template.holes[0].kind).toBe("attribute")
    })
  })
})

// =============================================================================
// Utility Function Tests
// =============================================================================

describe("utility functions", () => {
  describe("hasHoles", () => {
    it("should return false for static template", () => {
      const node = makeBuilder("div", [makeLiteral("Hello")])
      const template = extractTemplate(node)
      expect(hasHoles(template)).toBe(false)
    })

    it("should return true for template with holes", () => {
      const node = makeBuilder("div", [makeReactiveContent()])
      const template = extractTemplate(node)
      expect(hasHoles(template)).toBe(true)
    })
  })

  describe("isStatic", () => {
    it("should return true for static template", () => {
      const node = makeBuilder("div", [makeLiteral("Hello")])
      const template = extractTemplate(node)
      expect(isStatic(template)).toBe(true)
    })

    it("should return false for template with holes", () => {
      const node = makeBuilder("div", [makeReactiveContent()])
      const template = extractTemplate(node)
      expect(isStatic(template)).toBe(false)
    })
  })

  describe("getHolesByKind", () => {
    it("should filter holes by kind", () => {
      const reactive = makeReactiveContent()
      const handler = {
        event: "click",
        handlerSource: "() => {}",
        span: makeSpan(),
      }
      const node = makeBuilder("button", [reactive], [], [handler])
      const template = extractTemplate(node)

      const textHoles = getHolesByKind(template, "text")
      const eventHoles = getHolesByKind(template, "event")

      expect(textHoles).toHaveLength(1)
      expect(eventHoles).toHaveLength(1)
    })
  })

  describe("countHolesByKind", () => {
    it("should count holes by kind", () => {
      const reactive1 = makeReactiveContent()
      const reactive2 = { ...makeReactiveContent(), source: "doc.other.get()" }
      const handler = {
        event: "click",
        handlerSource: "() => {}",
        span: makeSpan(),
      }
      const node = makeBuilder("div", [reactive1, reactive2], [], [handler])
      const template = extractTemplate(node)

      const counts = countHolesByKind(template)

      expect(counts.get("text")).toBe(2)
      expect(counts.get("event")).toBe(1)
    })
  })
})
