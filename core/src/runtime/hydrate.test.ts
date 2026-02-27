/**
 * Hydration Module Tests
 *
 * Tests for hydrating SSR-rendered DOM with Kinetic subscriptions.
 */

import { JSDOM } from "jsdom"
import { beforeEach, describe, expect, it } from "vitest"

import { HydrationMismatchError } from "../errors.js"
import {
  adoptNode,
  adoptTextNode,
  createHydratableMount,
  elementMatches,
  findMarkers,
  hydrate,
  matchRegions,
  nextElementNode,
  parseMarker,
} from "./hydrate.js"
import { __resetScopeIdCounter, Scope } from "./scope.js"

// Set up DOM globals
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>")
global.document = dom.window.document
global.Node = dom.window.Node
global.NodeFilter = dom.window.NodeFilter
global.Element = dom.window.Element
global.Comment = dom.window.Comment
global.Text = dom.window.Text

// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
  __resetScopeIdCounter()
})

// =============================================================================
// Marker Parsing Tests
// =============================================================================

describe("parseMarker", () => {
  it("should parse opening list marker", () => {
    const comment = document.createComment("kinetic:list:1")
    const marker = parseMarker(comment)

    expect(marker).not.toBeNull()
    expect(marker?.type).toBe("list")
    expect(marker?.id).toBe("1")
    expect(marker?.isClosing).toBe(false)
  })

  it("should parse opening if marker", () => {
    const comment = document.createComment("kinetic:if:42")
    const marker = parseMarker(comment)

    expect(marker).not.toBeNull()
    expect(marker?.type).toBe("if")
    expect(marker?.id).toBe("42")
    expect(marker?.isClosing).toBe(false)
  })

  it("should parse closing list marker", () => {
    const comment = document.createComment("/kinetic:list")
    const marker = parseMarker(comment)

    expect(marker).not.toBeNull()
    expect(marker?.type).toBe("list")
    expect(marker?.isClosing).toBe(true)
  })

  it("should parse closing if marker", () => {
    const comment = document.createComment("/kinetic:if")
    const marker = parseMarker(comment)

    expect(marker).not.toBeNull()
    expect(marker?.type).toBe("if")
    expect(marker?.isClosing).toBe(true)
  })

  it("should return null for non-marker comments", () => {
    const comment = document.createComment("This is a regular comment")
    const marker = parseMarker(comment)

    expect(marker).toBeNull()
  })

  it("should return null for empty comments", () => {
    const comment = document.createComment("")
    const marker = parseMarker(comment)

    expect(marker).toBeNull()
  })
})

describe("findMarkers", () => {
  it("should find all markers in a container", () => {
    const container = document.createElement("div")
    container.innerHTML = `
      <!--kinetic:list:1-->
      <li>Item 1</li>
      <li>Item 2</li>
      <!--/kinetic:list-->
    `

    const markers = findMarkers(container)

    expect(markers.length).toBe(2)
    expect(markers[0].type).toBe("list")
    expect(markers[0].isClosing).toBe(false)
    expect(markers[1].type).toBe("list")
    expect(markers[1].isClosing).toBe(true)
  })

  it("should find nested markers", () => {
    const container = document.createElement("div")
    container.innerHTML = `
      <!--kinetic:if:1-->
      <div>
        <!--kinetic:list:2-->
        <span>Item</span>
        <!--/kinetic:list-->
      </div>
      <!--/kinetic:if-->
    `

    const markers = findMarkers(container)

    expect(markers.length).toBe(4)
    expect(markers[0].type).toBe("if")
    expect(markers[1].type).toBe("list")
    expect(markers[2].type).toBe("list")
    expect(markers[3].type).toBe("if")
  })

  it("should return empty array when no markers exist", () => {
    const container = document.createElement("div")
    container.innerHTML = "<p>No markers here</p>"

    const markers = findMarkers(container)

    expect(markers.length).toBe(0)
  })
})

