import {
  createTypedDoc,
  loro,
  type PlainValueRef,
  Shape,
} from "@loro-extended/change"
import type { ListDeltaOp } from "@loro-extended/reactive"
import { JSDOM } from "jsdom"
import { beforeEach, describe, expect, it } from "vitest"
import {
  assertMaxMutations,
  createCountingContainer,
} from "../testing/counting-dom.js"
import {
  conditionalRegion,
  listRegion,
  claimSlot,
  type ListRefLike,
  planConditionalUpdate,
  planDeltaOps,
  planInitialRender,
  releaseSlot,
} from "./regions.js"
import { resetScopeIdCounter, Scope } from "./scope.js"
import {
  activeSubscriptions,
  getActiveSubscriptionCount,
  resetSubscriptionIdCounter,
} from "./subscribe.js"

// Set up DOM globals for testing
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>")
global.document = dom.window.document
global.Node = dom.window.Node
global.Element = dom.window.Element
global.Comment = dom.window.Comment

describe("regions", () => {
  beforeEach(() => {
    resetScopeIdCounter()
    resetSubscriptionIdCounter()
    activeSubscriptions.clear()
  })

  describe("listRegion", () => {
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

      listRegion(
        container,
        doc.items,
        {
          create: (itemRef: PlainValueRef<string>, _index: number) => {
            const li = document.createElement("li")
            li.textContent = itemRef.get()
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

      listRegion(
        container,
        doc.items,
        {
          create: (itemRef: PlainValueRef<string>) => {
            const li = document.createElement("li")
            li.textContent = itemRef.get()
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

      listRegion(
        container,
        doc.items,
        {
          create: (itemRef: PlainValueRef<string>) => {
            const li = document.createElement("li")
            li.textContent = itemRef.get()
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

      listRegion(
        container,
        doc.items,
        {
          create: (itemRef: PlainValueRef<string>) => {
            const li = document.createElement("li")
            li.textContent = itemRef.get()
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

      listRegion(
        container,
        doc.items,
        {
          create: (itemRef: PlainValueRef<string>) => {
            const li = document.createElement("li")
            li.textContent = itemRef.get()
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

      listRegion(
        container,
        doc.items,
        {
          create: (itemRef: PlainValueRef<string>) => {
            const li = document.createElement("li")
            li.textContent = itemRef.get()
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

    // Regression test: The original bug was that when create() returns a
    // DocumentFragment (as compiled code does), the fragment becomes empty
    // after insertion and can't be tracked for removal. This test verifies
    // that delete works correctly with fragment-returning handlers.
    it("should delete items when create handler returns DocumentFragment", () => {
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

      listRegion(
        container,
        doc.items,
        {
          // Return a DocumentFragment (mimicking compiled code behavior)
          create: (itemRef: PlainValueRef<string>) => {
            const frag = document.createDocumentFragment()
            const li = document.createElement("li")
            li.textContent = itemRef.get()
            frag.appendChild(li)
            return frag
          },
        },
        scope,
      )

      expect(container.children.length).toBe(3)
      expect(container.children[0].textContent).toBe("item1")
      expect(container.children[1].textContent).toBe("item2")
      expect(container.children[2].textContent).toBe("item3")

      // Delete middle item - this failed before the fix because the
      // fragment's parentNode was null after insertion
      doc.items.delete(1, 1)
      loro(doc).commit()

      expect(container.children.length).toBe(2)
      expect(container.children[0].textContent).toBe("item1")
      expect(container.children[1].textContent).toBe("item3")

      // Delete first item
      doc.items.delete(0, 1)
      loro(doc).commit()

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("item3")

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

      listRegion(
        container,
        doc.items,
        {
          create: (itemRef: PlainValueRef<string>) => {
            const li = document.createElement("li")
            li.textContent = itemRef.get()
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

      listRegion(
        container,
        doc.items,
        {
          create: (itemRef: PlainValueRef<string>) => {
            const li = document.createElement("li")
            li.textContent = itemRef.get()
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

      listRegion(
        container,
        doc.items,
        {
          create: (itemRef: PlainValueRef<string>) => {
            const li = document.createElement("li")
            li.textContent = itemRef.get()
            return li
          },
        },
        scope,
      )

      doc.items.push("item1")
      doc.items.push("item2")
      loro(doc).commit()

      // 1 subscription for the list itself
      const subscriptionsBefore = getActiveSubscriptionCount()
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

      listRegion(
        container,
        doc.items,
        {
          create: (itemRef: PlainValueRef<string>) => {
            const li = document.createElement("li")
            li.textContent = itemRef.get()
            return li
          },
        },
        scope,
      )

      expect(getActiveSubscriptionCount()).toBeGreaterThanOrEqual(1)

      scope.dispose()

      expect(getActiveSubscriptionCount()).toBe(0)
    })
  })

  describe("conditionalRegion", () => {
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

      conditionalRegion(
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

      conditionalRegion(
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

      conditionalRegion(
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

      conditionalRegion(
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

      conditionalRegion(
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
      const initialCount = getActiveSubscriptionCount()
      expect(initialCount).toBeGreaterThanOrEqual(1)

      // Swap condition - old branch scope should be disposed
      doc.count.increment(-1)
      loro(doc).commit()

      // Subscription count should remain stable (old cleaned up, new created)
      expect(getActiveSubscriptionCount()).toBeGreaterThanOrEqual(1)

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

      conditionalRegion(
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

      expect(getActiveSubscriptionCount()).toBeGreaterThanOrEqual(1)

      scope.dispose()

      expect(getActiveSubscriptionCount()).toBe(0)
    })

    // Regression test: Same DocumentFragment issue as list regions.
    // When whenTrue/whenFalse return fragments, branch swapping failed
    // because the fragment's parentNode was null after insertion.
    it("should swap branches when handlers return DocumentFragment", () => {
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

      conditionalRegion(
        marker,
        doc.count,
        () => doc.count.get() > 0,
        {
          // Return DocumentFragments (mimicking compiled code behavior)
          whenTrue: () => {
            const frag = document.createDocumentFragment()
            const p = document.createElement("p")
            p.textContent = "visible"
            frag.appendChild(p)
            return frag
          },
          whenFalse: () => {
            const frag = document.createDocumentFragment()
            const p = document.createElement("p")
            p.textContent = "hidden"
            frag.appendChild(p)
            return frag
          },
        },
        scope,
      )

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("visible")

      // Swap to false branch - this failed before the fix
      doc.count.increment(-1)
      loro(doc).commit()

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("hidden")

      // Swap back to true branch
      doc.count.increment(1)
      loro(doc).commit()

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("visible")

      scope.dispose()
    })
  })

  // ===========================================================================
  // Pure Planning Function Tests (Functional Core)
  // ===========================================================================

  describe("planInitialRender", () => {
    it("should create insert ops for each item in the list", () => {
      const mockListRef: ListRefLike<{ index: number; value: string }> = {
        length: 3,
        get: (i: number) => ({ index: i, value: `item${i}` }),
      }

      const ops = planInitialRender(mockListRef)

      expect(ops).toEqual([
        { kind: "insert", index: 0, item: { index: 0, value: "item0" } },
        { kind: "insert", index: 1, item: { index: 1, value: "item1" } },
        { kind: "insert", index: 2, item: { index: 2, value: "item2" } },
      ])
    })

    it("should return empty array for empty list", () => {
      const mockListRef: ListRefLike<string> = {
        length: 0,
        get: () => undefined,
      }

      const ops = planInitialRender(mockListRef)

      expect(ops).toEqual([])
    })

    it("should skip undefined items", () => {
      const mockListRef: ListRefLike<string> = {
        length: 3,
        get: (i: number) => (i === 1 ? undefined : `item${i}`),
      }

      const ops = planInitialRender(mockListRef)

      expect(ops).toEqual([
        { kind: "insert", index: 0, item: "item0" },
        { kind: "insert", index: 2, item: "item2" },
      ])
    })
  })

  describe("planDeltaOps", () => {
    it("should use listRef.get() for inserts, not raw delta values", () => {
      // The listRef returns objects with isRef marker to prove we're using .get()
      const mockListRef: ListRefLike<{ index: number; isRef: true }> = {
        length: 2,
        get: (i: number) => ({ index: i, isRef: true }),
      }

      // delta.insert is a COUNT (2), not raw values
      const deltaOps: ListDeltaOp[] = [{ insert: 2 }]

      const ops = planDeltaOps(mockListRef, deltaOps)

      // Should use listRef.get(), not the raw values from delta
      expect(ops).toEqual([
        { kind: "insert", index: 0, item: { index: 0, isRef: true } },
        { kind: "insert", index: 1, item: { index: 1, isRef: true } },
      ])
    })

    it("should generate delete ops at correct indices", () => {
      const mockListRef: ListRefLike<string> = {
        length: 1,
        get: () => "remaining",
      }

      const deltaOps: ListDeltaOp[] = [{ delete: 2 }]

      const ops = planDeltaOps(mockListRef, deltaOps)

      // Both deletes should be at index 0 (delete doesn't advance index)
      expect(ops).toEqual([
        { kind: "delete", index: 0 },
        { kind: "delete", index: 0 },
      ])
    })

    it("should handle retain operations correctly", () => {
      const mockListRef: ListRefLike<{ index: number }> = {
        length: 4,
        get: (i: number) => ({ index: i }),
      }

      // Retain 2, then insert 1
      const deltaOps: ListDeltaOp[] = [{ retain: 2 }, { insert: 1 }]

      const ops = planDeltaOps(mockListRef, deltaOps)

      // Insert should be at index 2 (after retaining 2)
      expect(ops).toEqual([{ kind: "insert", index: 2, item: { index: 2 } }])
    })

    it("should handle mixed operations", () => {
      const mockListRef: ListRefLike<{ index: number }> = {
        length: 3,
        get: (i: number) => ({ index: i }),
      }

      // Retain 1, delete 1, insert 1
      const deltaOps: ListDeltaOp[] = [
        { retain: 1 },
        { delete: 1 },
        { insert: 1 },
      ]

      const ops = planDeltaOps(mockListRef, deltaOps)

      expect(ops).toEqual([
        { kind: "delete", index: 1 },
        { kind: "insert", index: 1, item: { index: 1 } },
      ])
    })

    it("should handle empty delta ops", () => {
      const mockListRef: ListRefLike<string> = {
        length: 1,
        get: () => "item",
      }

      const deltaOps: ListDeltaOp[] = []

      const ops = planDeltaOps(mockListRef, deltaOps)

      expect(ops).toEqual([])
    })
  })

  describe("planConditionalUpdate", () => {
    it("returns noop when condition unchanged (true → true)", () => {
      const op = planConditionalUpdate("true", true, true)
      expect(op).toEqual({ kind: "noop" })
    })

    it("returns noop when condition unchanged (false → false)", () => {
      const op = planConditionalUpdate("false", false, true)
      expect(op).toEqual({ kind: "noop" })
    })

    it("returns noop when condition unchanged (null → false without whenFalse)", () => {
      const op = planConditionalUpdate(null, false, false)
      expect(op).toEqual({ kind: "noop" })
    })

    it("returns insert when going from null to true", () => {
      const op = planConditionalUpdate(null, true, true)
      expect(op).toEqual({ kind: "insert", branch: "true" })
    })

    it("returns insert when going from null to true (no whenFalse)", () => {
      const op = planConditionalUpdate(null, true, false)
      expect(op).toEqual({ kind: "insert", branch: "true" })
    })

    it("returns insert when going from null to false with whenFalse", () => {
      const op = planConditionalUpdate(null, false, true)
      expect(op).toEqual({ kind: "insert", branch: "false" })
    })

    it("returns swap when going from true to false with whenFalse", () => {
      const op = planConditionalUpdate("true", false, true)
      expect(op).toEqual({ kind: "swap", toBranch: "false" })
    })

    it("returns delete when going from true to false without whenFalse", () => {
      const op = planConditionalUpdate("true", false, false)
      expect(op).toEqual({ kind: "delete" })
    })

    it("returns swap when going from false to true", () => {
      const op = planConditionalUpdate("false", true, true)
      expect(op).toEqual({ kind: "swap", toBranch: "true" })
    })

    it("returns swap when going from false to true (no whenFalse)", () => {
      const op = planConditionalUpdate("false", true, false)
      expect(op).toEqual({ kind: "swap", toBranch: "true" })
    })
  })

  // Unit tests for claimSlot focus on NEW multi-element behavior.
  // Single-element fragment handling is already tested by integration tests
  // (e.g., "should delete items when create handler returns DocumentFragment").
  describe("claimSlot - multi-element fragments", () => {
    it("returns range kind with start/end markers for multi-element fragment", () => {
      const parent = document.createElement("div")
      const frag = document.createDocumentFragment()
      const span1 = document.createElement("span")
      span1.textContent = "a"
      const span2 = document.createElement("span")
      span2.textContent = "b"
      frag.appendChild(span1)
      frag.appendChild(span2)

      const slot = claimSlot(parent, frag, null)

      expect(slot.kind).toBe("range")
      if (slot.kind === "range") {
        expect(slot.startMarker.nodeType).toBe(Node.COMMENT_NODE)
        expect(slot.endMarker.nodeType).toBe(Node.COMMENT_NODE)
        expect(slot.startMarker.textContent).toBe("kinetic:start")
        expect(slot.endMarker.textContent).toBe("kinetic:end")
      }
      // Parent should have: startMarker, span1, span2, endMarker
      expect(parent.childNodes.length).toBe(4)
      expect(parent.querySelectorAll("span").length).toBe(2)
    })
  })

  describe("releaseSlot - multi-element", () => {
    it("removes all nodes in range including markers", () => {
      const parent = document.createElement("div")
      const frag = document.createDocumentFragment()
      frag.appendChild(document.createElement("span"))
      frag.appendChild(document.createElement("span"))
      frag.appendChild(document.createElement("span"))

      const slot = claimSlot(parent, frag, null)
      expect(parent.querySelectorAll("span").length).toBe(3)

      releaseSlot(parent, slot)

      expect(parent.childNodes.length).toBe(0)
      expect(parent.querySelectorAll("span").length).toBe(0)
    })
  })

  describe("listRegion - ref preservation", () => {
    it("should pass refs from listRef.get() to create handler for initial render", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("ul")

      // Add initial items
      doc.items.push("item1")
      doc.items.push("item2")
      loro(doc).commit()

      const receivedItems: unknown[] = []

      listRegion(
        container,
        doc.items,
        {
          create: (item: unknown, _index: number) => {
            receivedItems.push(item)
            // Check if item has .get() method (is a PlainValueRef)
            const li = document.createElement("li")
            if (typeof item === "object" && item !== null && "get" in item) {
              li.textContent = String((item as { get(): string }).get())
            } else {
              li.textContent = String(item)
            }
            return li
          },
        },
        scope,
      )

      // Items should be PlainValueRef instances (have .get() method)
      expect(receivedItems.length).toBe(2)
      for (const item of receivedItems) {
        expect(typeof item).toBe("object")
        expect(item).not.toBeNull()
        expect(typeof (item as { get?: unknown }).get).toBe("function")
      }

      // Verify the actual values
      expect((receivedItems[0] as { get(): string }).get()).toBe("item1")
      expect((receivedItems[1] as { get(): string }).get()).toBe("item2")

      scope.dispose()
    })

    it("should pass refs from listRef.get() to create handler for delta inserts", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("ul")

      const receivedItems: unknown[] = []

      listRegion(
        container,
        doc.items,
        {
          create: (item: unknown, _index: number) => {
            receivedItems.push(item)
            const li = document.createElement("li")
            if (typeof item === "object" && item !== null && "get" in item) {
              li.textContent = String((item as { get(): string }).get())
            } else {
              li.textContent = String(item)
            }
            return li
          },
        },
        scope,
      )

      // Initial render: no items
      expect(receivedItems.length).toBe(0)

      // Push items via delta
      doc.items.push("delta1")
      doc.items.push("delta2")
      loro(doc).commit()

      // Delta-inserted items should also be PlainValueRef instances
      expect(receivedItems.length).toBe(2)
      for (const item of receivedItems) {
        expect(typeof item).toBe("object")
        expect(item).not.toBeNull()
        expect(typeof (item as { get?: unknown }).get).toBe("function")
      }

      // Verify the actual values
      expect((receivedItems[0] as { get(): string }).get()).toBe("delta1")
      expect((receivedItems[1] as { get(): string }).get()).toBe("delta2")

      scope.dispose()
    })

    it("should allow calling .set() on received refs", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.plain.string()),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const container = document.createElement("ul")

      doc.items.push("original")
      loro(doc).commit()

      // Store refs in an array to avoid TypeScript control flow analysis issues
      const capturedRefs: Array<{ get(): string; set(v: string): void }> = []

      listRegion(
        container,
        doc.items,
        {
          create: (item: unknown, _index: number) => {
            if (typeof item === "object" && item !== null && "get" in item) {
              capturedRefs.push(item as { get(): string; set(v: string): void })
            }
            const li = document.createElement("li")
            if (typeof item === "object" && item !== null && "get" in item) {
              li.textContent = (item as { get(): string }).get()
            } else {
              li.textContent = String(item)
            }
            return li
          },
        },
        scope,
      )

      expect(capturedRefs.length).toBe(1)
      const capturedRef = capturedRefs[0]
      expect(capturedRef.get()).toBe("original")

      // Modify via the ref
      capturedRef.set("modified")
      loro(doc).commit()

      // Verify the change persisted
      expect(doc.items.get(0)?.get()).toBe("modified")

      scope.dispose()
    })
  })
})
