import { JSDOM } from "jsdom"
import { describe, expect, it } from "vitest"
import {
  assertMaxMutations,
  assertOperationCount,
  createCountingContainer,
  createCounts,
  getTotalMutations,
} from "./counting-dom.js"

// Set up DOM globals for testing
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>")
global.document = dom.window.document
global.Node = dom.window.Node
global.Element = dom.window.Element

describe("counting-dom", () => {
  describe("createCountingContainer", () => {
    it("should create a real DOM element with custom tag", () => {
      const { container: div } = createCountingContainer()
      const { container: ul } = createCountingContainer("ul")

      expect(div).toBeInstanceOf(Element)
      expect(div.tagName.toLowerCase()).toBe("div")
      expect(ul.tagName.toLowerCase()).toBe("ul")
    })

    it("should count all mutation operations", () => {
      const { container, counts } = createCountingContainer()

      // appendChild
      const child1 = document.createElement("div")
      container.appendChild(child1)

      // insertBefore
      const child2 = document.createElement("div")
      container.insertBefore(child2, child1)

      // replaceChild
      const child3 = document.createElement("div")
      container.replaceChild(child3, child1)

      // removeChild
      container.removeChild(child2)

      expect(counts.appendChild).toBe(1)
      expect(counts.insertBefore).toBe(1)
      expect(counts.replaceChild).toBe(1)
      expect(counts.removeChild).toBe(1)
    })

    it("should count attribute operations", () => {
      const { container, counts } = createCountingContainer()

      container.setAttribute("class", "test")
      container.setAttribute("id", "myid")
      container.removeAttribute("class")

      expect(counts.setAttribute).toBe(2)
      expect(counts.removeAttribute).toBe(1)
    })

    it("should actually perform the DOM operations", () => {
      const { container } = createCountingContainer()

      const child = document.createElement("li")
      child.textContent = "item"
      container.appendChild(child)

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("item")

      container.removeChild(child)
      expect(container.children.length).toBe(0)
    })

    it("should reset counts", () => {
      const { container, counts, reset } = createCountingContainer()

      container.appendChild(document.createElement("li"))
      container.appendChild(document.createElement("li"))
      expect(counts.appendChild).toBe(2)

      reset()

      expect(counts.appendChild).toBe(0)
      expect(counts.insertBefore).toBe(0)
      expect(counts.removeChild).toBe(0)
    })
  })

  describe("assertion helpers", () => {
    it("assertOperationCount should pass/fail correctly", () => {
      const counts = createCounts()
      counts.appendChild = 5

      expect(() => assertOperationCount(counts, "appendChild", 5)).not.toThrow()
      expect(() => assertOperationCount(counts, "appendChild", 3)).toThrow(
        /Expected appendChild to be called 3 times, but was called 5 times/,
      )
    })

    it("assertMaxMutations should pass/fail correctly", () => {
      const counts = createCounts()
      counts.appendChild = 2
      counts.insertBefore = 1

      expect(() => assertMaxMutations(counts, 5)).not.toThrow()
      expect(() => assertMaxMutations(counts, 3)).not.toThrow()
      expect(() => assertMaxMutations(counts, 2)).toThrow(
        /Expected at most 2 DOM mutations, but got 3/,
      )
    })

    it("getTotalMutations should sum tree mutations only", () => {
      const counts = createCounts()
      counts.appendChild = 5
      counts.insertBefore = 3
      counts.removeChild = 2
      counts.replaceChild = 1
      counts.setAttribute = 10 // Should not be counted

      expect(getTotalMutations(counts)).toBe(11)
    })
  })

  describe("O(k) verification scenarios", () => {
    it("should verify O(1) insert into large list", () => {
      const { container, counts, reset } = createCountingContainer("ul")

      // Build a list of 1000 items
      for (let i = 0; i < 1000; i++) {
        const li = document.createElement("li")
        li.textContent = `Item ${i}`
        container.appendChild(li)
      }

      expect(container.children.length).toBe(1000)
      reset()

      // Insert one item in the middle
      const newItem = document.createElement("li")
      newItem.textContent = "New middle item"
      container.insertBefore(newItem, container.children[500])

      // Should be O(1) - exactly 1 DOM operation
      expect(counts.insertBefore).toBe(1)
      expect(getTotalMutations(counts)).toBe(1)
      assertMaxMutations(counts, 1)

      expect(container.children.length).toBe(1001)
    })

    it("should verify O(1) delete from large list", () => {
      const { container, counts, reset } = createCountingContainer("ul")

      // Build a list of 1000 items
      for (let i = 0; i < 1000; i++) {
        container.appendChild(document.createElement("li"))
      }

      reset()

      // Delete one item from the middle
      container.removeChild(container.children[500])

      // Should be O(1)
      expect(counts.removeChild).toBe(1)
      expect(getTotalMutations(counts)).toBe(1)
      expect(container.children.length).toBe(999)
    })

    it("should verify O(k) for k insertions", () => {
      const { container, counts, reset } = createCountingContainer("ul")

      // Build initial list
      for (let i = 0; i < 1000; i++) {
        container.appendChild(document.createElement("li"))
      }

      reset()

      // Insert 5 items
      for (let i = 0; i < 5; i++) {
        container.insertBefore(
          document.createElement("li"),
          container.children[0],
        )
      }

      // Should be O(k) where k=5
      expect(counts.insertBefore).toBe(5)
      expect(getTotalMutations(counts)).toBe(5)
      assertMaxMutations(counts, 5)
    })
  })
})