describe("matchRegions", () => {
  it("should match opening and closing markers", () => {
    const container = document.createElement("div")
    container.innerHTML = `
      <!--kinetic:list:1-->
      <li>Item</li>
      <!--/kinetic:list-->
    `

    const markers = findMarkers(container)
    const regions = matchRegions(markers)

    expect(regions.length).toBe(1)
    expect(regions[0].type).toBe("list")
    expect(regions[0].id).toBe("1")
  })

  it("should capture children between markers", () => {
    const container = document.createElement("div")
    container.innerHTML = `<!--kinetic:list:1--><li>A</li><li>B</li><!--/kinetic:list-->`

    const markers = findMarkers(container)
    const regions = matchRegions(markers)

    expect(regions.length).toBe(1)
    // Children should include the li elements (and possibly text nodes)
    const elementChildren = regions[0].children.filter(
      n => n.nodeType === Node.ELEMENT_NODE,
    )
    expect(elementChildren.length).toBe(2)
  })
})

// =============================================================================
// DOM Walking Tests
// =============================================================================

describe("nextElementNode", () => {
  it("should return the node if it's an element", () => {
    const div = document.createElement("div")
    const result = nextElementNode(div)

    expect(result).toBe(div)
  })

  it("should skip whitespace text nodes", () => {
    const container = document.createElement("div")
    container.innerHTML = "   \n   <span>Content</span>"

    const firstChild = container.firstChild // whitespace text node
    const result = nextElementNode(firstChild)

    expect(result?.tagName).toBe("SPAN")
  })

  it("should return null for non-empty text nodes", () => {
    const text = document.createTextNode("Hello")
    const result = nextElementNode(text)

    expect(result).toBeNull()
  })

  it("should return null when no element found", () => {
    const result = nextElementNode(null)

    expect(result).toBeNull()
  })
})

describe("elementMatches", () => {
  it("should match element by tag name", () => {
    const div = document.createElement("div")
    expect(elementMatches(div, "div")).toBe(true)
    expect(elementMatches(div, "span")).toBe(false)
  })

  it("should be case-insensitive for tag names", () => {
    const div = document.createElement("div")
    expect(elementMatches(div, "DIV")).toBe(true)
    expect(elementMatches(div, "Div")).toBe(true)
  })

  it("should match attributes when provided", () => {
    const input = document.createElement("input")
    input.setAttribute("type", "text")
    input.setAttribute("class", "my-input")

    expect(elementMatches(input, "input", { type: "text" })).toBe(true)
    expect(elementMatches(input, "input", { type: "checkbox" })).toBe(false)
    expect(
      elementMatches(input, "input", { type: "text", class: "my-input" }),
    ).toBe(true)
  })
})

// =============================================================================
// Node Adoption Tests
// =============================================================================

describe("adoptNode", () => {
  it("should return element when tag matches", () => {
    const div = document.createElement("div")
    const result = adoptNode(div, "div")

    expect(result).toBe(div)
  })

  it("should throw on tag mismatch", () => {
    const div = document.createElement("div")

    expect(() => adoptNode(div, "span")).toThrow(HydrationMismatchError)
  })

  it("should throw when node is not an element", () => {
    const text = document.createTextNode("Hello")

    expect(() => adoptNode(text, "div")).toThrow(HydrationMismatchError)
  })

  it("should be case-insensitive", () => {
    const div = document.createElement("div")

    expect(adoptNode(div, "DIV")).toBe(div)
    expect(adoptNode(div, "Div")).toBe(div)
  })
})

describe("adoptTextNode", () => {
  it("should return text node", () => {
    const text = document.createTextNode("Hello")
    const result = adoptTextNode(text)

    expect(result).toBe(text)
  })

  it("should throw when node is not a text node", () => {
    const div = document.createElement("div")

    expect(() => adoptTextNode(div)).toThrow(HydrationMismatchError)
  })

  it("should update text content when expectedText differs", () => {
    const text = document.createTextNode("Old")
    const result = adoptTextNode(text, "New")

    expect(result.textContent).toBe("New")
  })
})

// =============================================================================
// Main Hydration Tests
// =============================================================================

