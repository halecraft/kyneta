/**
 * Tests for template extraction from IR.
 */

import { describe, expect, it } from "vitest"
import {
  type BuilderNode,
  type ChildNode,
  createBuilder,
  createConditional,
  createConditionalBranch,
  createElement,
  createLiteral,
  createLoop,
  createSpan,
  type ElementNode,
} from "./ir.js"
import {
  countHolesByKind,
  extractTemplate,
  generateTemplateDeclaration,
  generateWalkCode,
  getHolesByKind,
  hasHoles,
  isStatic,
  type NavOp,
  planWalk,
  simpleHash,
} from "./template.js"

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
      // Dynamic text emits a comment placeholder so the cloned DOM has a
      // real node at this child position for the walker to grab
      expect(template.html).toBe("<p><!----></p>")
    })

    it("should emit comment placeholder for each dynamic text in mixed content", () => {
      const reactive1 = makeReactiveContent()
      const reactive2 = {
        kind: "content" as const,
        source: "doc.count.get()",
        bindingTime: "reactive" as const,
        dependencies: [{ source: "doc.count", deltaKind: "replace" as const }],
        span: makeSpan(),
      }
      // "Hello " + reactive1 + " and " + reactive2 + "!"
      const node = makeBuilder("p", [
        makeLiteral("Hello "),
        reactive1,
        makeLiteral(" and "),
        reactive2,
        makeLiteral("!"),
      ])
      const template = extractTemplate(node)

      // Each dynamic text gets its own comment placeholder
      expect(template.html).toBe("<p>Hello <!----> and <!---->!</p>")
      expect(template.holes).toHaveLength(2)
      expect(template.holes[0]).toMatchObject({ kind: "text", path: [1] })
      expect(template.holes[1]).toMatchObject({ kind: "text", path: [3] })
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
        propName: "onClick",
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

    it("should store handlerSource on event holes", () => {
      const handler = {
        event: "input",
        propName: "onInput",
        handlerSource: "(e) => doc.title.insert(0, e.target.value)",
        span: makeSpan(),
      }
      const node = makeBuilder("input", [], [], [handler])
      const template = extractTemplate(node)

      expect(template.holes).toHaveLength(1)
      expect(template.holes[0]).toMatchObject({
        kind: "event",
        eventName: "input",
        handlerSource: "(e) => doc.title.insert(0, e.target.value)",
        path: [],
      })
    })

    it("should store handlerSource on child element event holes", () => {
      const handler = {
        event: "click",
        propName: "onClick",
        handlerSource: "handleClick",
        span: makeSpan(),
      }
      const button = createElement(
        "button",
        [],
        [handler],
        [],
        [createLiteral("Click me", makeSpan())],
        makeSpan(),
      )
      const node = makeBuilder("div", [button])
      const template = extractTemplate(node)

      const eventHole = template.holes.find(h => h.kind === "event")
      expect(eventHole).toBeDefined()
      expect(eventHole?.handlerSource).toBe("handleClick")
      expect(eventHole?.eventName).toBe("click")
      expect(eventHole?.path).toEqual([0])
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
        [{ source: "doc.items", deltaKind: "sequence" }],
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
      expect(template.html).toContain("<!--kyneta:list:1-->")
      expect(template.html).toContain("<!--/kyneta:list-->")
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
      expect(template.html).toContain("<!--kyneta:if:1-->")
      expect(template.html).toContain("<!--/kyneta:if-->")
    })

    it("should assign unique marker IDs to multiple regions", () => {
      const loop1 = createLoop(
        "doc.items1",
        "reactive",
        "item",
        null,
        [makeLiteral("item")],
        [{ source: "doc.items1", deltaKind: "sequence" }],
        makeSpan(),
      )
      const loop2 = createLoop(
        "doc.items2",
        "reactive",
        "item",
        null,
        [makeLiteral("item")],
        [{ source: "doc.items2", deltaKind: "sequence" }],
        makeSpan(),
      )
      const node = makeBuilder("div", [loop1, loop2])
      const template = extractTemplate(node)

      expect(template.holes).toHaveLength(2)
      expect(template.html).toContain("<!--kyneta:list:1-->")
      expect(template.html).toContain("<!--kyneta:list:2-->")
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

      expect(template.html).toBe("<p>Hello, <!---->!</p>")
      expect(template.holes).toHaveLength(1)
      expect(template.holes[0]).toMatchObject({
        kind: "text",
        path: [1],
      })
    })

    it("should preserve correct child indices with comment placeholders", () => {
      // "A" + dynamic + "B" + dynamic + "C"
      // Children: [0]=text "A", [1]=comment, [2]=text "B", [3]=comment, [4]=text "C"
      const reactive1 = makeReactiveContent()
      const reactive2 = {
        kind: "content" as const,
        source: "doc.count.get()",
        bindingTime: "reactive" as const,
        dependencies: [{ source: "doc.count", deltaKind: "replace" as const }],
        span: makeSpan(),
      }
      const node = makeBuilder("p", [
        makeLiteral("A"),
        reactive1,
        makeLiteral("B"),
        reactive2,
        makeLiteral("C"),
      ])
      const template = extractTemplate(node)

      expect(template.html).toBe("<p>A<!---->B<!---->C</p>")
      // The two dynamic holes should reference correct child indices
      expect(template.holes[0]).toMatchObject({ kind: "text", path: [1] })
      expect(template.holes[1]).toMatchObject({ kind: "text", path: [3] })
    })

    it("should handle single dynamic text child (no siblings)", () => {
      const reactive = makeReactiveContent()
      const node = makeBuilder("span", [reactive])
      const template = extractTemplate(node)

      expect(template.html).toBe("<span><!----></span>")
      expect(template.holes).toHaveLength(1)
      expect(template.holes[0]).toMatchObject({ kind: "text", path: [0] })
    })

    // ===========================================================================
    // Component Placeholder Tests
    // ===========================================================================

    describe("component placeholders", () => {
      it("should emit comment placeholder for component elements", () => {
        const component = createElement(
          "Avatar",
          [{ name: "src", value: makeLiteral("photo.jpg") }],
          [],
          [],
          [],
          makeSpan(),
          "Avatar", // factorySource makes it a component
        )
        const node = makeBuilder("div", [component])
        const template = extractTemplate(node)

        // Component should NOT be serialized as <Avatar> — just a placeholder
        expect(template.html).toBe("<div><!----></div>")
        expect(template.html).not.toContain("<Avatar")
        expect(template.holes).toHaveLength(1)
        expect(template.holes[0]).toMatchObject({
          kind: "component",
          path: [0],
        })
        expect(template.holes[0].elementNode).toBeDefined()
        expect(template.holes[0].elementNode?.factorySource).toBe("Avatar")
      })

      it("should handle component between static elements", () => {
        const component = createElement(
          "Separator",
          [],
          [],
          [],
          [],
          makeSpan(),
          "Separator",
        )
        const node = makeBuilder("div", [
          makeElement("h1", [makeLiteral("Title")]),
          component,
          makeElement("p", [makeLiteral("Content")]),
        ])
        const template = extractTemplate(node)

        expect(template.html).toBe(
          "<div><h1>Title</h1><!----><p>Content</p></div>",
        )
        expect(template.holes).toHaveLength(1)
        expect(template.holes[0]).toMatchObject({
          kind: "component",
          path: [1],
        })
      })

      it("should handle component with props stored on elementNode", () => {
        const component = createElement(
          "Card",
          [
            { name: "title", value: makeLiteral("Hello") },
            { name: "class", value: makeReactiveContent() },
          ],
          [],
          [],
          [],
          makeSpan(),
          "Card",
        )
        const node = makeBuilder("div", [component])
        const template = extractTemplate(node)

        const hole = template.holes.find(h => h.kind === "component")
        expect(hole).toBeDefined()
        expect(hole?.elementNode?.attributes).toHaveLength(2)
        expect(hole?.elementNode?.tag).toBe("Card")
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
        propName: "onClick",
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
        propName: "onClick",
        handlerSource: "() => {}",
        span: makeSpan(),
      }
      const node = makeBuilder("div", [reactive1, reactive2], [], [handler])
      const template = extractTemplate(node)

      const counts = countHolesByKind(template)

      expect(counts.get("text")).toBe(2)
      expect(counts.get("event")).toBe(1)
    })

    // =============================================================================
    // Walk Planning Tests
    // =============================================================================

    describe("planWalk", () => {
      it("should return empty array for no holes", () => {
        const ops = planWalk([])
        expect(ops).toEqual([])
      })

      it("should handle single hole at root level", () => {
        const holes = [{ path: [0], kind: "text" as const }]
        const ops = planWalk(holes)

        expect(ops).toEqual([{ op: "down" }, { op: "grab", holeIndex: 0 }])
      })

      it("should handle single hole nested two levels", () => {
        const holes = [{ path: [0, 0], kind: "text" as const }]
        const ops = planWalk(holes)

        expect(ops).toEqual([
          { op: "down" },
          { op: "down" },
          { op: "grab", holeIndex: 0 },
        ])
      })

      it("should handle sibling holes", () => {
        const holes = [
          { path: [0], kind: "text" as const },
          { path: [1], kind: "text" as const },
        ]
        const ops = planWalk(holes)

        expect(ops).toEqual([
          { op: "down" },
          { op: "grab", holeIndex: 0 },
          { op: "right" },
          { op: "grab", holeIndex: 1 },
        ])
      })

      it("should handle nested then sibling", () => {
        // Template: <div><span><!--hole 0--></span><p><!--hole 1--></p></div>
        // Paths: [0, 0] and [1, 0]
        const holes = [
          { path: [0, 0], kind: "text" as const },
          { path: [1, 0], kind: "text" as const },
        ]
        const ops = planWalk(holes)

        // From root: down to [0], down to [0,0], grab
        // Then: up to [0], right to [1], down to [1,0], grab
        expect(ops).toContainEqual({ op: "grab", holeIndex: 0 })
        expect(ops).toContainEqual({ op: "grab", holeIndex: 1 })
        expect(ops.filter(op => op.op === "grab")).toHaveLength(2)
      })

      it("should preserve original hole indices when sorting", () => {
        // Holes provided out of document order
        const holes = [
          { path: [1], kind: "text" as const },
          { path: [0], kind: "text" as const },
        ]
        const ops = planWalk(holes)

        // Should grab index 1 (path [0]) first, then index 0 (path [1])
        const grabs = ops.filter(
          (op): op is { op: "grab"; holeIndex: number } => op.op === "grab",
        )
        expect(grabs[0].holeIndex).toBe(1) // original index of [0]
        expect(grabs[1].holeIndex).toBe(0) // original index of [1]
      })

      it("should handle complex nested structure", () => {
        // Template: <div><h1><!--hole 0--></h1><ul><li><!--hole 1--></li></ul></div>
        // Paths: [0, 0] (inside h1) and [1, 0, 0] (inside li inside ul)
        const holes = [
          { path: [0, 0], kind: "text" as const },
          { path: [1, 0, 0], kind: "text" as const },
        ]
        const ops = planWalk(holes)

        expect(ops.filter(op => op.op === "grab")).toHaveLength(2)
      })

      it("should handle root-level attribute hole", () => {
        // Attribute on root element - path is []
        const holes = [
          { path: [], kind: "attribute" as const, attributeName: "class" },
        ]
        const ops = planWalk(holes)

        // Root element - just grab, no navigation needed
        expect(ops).toEqual([{ op: "grab", holeIndex: 0 }])
      })
    })

    // =============================================================================
    // Code Generation Tests
    // =============================================================================

    describe("generateWalkCode", () => {
      it("should return empty array for no holes", () => {
        const code = generateWalkCode([], 0, "_root", "  ")
        expect(code).toEqual([])
      })

      it("should generate code for simple walk", () => {
        const ops: NavOp[] = [{ op: "down" }, { op: "grab", holeIndex: 0 }]
        const code = generateWalkCode(ops, 1, "_root", "")

        expect(code).toContain("const _holes = new Array(1)")
        expect(code).toContain("let _n = _root")
        expect(code).toContain("_n = _n.firstChild")
        expect(code).toContain("_holes[0] = _n")
      })

      it("should generate all navigation operations", () => {
        const ops: NavOp[] = [
          { op: "down" },
          { op: "right" },
          { op: "up" },
          { op: "grab", holeIndex: 0 },
        ]
        const code = generateWalkCode(ops, 1, "_el", "  ")

        expect(code.some(line => line.includes("_n.firstChild"))).toBe(true)
        expect(code.some(line => line.includes("_n.nextSibling"))).toBe(true)
        expect(code.some(line => line.includes("_n.parentNode"))).toBe(true)
        expect(code.some(line => line.includes("_holes[0] = _n"))).toBe(true)
      })

      it("should apply indentation", () => {
        const ops: NavOp[] = [{ op: "grab", holeIndex: 0 }]
        const code = generateWalkCode(ops, 1, "_root", "    ")

        expect(code.every(line => line.startsWith("    "))).toBe(true)
      })
    })

    describe("generateTemplateDeclaration", () => {
      it("should generate template creation code", () => {
        const code = generateTemplateDeclaration("<div>Hello</div>", "_tmpl_0")

        expect(code).toContain(
          'const _tmpl_0 = document.createElement("template")',
        )
        expect(code).toContain('_tmpl_0.innerHTML = "<div>Hello</div>"')
      })

      it("should escape quotes in HTML", () => {
        const code = generateTemplateDeclaration(
          '<div class="test">Hi</div>',
          "_tmpl_1",
        )

        // Should use JSON.stringify which escapes quotes
        expect(code).toContain('\\"test\\"')
      })
    })

    describe("simpleHash", () => {
      it("should return consistent hash for same input", () => {
        const hash1 = simpleHash("<div>Hello</div>")
        const hash2 = simpleHash("<div>Hello</div>")
        expect(hash1).toBe(hash2)
      })

      it("should return different hashes for different inputs", () => {
        const hash1 = simpleHash("<div>Hello</div>")
        const hash2 = simpleHash("<div>World</div>")
        expect(hash1).not.toBe(hash2)
      })

      it("should return string", () => {
        const hash = simpleHash("<div></div>")
        expect(typeof hash).toBe("string")
      })
    })
  })
})
