/**
 * Tests for the generator-based IR walker.
 */

import type { ChildNode } from "./ir.js"
import { describe, expect, it } from "vitest"
import {
  collectEvents,
  countEventTypes,
  eventsWithPaths,
  walkIR,
  type WalkEvent,
} from "./walk.js"
import {
  createBuilder,
  createConditional,
  createConditionalBranch,
  createElement,
  createLiteral,
  createLoop,
  createSpan,
  type BuilderNode,
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
// Basic Walker Tests
// =============================================================================

describe("walkIR", () => {
  describe("basic element walking", () => {
    it("should yield elementStart and elementEnd for empty element", () => {
      const node = makeBuilder("div")
      const events = collectEvents(node)

      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({
        type: "elementStart",
        tag: "div",
        path: [],
      })
      expect(events[1]).toEqual({
        type: "elementEnd",
        tag: "div",
        isVoid: false,
      })
    })

    it("should handle void elements correctly", () => {
      const node = makeBuilder("br")
      const events = collectEvents(node)

      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({
        type: "elementStart",
        tag: "br",
        path: [],
      })
      expect(events[1]).toEqual({
        type: "elementEnd",
        tag: "br",
        isVoid: true,
      })
    })

    it("should walk nested elements with correct paths", () => {
      const inner = makeElement("span", [makeLiteral("Hello")])
      const outer = makeBuilder("div", [inner])
      const events = collectEvents(outer)

      // Find element start events
      const elementStarts = events.filter(
        (e): e is Extract<WalkEvent, { type: "elementStart" }> =>
          e.type === "elementStart",
      )

      expect(elementStarts).toHaveLength(2)
      expect(elementStarts[0]).toEqual({
        type: "elementStart",
        tag: "div",
        path: [],
      })
      expect(elementStarts[1]).toEqual({
        type: "elementStart",
        tag: "span",
        path: [0],
      })
    })

    it("should handle multiple children with correct paths", () => {
      const child1 = makeElement("h1", [makeLiteral("Title")])
      const child2 = makeElement("p", [makeLiteral("Content")])
      const node = makeBuilder("div", [child1, child2])
      const events = collectEvents(node)

      const elementStarts = events.filter(
        (e): e is Extract<WalkEvent, { type: "elementStart" }> =>
          e.type === "elementStart",
      )

      expect(elementStarts).toHaveLength(3)
      expect(elementStarts[0].path).toEqual([])
      expect(elementStarts[1].path).toEqual([0])
      expect(elementStarts[2].path).toEqual([1])
    })

    it("should handle deeply nested elements", () => {
      const deepest = makeElement("span", [makeLiteral("Deep")])
      const middle = makeElement("p", [deepest])
      const outer = makeElement("div", [middle])
      const root = makeBuilder("section", [outer])
      const events = collectEvents(root)

      const elementStarts = events.filter(
        (e): e is Extract<WalkEvent, { type: "elementStart" }> =>
          e.type === "elementStart",
      )

      expect(elementStarts.map(e => ({ tag: e.tag, path: e.path }))).toEqual([
        { tag: "section", path: [] },
        { tag: "div", path: [0] },
        { tag: "p", path: [0, 0] },
        { tag: "span", path: [0, 0, 0] },
      ])
    })
  })

  describe("attribute walking", () => {
    it("should yield staticAttribute for literal attributes", () => {
      const node = makeBuilder(
        "div",
        [],
        [{ name: "class", value: makeLiteral("container") }],
      )
      const events = collectEvents(node)

      const attrEvents = events.filter(e => e.type === "staticAttribute")
      expect(attrEvents).toHaveLength(1)
      expect(attrEvents[0]).toEqual({
        type: "staticAttribute",
        name: "class",
        value: "container",
      })
    })

    it("should escape HTML in static attribute values", () => {
      const node = makeBuilder(
        "div",
        [],
        [
          {
            name: "data-text",
            value: makeLiteral('<script>alert("xss")</script>'),
          },
        ],
      )
      const events = collectEvents(node)

      const attrEvents = events.filter(
        (e): e is Extract<WalkEvent, { type: "staticAttribute" }> =>
          e.type === "staticAttribute",
      )
      expect(attrEvents[0].value).toBe(
        "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
      )
    })

    it("should yield dynamicAttribute for reactive attributes", () => {
      const reactiveAttr = {
        name: "class",
        value: makeReactiveContent(),
      }
      const node = makeBuilder("div", [], [reactiveAttr])
      const events = collectEvents(node)

      const attrEvents = events.filter(e => e.type === "dynamicAttribute")
      expect(attrEvents).toHaveLength(1)
      expect(attrEvents[0]).toMatchObject({
        type: "dynamicAttribute",
        attr: reactiveAttr,
        path: [],
      })
    })
  })

  describe("event handler walking", () => {
    it("should yield eventHandler events", () => {
      const handler = {
        event: "click",
        propName: "onClick",
        handlerSource: "() => console.log('clicked')",
        span: makeSpan(),
      }
      const node = makeBuilder("button", [], [], [handler])
      const events = collectEvents(node)

      const handlerEvents = events.filter(e => e.type === "eventHandler")
      expect(handlerEvents).toHaveLength(1)
      expect(handlerEvents[0]).toMatchObject({
        type: "eventHandler",
        handler,
        path: [],
      })
    })
  })

  describe("content walking", () => {
    it("should yield staticText for literal content", () => {
      const node = makeBuilder("p", [makeLiteral("Hello, world!")])
      const events = collectEvents(node)

      const textEvents = events.filter(e => e.type === "staticText")
      expect(textEvents).toHaveLength(1)
      expect(textEvents[0]).toEqual({
        type: "staticText",
        text: "Hello, world!",
      })
    })

    it("should escape HTML in static text", () => {
      const node = makeBuilder("p", [makeLiteral("<b>Bold</b>")])
      const events = collectEvents(node)

      const textEvents = events.filter(
        (e): e is Extract<WalkEvent, { type: "staticText" }> =>
          e.type === "staticText",
      )
      expect(textEvents[0].text).toBe("&lt;b&gt;Bold&lt;/b&gt;")
    })

    it("should yield dynamicContent for reactive content", () => {
      const reactive = makeReactiveContent()
      const node = makeBuilder("p", [reactive])
      const events = collectEvents(node)

      const contentEvents = events.filter(e => e.type === "dynamicContent")
      expect(contentEvents).toHaveLength(1)
      expect(contentEvents[0]).toMatchObject({
        type: "dynamicContent",
        node: reactive,
        path: [0],
      })
    })
  })

  describe("binding walking", () => {
    it("should yield binding events for element bindings", () => {
      const element = makeElement(
        "input",
        [],
        [],
        [],
        [
          {
            attribute: "value",
            refSource: "doc.title",
            bindingType: "value",
            span: makeSpan(),
          },
        ],
      )
      const node = makeBuilder("div", [element])
      const events = collectEvents(node)

      const bindingEvents = events.filter(e => e.type === "binding")
      expect(bindingEvents).toHaveLength(1)
      expect(bindingEvents[0]).toMatchObject({
        type: "binding",
        attribute: "value",
        refSource: "doc.title",
        bindingType: "value",
        path: [0],
      })
    })
  })

  describe("region walking", () => {
    it("should yield regionPlaceholder for reactive loops", () => {
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
      const events = collectEvents(node)

      const regionEvents = events.filter(e => e.type === "regionPlaceholder")
      expect(regionEvents).toHaveLength(1)
      expect(regionEvents[0]).toMatchObject({
        type: "regionPlaceholder",
        node: loop,
        path: [0],
      })
    })

    it("should yield regionPlaceholder for render-time loops", () => {
      const loop = createLoop(
        "[1, 2, 3]",
        "render",
        "x",
        null,
        [makeLiteral("x")],
        [],
        makeSpan(),
      )
      const node = makeBuilder("ul", [loop])
      const events = collectEvents(node)

      const regionEvents = events.filter(e => e.type === "regionPlaceholder")
      expect(regionEvents).toHaveLength(1)
    })

    it("should yield regionPlaceholder for reactive conditionals", () => {
      const reactiveDep = { source: "doc.title", deltaKind: "text" as const }
      const conditional = createConditional(
        [
          createConditionalBranch(
            makeReactiveContent(),
            [makeLiteral("Yes")],
            makeSpan(),
          ),
        ],
        reactiveDep,
        makeSpan(),
      )
      const node = makeBuilder("div", [conditional])
      const events = collectEvents(node)

      const regionEvents = events.filter(e => e.type === "regionPlaceholder")
      expect(regionEvents).toHaveLength(1)
      expect(regionEvents[0]).toMatchObject({
        type: "regionPlaceholder",
        node: conditional,
        path: [0],
      })
    })

    it("should yield regionPlaceholder for render-time conditionals", () => {
      const conditional = createConditional(
        [
          createConditionalBranch(
            makeLiteral("true"),
            [makeLiteral("Yes")],
            makeSpan(),
          ),
        ],
        null,
        makeSpan(),
      )
      const node = makeBuilder("div", [conditional])
      const events = collectEvents(node)

      const regionEvents = events.filter(e => e.type === "regionPlaceholder")
      expect(regionEvents).toHaveLength(1)
    })
  })

  describe("statement handling", () => {
    it("should not yield events for statements", () => {
      const statement = {
        kind: "statement" as const,
        source: "console.log('debug')",
        span: makeSpan(),
      }
      const node = makeBuilder("div", [statement, makeLiteral("text")])
      const events = collectEvents(node)

      // Should have div start/end and text, but no statement event
      expect(events.some(e => e.type === "staticText")).toBe(true)
      // Statement nodes are silently skipped
      expect(
        events.every(e => (e as any).source !== "console.log('debug')"),
      ).toBe(true)
    })
  })
})

// =============================================================================
// Utility Function Tests
// =============================================================================

describe("utility functions", () => {
  describe("collectEvents", () => {
    it("should collect all events into an array", () => {
      const node = makeBuilder("div", [makeLiteral("Hello")])
      const events = collectEvents(node)

      expect(Array.isArray(events)).toBe(true)
      expect(events.length).toBeGreaterThan(0)
    })
  })

  describe("countEventTypes", () => {
    it("should count events by type", () => {
      const node = makeBuilder("div", [
        makeElement("span", [makeLiteral("A")]),
        makeElement("span", [makeLiteral("B")]),
      ])
      const events = collectEvents(node)
      const counts = countEventTypes(events)

      expect(counts.get("elementStart")).toBe(3)
      expect(counts.get("elementEnd")).toBe(3)
      expect(counts.get("staticText")).toBe(2)
    })
  })

  describe("eventsWithPaths", () => {
    it("should filter to only events with paths", () => {
      const node = makeBuilder(
        "div",
        [makeLiteral("text")],
        [{ name: "id", value: makeLiteral("main") }],
      )
      const events = collectEvents(node)
      const withPaths = eventsWithPaths(events)

      // elementStart, dynamicContent have paths
      // staticAttribute, staticText, elementEnd don't have paths (or path is empty array)
      expect(withPaths.every(e => "path" in e)).toBe(true)
    })
  })
})

// =============================================================================
// Edge Cases
// =============================================================================

describe("edge cases", () => {
  it("should handle empty children array", () => {
    const node = makeBuilder("div", [])
    const events = collectEvents(node)

    expect(events).toHaveLength(2)
    expect(events[0].type).toBe("elementStart")
    expect(events[1].type).toBe("elementEnd")
  })

  it("should handle mixed static and dynamic content", () => {
    const node = makeBuilder("p", [
      makeLiteral("Hello, "),
      makeReactiveContent(),
      makeLiteral("!"),
    ])
    const events = collectEvents(node)

    const contentEvents = events.filter(
      e => e.type === "staticText" || e.type === "dynamicContent",
    )
    expect(contentEvents).toHaveLength(3)
    expect(contentEvents[0].type).toBe("staticText")
    expect(contentEvents[1].type).toBe("dynamicContent")
    expect(contentEvents[2].type).toBe("staticText")
  })

  it("should correctly escape ampersands in text", () => {
    const node = makeBuilder("p", [makeLiteral("A & B")])
    const events = collectEvents(node)

    const textEvent = events.find(
      (e): e is Extract<WalkEvent, { type: "staticText" }> =>
        e.type === "staticText",
    )
    expect(textEvent?.text).toBe("A &amp; B")
  })

  it("should handle multiple void elements as siblings", () => {
    const node = makeBuilder("div", [
      makeElement("br"),
      makeElement("hr"),
      makeElement("img"),
    ])
    const events = collectEvents(node)

    const endEvents = events.filter(
      (e): e is Extract<WalkEvent, { type: "elementEnd" }> =>
        e.type === "elementEnd",
    )
    // div (non-void) + br, hr, img (void)
    expect(endEvents.filter(e => e.isVoid)).toHaveLength(3)
    expect(endEvents.filter(e => !e.isVoid)).toHaveLength(1)
  })

  it("should handle ElementNode as root", () => {
    const node = makeElement("div", [makeLiteral("Direct element")])
    const events = collectEvents(node)

    expect(events[0]).toMatchObject({
      type: "elementStart",
      tag: "div",
      path: [],
    })
  })
})

// =============================================================================
// Event Order Tests
// =============================================================================

describe("event ordering", () => {
  it("should emit events in document order", () => {
    const node = makeBuilder("div", [
      makeElement("h1", [makeLiteral("Title")]),
      makeElement("p", [makeLiteral("Para 1")]),
      makeElement("p", [makeLiteral("Para 2")]),
    ])
    const events = collectEvents(node)

    // Extract event types in order
    const eventTypes = events.map(e => e.type)

    // Should be: div-start, h1-start, text, h1-end, p-start, text, p-end, p-start, text, p-end, div-end
    expect(eventTypes).toEqual([
      "elementStart", // div
      "elementStart", // h1
      "staticText", // Title
      "elementEnd", // h1
      "elementStart", // p
      "staticText", // Para 1
      "elementEnd", // p
      "elementStart", // p
      "staticText", // Para 2
      "elementEnd", // p
      "elementEnd", // div
    ])
  })

  it("should emit attributes before children", () => {
    const node = makeBuilder(
      "div",
      [makeLiteral("Content")],
      [{ name: "class", value: makeLiteral("box") }],
    )
    const events = collectEvents(node)

    const attrIndex = events.findIndex(e => e.type === "staticAttribute")
    const contentIndex = events.findIndex(e => e.type === "staticText")

    expect(attrIndex).toBeLessThan(contentIndex)
  })
})