describe("hydrate", () => {
  it("should hydrate a simple element", () => {
    const container = document.createElement("div")
    container.innerHTML = "<p>Hello</p>"

    const scope = new Scope("test")
    let hydratedNode: Node | null = null

    const result = hydrate(
      container,
      (node, _scope) => {
        hydratedNode = node
      },
      scope,
    )

    expect(result.success).toBe(true)
    expect(result.mismatches.length).toBe(0)
    expect(hydratedNode).toBe(container.firstElementChild)
  })

  it("should return failure when container is empty", () => {
    const container = document.createElement("div")
    const scope = new Scope("test")

    const result = hydrate(container, () => {}, scope)

    expect(result.success).toBe(false)
    expect(result.mismatches.length).toBeGreaterThan(0)
  })

  it("should provide dispose function", () => {
    const container = document.createElement("div")
    container.innerHTML = "<p>Content</p>"

    const scope = new Scope("test")
    const result = hydrate(container, () => {}, scope)

    expect(typeof result.dispose).toBe("function")

    result.dispose()
    expect(scope.disposed).toBe(true)
  })

  it("should call onMismatch callback when mismatch occurs", () => {
    const container = document.createElement("div")
    const scope = new Scope("test")

    const mismatches: HydrationMismatchError[] = []
    const _result = hydrate(container, () => {}, scope, {
      strict: false,
      onMismatch: error => mismatches.push(error),
    })

    expect(mismatches.length).toBeGreaterThan(0)
  })

  it("should throw in strict mode on mismatch", () => {
    const container = document.createElement("div")
    const scope = new Scope("test")

    expect(() => hydrate(container, () => {}, scope, { strict: true })).toThrow(
      HydrationMismatchError,
    )
  })
})

// =============================================================================
// Hydratable Mount Tests
// =============================================================================

describe("createHydratableMount", () => {
  it("should hydrate when container has content", () => {
    const container = document.createElement("div")
    container.innerHTML = "<p>SSR Content</p>"

    const scope = new Scope("test")
    let wasHydrated = false
    let wasFreshRender = false

    const mount = createHydratableMount(
      (_container, _scope) => {
        wasFreshRender = true
        return document.createElement("p")
      },
      (container, scope) => {
        wasHydrated = true
        return hydrate(container, () => {}, scope)
      },
    )

    mount(container, scope)

    expect(wasHydrated).toBe(true)
    expect(wasFreshRender).toBe(false)
  })

  it("should fresh render when container is empty", () => {
    const container = document.createElement("div")
    const scope = new Scope("test")
    let wasHydrated = false
    let wasFreshRender = false

    const mount = createHydratableMount(
      (_container, _scope) => {
        wasFreshRender = true
        const p = document.createElement("p")
        p.textContent = "Fresh"
        return p
      },
      (container, scope) => {
        wasHydrated = true
        return hydrate(container, () => {}, scope)
      },
    )

    const result = mount(container, scope)

    expect(wasFreshRender).toBe(true)
    expect(wasHydrated).toBe(false)
    expect(container.firstElementChild?.textContent).toBe("Fresh")
    expect(result.node).toBe(container.firstElementChild)
  })

  it("should return dispose function", () => {
    const container = document.createElement("div")
    container.innerHTML = "<p>Content</p>"
    const scope = new Scope("test")

    const mount = createHydratableMount(
      () => document.createElement("p"),
      (container, scope) => hydrate(container, () => {}, scope),
    )

    const result = mount(container, scope)

    expect(typeof result.dispose).toBe("function")
  })

  it("should remove node on dispose for fresh render", () => {
    const container = document.createElement("div")
    const scope = new Scope("test")

    const mount = createHydratableMount(
      () => {
        const p = document.createElement("p")
        p.textContent = "Fresh"
        return p
      },
      (container, scope) => hydrate(container, () => {}, scope),
    )

    const result = mount(container, scope)
    expect(container.children.length).toBe(1)

    result.dispose()
    expect(container.children.length).toBe(0)
    expect(scope.disposed).toBe(true)
  })
})
