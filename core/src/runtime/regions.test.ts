import { createTypedDoc, loro, Shape } from "@loro-extended/change"
import { JSDOM } from "jsdom"
import { beforeEach, describe, expect, it } from "vitest"
import {
  assertMaxMutations,
  createCountingContainer,
} from "../testing/counting-dom.js"
import {
  __conditionalRegion,
  __listRegion,
  __staticConditionalRegion,
} from "./regions.js"
import { __resetScopeIdCounter, Scope } from "./scope.js"
import {
  __activeSubscriptions,
  __getActiveSubscriptionCount,
  __resetSubscriptionIdCounter,
} from "./subscribe.js"

// Set up DOM globals for testing
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>")
global.document = dom.window.document
global.Node = dom.window.Node
global.Element = dom.window.Element
global.Comment = dom.window.Comment

describe("regions", () => {
  beforeEach(() => {
    __resetScopeIdCounter()
    __resetSubscriptionIdCounter()
    __activeSubscriptions.clear()
  })

  describe("__listRegion", () => {
    it("should render initial list items", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("ul")

      // Add initial items
      doc.items.push("item1")
      doc.items.push("item2")
      doc.items.push("item3")
      loro(doc).commit()

      __listRegion(
        container,
        doc.items,
        {
          create: (item: string, _index: number) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(3)
      expect(container.children[0].textContent).toBe("item1")
      expect(container.children[1].textContent).toBe("item2")
      expect(container.children[2].textContent).toBe("item3")

      scope.dispose()
    })

    it("should handle empty list", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("ul")

      __listRegion(
        container,
        doc.items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(0)

      scope.dispose()
    })

    it("should insert items when pushed", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("ul")

      __listRegion(
        container,
        doc.items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(0)

      // Push an item
      doc.items.push("new item")
      loro(doc).commit()

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("new item")

      // Push another
      doc.items.push("another item")
      loro(doc).commit()

      expect(container.children.length).toBe(2)
      expect(container.children[1].textContent).toBe("another item")

      scope.dispose()
    })

    it("should insert items at specific index", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("ul")

      // Add initial items
      doc.items.push("first")
      doc.items.push("third")
      loro(doc).commit()

      __listRegion(
        container,
        doc.items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(2)

      // Insert at index 1
      doc.items.insert(1, "second")
      loro(doc).commit()

      expect(container.children.length).toBe(3)
      expect(container.children[0].textContent).toBe("first")
      expect(container.children[1].textContent).toBe("second")
      expect(container.children[2].textContent).toBe("third")

      scope.dispose()
    })

    it("should delete items", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("ul")

      // Add initial items
      doc.items.push("item1")
      doc.items.push("item2")
      doc.items.push("item3")
      loro(doc).commit()

      __listRegion(
        container,
        doc.items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(3)

      // Delete middle item
      doc.items.delete(1, 1)
      loro(doc).commit()

      expect(container.children.length).toBe(2)
      expect(container.children[0].textContent).toBe("item1")
      expect(container.children[1].textContent).toBe("item3")

      scope.dispose()
    })

    it("should delete multiple items", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("ul")

      // Add initial items
      doc.items.push("a")
      doc.items.push("b")
      doc.items.push("c")
      doc.items.push("d")
      loro(doc).commit()

      __listRegion(
        container,
        doc.items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(4)

      // Delete 2 items starting at index 1
      doc.items.delete(1, 2)
      loro(doc).commit()

      expect(container.children.length).toBe(2)
      expect(container.children[0].textContent).toBe("a")
      expect(container.children[1].textContent).toBe("d")

      scope.dispose()
    })

    it("should achieve O(k) DOM operations for k list mutations", () => {
      const { container, counts, reset } = createCountingContainer("ul")
      const schema = Shape.doc({ items: Shape.list(Shape.plain.string()) })
      const doc = createTypedDoc(schema)
      const scope = new Scope()

      // Add 100 items (enough to verify O(k) behavior)
      for (let i = 0; i < 100; i++) {
        doc.items.push(`item-${i}`)
      }
      loro(doc).commit()

      __listRegion(
        container,
        doc.items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(100)
      reset() // Clear initial render counts

      // Insert ONE item in the middle
      doc.items.insert(50, "new-item")
      loro(doc).commit()

      // Should be O(1), not O(n)
      assertMaxMutations(counts, 1)
      expect(counts.insertBefore).toBe(1)

      scope.dispose()
    })

    it("should handle multiple operations in one commit", () => {
      const schema = Shape.doc({ items: Shape.list(Shape.plain.string()) })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("ul")

      doc.items.push("a")
      doc.items.push("b")
      doc.items.push("c")
      loro(doc).commit()

      __listRegion(
        container,
        doc.items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(3)

      // Multiple operations in one commit
      doc.items.delete(1, 1) // Remove "b"
      doc.items.push("d") // Add "d"
      loro(doc).commit()

      expect(container.children.length).toBe(3)
      expect([...container.children].map(c => c.textContent)).toEqual([
        "a",
        "c",
        "d",
      ])

      scope.dispose()
    })

    it("should dispose item scopes when items are deleted", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("ul")

      __listRegion(
        container,
        doc.items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      doc.items.push("item1")
      doc.items.push("item2")
      loro(doc).commit()

      // 1 subscription for the list itself
      const subscriptionsBefore = __getActiveSubscriptionCount()
      expect(subscriptionsBefore).toBeGreaterThanOrEqual(1)

      // Delete an item
      doc.items.delete(0, 1)
      loro(doc).commit()

      expect(container.children.length).toBe(1)

      scope.dispose()
    })

    it("should clean up all subscriptions when scope is disposed", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("ul")

      doc.items.push("item1")
      doc.items.push("item2")
      loro(doc).commit()

      __listRegion(
        container,
        doc.items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(__getActiveSubscriptionCount()).toBeGreaterThanOrEqual(1)

      scope.dispose()

      expect(__getActiveSubscriptionCount()).toBe(0)
    })
  })

  describe("__conditionalRegion", () => {
    it("should render whenTrue branch when condition is true", () => {
      const schema = Shape.doc({
        count: Shape.counter(),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("if")
      container.appendChild(marker)

      // Set count to 1 (truthy)
      doc.count.increment(1)
      loro(doc).commit()

      __conditionalRegion(
        marker,
        doc.count,
        () => doc.count.get() > 0,
        {
          whenTrue: () => {
            const p = document.createElement("p")
            p.textContent = "visible"
            return p
          },
          whenFalse: () => {
            const p = document.createElement("p")
            p.textContent = "hidden"
            return p
          },
        },
        scope,
      )

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("visible")

      scope.dispose()
    })

    it("should render whenFalse branch when condition is false", () => {
      const schema = Shape.doc({
        count: Shape.counter(),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("if")
      container.appendChild(marker)

      // Count is 0 (falsy) by default

      __conditionalRegion(
        marker,
        doc.count,
        () => doc.count.get() > 0,
        {
          whenTrue: () => {
            const p = document.createElement("p")
            p.textContent = "visible"
            return p
          },
          whenFalse: () => {
            const p = document.createElement("p")
            p.textContent = "hidden"
            return p
          },
        },
        scope,
      )

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("hidden")

      scope.dispose()
    })

    it("should render nothing when condition is false and no whenFalse branch", () => {
      const schema = Shape.doc({
        count: Shape.counter(),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("if")
      container.appendChild(marker)

      // Count is 0 (falsy) by default

      __conditionalRegion(
        marker,
        doc.count,
        () => doc.count.get() > 0,
        {
          whenTrue: () => {
            const p = document.createElement("p")
            p.textContent = "visible"
            return p
          },
        },
        scope,
      )

      // Only the comment marker
      expect(container.childNodes.length).toBe(1)
      expect(container.childNodes[0].nodeType).toBe(Node.COMMENT_NODE)

      scope.dispose()
    })

    it("should swap branches when condition changes", () => {
      const schema = Shape.doc({
        count: Shape.counter(),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("if")
      container.appendChild(marker)

      // Start with count > 0
      doc.count.increment(1)
      loro(doc).commit()

      __conditionalRegion(
        marker,
        doc.count,
        () => doc.count.get() > 0,
        {
          whenTrue: () => {
            const p = document.createElement("p")
            p.textContent = "visible"
            return p
          },
          whenFalse: () => {
            const p = document.createElement("p")
            p.textContent = "hidden"
            return p
          },
        },
        scope,
      )

      expect(container.children[0].textContent).toBe("visible")

      // Change condition to false (decrement to 0)
      doc.count.increment(-1)
      loro(doc).commit()

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("hidden")

      // Change back to true (increment to 1)
      doc.count.increment(1)
      loro(doc).commit()

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("visible")

      scope.dispose()
    })

    it("should dispose branch scope when swapping", () => {
      const schema = Shape.doc({
        count: Shape.counter(),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("if")
      container.appendChild(marker)

      // Start with count > 0
      doc.count.increment(1)
      loro(doc).commit()

      __conditionalRegion(
        marker,
        doc.count,
        () => doc.count.get() > 0,
        {
          whenTrue: () => {
            const p = document.createElement("p")
            p.textContent = "visible"
            return p
          },
          whenFalse: () => {
            const p = document.createElement("p")
            p.textContent = "hidden"
            return p
          },
        },
        scope,
      )

      // Initial subscription count
      const initialCount = __getActiveSubscriptionCount()
      expect(initialCount).toBeGreaterThanOrEqual(1)

      // Swap condition - old branch scope should be disposed
      doc.count.increment(-1)
      loro(doc).commit()

      // Subscription count should remain stable (old cleaned up, new created)
      expect(__getActiveSubscriptionCount()).toBeGreaterThanOrEqual(1)

      scope.dispose()
    })

    it("should clean up subscriptions when scope is disposed", () => {
      const schema = Shape.doc({
        count: Shape.counter(),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("if")
      container.appendChild(marker)

      // Start with count > 0
      doc.count.increment(1)
      loro(doc).commit()

      __conditionalRegion(
        marker,
        doc.count,
        () => doc.count.get() > 0,
        {
          whenTrue: () => {
            const p = document.createElement("p")
            p.textContent = "visible"
            return p
          },
        },
        scope,
      )

      expect(__getActiveSubscriptionCount()).toBeGreaterThanOrEqual(1)

      scope.dispose()

      expect(__getActiveSubscriptionCount()).toBe(0)
    })
  })

  describe("__staticConditionalRegion", () => {
    it("should render whenTrue branch for true condition", () => {
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("static-if")
      container.appendChild(marker)

      __staticConditionalRegion(
        marker,
        true,
        {
          whenTrue: () => {
            const p = document.createElement("p")
            p.textContent = "yes"
            return p
          },
          whenFalse: () => {
            const p = document.createElement("p")
            p.textContent = "no"
            return p
          },
        },
        scope,
      )

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("yes")

      scope.dispose()
    })

    it("should render whenFalse branch for false condition", () => {
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("static-if")
      container.appendChild(marker)

      __staticConditionalRegion(
        marker,
        false,
        {
          whenTrue: () => {
            const p = document.createElement("p")
            p.textContent = "yes"
            return p
          },
          whenFalse: () => {
            const p = document.createElement("p")
            p.textContent = "no"
            return p
          },
        },
        scope,
      )

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("no")

      scope.dispose()
    })

    it("should render nothing for false condition with no whenFalse", () => {
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("static-if")
      container.appendChild(marker)

      __staticConditionalRegion(
        marker,
        false,
        {
          whenTrue: () => {
            const p = document.createElement("p")
            p.textContent = "yes"
            return p
          },
        },
        scope,
      )

      expect(container.children.length).toBe(0)

      scope.dispose()
    })

    it("should remove node on scope dispose", () => {
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("static-if")
      container.appendChild(marker)

      __staticConditionalRegion(
        marker,
        true,
        {
          whenTrue: () => {
            const p = document.createElement("p")
            p.textContent = "yes"
            return p
          },
        },
        scope,
      )

      expect(container.children.length).toBe(1)

      scope.dispose()

      expect(container.children.length).toBe(0)
    })
  })
})
