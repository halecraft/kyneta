import { JSDOM } from "jsdom"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { InvalidMountTargetError } from "../errors.js"
import { mount, rootScope } from "./mount.js"
import { resetScopeIdCounter, setRootScope } from "./scope.js"
import { activeSubscriptions, resetSubscriptionIdCounter } from "./subscribe.js"

// Set up DOM globals for testing
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>")
global.document = dom.window.document
global.Node = dom.window.Node
global.Element = dom.window.Element

describe("mount", () => {
  beforeEach(() => {
    resetScopeIdCounter()
    resetSubscriptionIdCounter()
    activeSubscriptions.clear()
    setRootScope(null)
    document.body.innerHTML = ""
  })

  afterEach(() => {
    setRootScope(null)
    document.body.innerHTML = ""
  })

  describe("basic mounting", () => {
    it("should mount an element to a container", () => {
      const container = document.createElement("div")
      document.body.appendChild(container)

      const element = () => {
        const div = document.createElement("div")
        div.textContent = "Hello, World!"
        return div
      }

      const result = mount(element, container)

      expect(result.node).toBeDefined()
      expect(result.node.textContent).toBe("Hello, World!")
      expect(container.children.length).toBe(1)
      expect(container.firstChild).toBe(result.node)

      result.dispose()
    })

    it("should clear existing content before mounting", () => {
      const container = document.createElement("div")
      container.innerHTML = "<p>Old content</p><span>More old</span>"
      document.body.appendChild(container)

      const element = () => {
        const div = document.createElement("div")
        div.textContent = "New content"
        return div
      }

      const result = mount(element, container)

      expect(container.children.length).toBe(1)
      expect(container.textContent).toBe("New content")

      result.dispose()
    })

    it("should return a dispose function", () => {
      const container = document.createElement("div")
      document.body.appendChild(container)

      const element = () => document.createElement("div")

      const result = mount(element, container)

      expect(typeof result.dispose).toBe("function")

      result.dispose()
    })

    it("should set the root scope", () => {
      const container = document.createElement("div")
      document.body.appendChild(container)

      expect(rootScope).toBe(null)

      const element = () => document.createElement("div")
      const result = mount(element, container)

      expect(rootScope).not.toBe(null)
      expect(typeof rootScope?.id).toBe("number")

      result.dispose()
    })
  })

  describe("dispose", () => {
    it("should remove node from container", () => {
      const container = document.createElement("div")
      document.body.appendChild(container)

      const element = () => {
        const div = document.createElement("div")
        div.textContent = "Content"
        return div
      }

      const result = mount(element, container)

      expect(container.children.length).toBe(1)

      result.dispose()

      expect(container.children.length).toBe(0)
    })

    it("should clear the root scope", () => {
      const container = document.createElement("div")
      document.body.appendChild(container)

      const element = () => document.createElement("div")
      const result = mount(element, container)

      expect(rootScope).not.toBe(null)

      result.dispose()

      expect(rootScope).toBe(null)
    })

    it("should be idempotent (safe to call multiple times)", () => {
      const container = document.createElement("div")
      document.body.appendChild(container)

      const element = () => document.createElement("div")
      const result = mount(element, container)

      result.dispose()
      result.dispose()
      result.dispose()

      expect(container.children.length).toBe(0)
      expect(rootScope).toBe(null)
    })
  })

  describe("error handling", () => {
    it("should throw InvalidMountTargetError for null container", () => {
      const element = () => document.createElement("div")

      expect(() => mount(element, null as unknown as Element)).toThrow(
        InvalidMountTargetError,
      )
    })

    it("should throw InvalidMountTargetError for undefined container", () => {
      const element = () => document.createElement("div")

      expect(() => mount(element, undefined as unknown as Element)).toThrow(
        InvalidMountTargetError,
      )
    })

    it("should throw InvalidMountTargetError for non-Element", () => {
      const element = () => document.createElement("div")
      const textNode = document.createTextNode("text")

      expect(() => mount(element, textNode as unknown as Element)).toThrow(
        InvalidMountTargetError,
      )
    })

    it("should include helpful message in error", () => {
      const element = () => document.createElement("div")

      try {
        mount(element, null as unknown as Element)
      } catch (e) {
        expect((e as Error).message).toContain("valid DOM Element")
      }
    })
  })

  describe("hydration mode", () => {
    it("should adopt existing DOM content in hydrate mode", () => {
      const container = document.createElement("div")
      const existingNode = document.createElement("p")
      existingNode.textContent = "Existing content"
      container.appendChild(existingNode)
      document.body.appendChild(container)

      const element = () => {
        // This would normally create new content
        const p = document.createElement("p")
        p.textContent = "New content"
        return p
      }

      const result = mount(element, container, { hydrate: true })

      // Should adopt existing node, not create new one
      expect(result.node).toBe(existingNode)
      expect(container.children.length).toBe(1)
      expect(container.firstChild?.textContent).toBe("Existing content")

      result.dispose()
    })

    it("should throw if hydrating empty container", () => {
      const container = document.createElement("div")
      document.body.appendChild(container)

      const element = () => document.createElement("div")

      expect(() => mount(element, container, { hydrate: true })).toThrow(
        InvalidMountTargetError,
      )
    })
  })

  describe("complex elements", () => {
    it("should mount nested elements", () => {
      const container = document.createElement("div")
      document.body.appendChild(container)

      const element = () => {
        const div = document.createElement("div")
        const h1 = document.createElement("h1")
        h1.textContent = "Title"
        const p = document.createElement("p")
        p.textContent = "Content"
        div.appendChild(h1)
        div.appendChild(p)
        return div
      }

      const result = mount(element, container)

      expect(container.children.length).toBe(1)
      const root = container.children[0]
      expect(root.children.length).toBe(2)
      expect(root.children[0].textContent).toBe("Title")
      expect(root.children[1].textContent).toBe("Content")

      result.dispose()
    })

    it("should mount text nodes", () => {
      const container = document.createElement("div")
      document.body.appendChild(container)

      const element = () => {
        return document.createTextNode("Just text")
      }

      const result = mount(element, container)

      expect(container.textContent).toBe("Just text")

      result.dispose()
    })
  })
})
