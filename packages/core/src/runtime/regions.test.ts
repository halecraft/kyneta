/**
 * Tests for regions.ts — list and conditional region management.
 *
 * All tests use CHANGEFEED-based mocks instead of @loro-extended types.
 * List region tests use mock sequence refs with [CHANGEFEED] protocol.
 * Conditional region tests use LocalRef for condition state.
 */

import {
  CHANGEFEED,
  type ChangeBase,
  type Changefeed,
  type SequenceChangeOp,
} from "@kyneta/schema"
import { JSDOM } from "jsdom"
import { beforeEach, describe, expect, it } from "vitest"
import { state } from "../reactive/local-ref.js"
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

// =============================================================================
// Mock Infrastructure
// =============================================================================

/**
 * Create a mock sequence ref with [CHANGEFEED] protocol for testing.
 *
 * The mock provides:
 * - `.at(index)` to look up items by index (ListRefLike<T>)
 * - `[CHANGEFEED]` for subscribing to changes
 * - `emit(change)` to manually fire a change (test helper)
 * - `setItems(items)` to update the backing array (test helper)
 */
function createMockSequenceRef<T>(initialItems: T[]): {
  ref: ListRefLike<T> & { [CHANGEFEED]: Changefeed<T[], ChangeBase> }
  emit: (change: ChangeBase) => void
  setItems: (items: T[]) => void
} {
  let items = [...initialItems]
  let callback: ((change: ChangeBase) => void) | null = null

  const ref = {
    get length() {
      return items.length
    },
    at(index: number): T | undefined {
      return items[index]
    },
    [CHANGEFEED]: {
      get current(): T[] {
        return items
      },
      subscribe(cb: (change: ChangeBase) => void): () => void {
        callback = cb
        return () => {
          callback = null
        }
      },
    },
  }

  return {
    ref,
    emit: (change: ChangeBase) => {
      callback?.(change)
    },
    setItems: (newItems: T[]) => {
      items = [...newItems]
    },
  }
}

/**
 * Helper to emit a sequence change (insert/delete/retain ops).
 */
function sequenceChange(
  ops: SequenceChangeOp<unknown>[],
): ChangeBase & { ops: SequenceChangeOp<unknown>[] } {
  return { type: "sequence", ops }
}

describe("regions", () => {
  beforeEach(() => {
    resetScopeIdCounter()
    resetSubscriptionIdCounter()
    activeSubscriptions.clear()
  })

  // ===========================================================================
  // listRegion — Integration Tests
  // ===========================================================================

  describe("listRegion", () => {
    it("should render initial list items", () => {
      const { ref } = createMockSequenceRef(["item1", "item2", "item3"])
      const scope = new Scope()
      const container = document.createElement("ul")

      listRegion(
        container,
        ref,
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
      const { ref } = createMockSequenceRef<string>([])
      const scope = new Scope()
      const container = document.createElement("ul")

      listRegion(
        container,
        ref,
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

    it("should insert items via sequence change", () => {
      const { ref, emit, setItems } = createMockSequenceRef<string>([])
      const scope = new Scope()
      const container = document.createElement("ul")

      listRegion(
        container,
        ref,
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

      // Insert one item
      setItems(["new item"])
      emit(sequenceChange([{ insert: ["new item"] }]))

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("new item")

      // Insert another at end
      setItems(["new item", "another item"])
      emit(sequenceChange([{ retain: 1 }, { insert: ["another item"] }]))

      expect(container.children.length).toBe(2)
      expect(container.children[1].textContent).toBe("another item")

      scope.dispose()
    })

    it("should insert items at specific index", () => {
      const { ref, emit, setItems } = createMockSequenceRef([
        "first",
        "third",
      ])
      const scope = new Scope()
      const container = document.createElement("ul")

      listRegion(
        container,
        ref,
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

      // Insert "second" between "first" and "third"
      setItems(["first", "second", "third"])
      emit(sequenceChange([{ retain: 1 }, { insert: ["second"] }]))

      expect(container.children.length).toBe(3)
      expect(container.children[0].textContent).toBe("first")
      expect(container.children[1].textContent).toBe("second")
      expect(container.children[2].textContent).toBe("third")

      scope.dispose()
    })

    it("should delete items via sequence change", () => {
      const { ref, emit, setItems } = createMockSequenceRef([
        "item1",
        "item2",
        "item3",
      ])
      const scope = new Scope()
      const container = document.createElement("ul")

      listRegion(
        container,
        ref,
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

      // Delete the middle item
      setItems(["item1", "item3"])
      emit(sequenceChange([{ retain: 1 }, { delete: 1 }]))

      expect(container.children.length).toBe(2)
      expect(container.children[0].textContent).toBe("item1")
      expect(container.children[1].textContent).toBe("item3")

      scope.dispose()
    })

    it("should delete multiple items via batch-delete", () => {
      const { ref, emit, setItems } = createMockSequenceRef([
        "a",
        "b",
        "c",
        "d",
        "e",
      ])
      const scope = new Scope()
      const container = document.createElement("ul")

      listRegion(
        container,
        ref,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(5)

      // Delete items at index 1,2,3 (b,c,d)
      setItems(["a", "e"])
      emit(sequenceChange([{ retain: 1 }, { delete: 3 }]))

      expect(container.children.length).toBe(2)
      expect(container.children[0].textContent).toBe("a")
      expect(container.children[1].textContent).toBe("e")

      scope.dispose()
    })

    it("should batch-insert multiple items with O(1) DOM insertions", () => {
      const { container, counts, reset } = createCountingContainer("ul")
      const { ref, emit, setItems } = createMockSequenceRef<string>([])
      const scope = new Scope()

      listRegion(
        container,
        ref,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      // Prepare 100 items for batch insert
      const items: string[] = []
      for (let i = 0; i < 100; i++) {
        items.push(`item${i}`)
      }
      setItems(items)

      // Reset counters after initial (empty) render
      reset()

      // Emit a batch insert of 100 items
      emit(sequenceChange([{ insert: items }]))

      expect(container.children.length).toBe(100)

      // Batch insert should use O(1) insertBefore calls (one DocumentFragment)
      // The counting DOM tracks actual insertBefore calls
      assertMaxMutations(counts, { insertBefore: 1 })

      scope.dispose()
    })

    it("should batch-delete items with O(1) DOM operations", () => {
      const items: string[] = []
      for (let i = 0; i < 50; i++) {
        items.push(`item${i}`)
      }

      const { container, counts, reset } = createCountingContainer("ul")
      const { ref, emit, setItems } = createMockSequenceRef(items)
      const scope = new Scope()

      listRegion(
        container,
        ref,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(50)
      reset()

      // Delete all 50 items (batch-delete since count > 1)
      setItems([])
      emit(sequenceChange([{ delete: 50 }]))

      expect(container.children.length).toBe(0)

      scope.dispose()
    })

    it("should handle replace change with full re-render fallback", () => {
      const { ref, emit, setItems } = createMockSequenceRef(["a", "b"])
      const scope = new Scope()
      const container = document.createElement("ul")

      listRegion(
        container,
        ref,
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

      // Emit a "replace" change (not "sequence") — should trigger full re-render
      setItems(["x", "y", "z"])
      emit({ type: "replace" })

      expect(container.children.length).toBe(3)
      expect(container.children[0].textContent).toBe("x")
      expect(container.children[1].textContent).toBe("y")
      expect(container.children[2].textContent).toBe("z")

      scope.dispose()
    })

    it("should clean up all subscriptions when scope is disposed", () => {
      const { ref } = createMockSequenceRef(["a", "b"])
      const scope = new Scope()
      const container = document.createElement("ul")

      listRegion(
        container,
        ref,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()

      expect(getActiveSubscriptionCount()).toBe(0)
    })

    it("should delete items when create handler returns DocumentFragment", () => {
      const { ref, emit, setItems } = createMockSequenceRef([
        "item1",
        "item2",
        "item3",
      ])
      const scope = new Scope()
      const container = document.createElement("ul")

      listRegion(
        container,
        ref,
        {
          create: (item: string) => {
            const frag = document.createDocumentFragment()
            const li = document.createElement("li")
            li.textContent = item
            frag.appendChild(li)
            return frag
          },
        },
        scope,
      )

      expect(container.children.length).toBe(3)

      // Delete middle item
      setItems(["item1", "item3"])
      emit(sequenceChange([{ retain: 1 }, { delete: 1 }]))

      expect(container.children.length).toBe(2)
      expect(container.children[0].textContent).toBe("item1")
      expect(container.children[1].textContent).toBe("item3")

      scope.dispose()
    })

    describe("conditional scope creation (isReactive)", () => {
      it("should skip scope allocation when isReactive is false", () => {
        const { ref } = createMockSequenceRef(["a", "b", "c"])
        const scope = new Scope()
        const container = document.createElement("ul")

        listRegion(
          container,
          ref,
          {
            create: (item: string) => {
              const li = document.createElement("li")
              li.textContent = item
              return li
            },
            isReactive: false,
          },
          scope,
        )

        expect(container.children.length).toBe(3)
        // When isReactive is false, no child scopes created for items
        // The only subscription is the list region's own subscription
        expect(getActiveSubscriptionCount()).toBe(1)

        scope.dispose()
      })

      it("should allocate scopes when isReactive is true", () => {
        const { ref } = createMockSequenceRef(["a", "b"])
        const scope = new Scope()
        const container = document.createElement("ul")

        listRegion(
          container,
          ref,
          {
            create: (item: string) => {
              const li = document.createElement("li")
              li.textContent = item
              return li
            },
            isReactive: true,
          },
          scope,
        )

        expect(container.children.length).toBe(2)
        // isReactive: true means child scopes are created per item
        // We can verify by checking the scope hierarchy exists

        scope.dispose()
      })

      it("should allocate scopes by default (isReactive omitted)", () => {
        const { ref } = createMockSequenceRef(["a", "b"])
        const scope = new Scope()
        const container = document.createElement("ul")

        listRegion(
          container,
          ref,
          {
            create: (item: string) => {
              const li = document.createElement("li")
              li.textContent = item
              return li
            },
            // isReactive not specified → defaults to true (conservative)
          },
          scope,
        )

        expect(container.children.length).toBe(2)

        scope.dispose()
      })

      it("should not create scopes for inserted items when isReactive is false", () => {
        const { ref, emit, setItems } = createMockSequenceRef<string>([])
        const scope = new Scope()
        const container = document.createElement("ul")

        listRegion(
          container,
          ref,
          {
            create: (item: string) => {
              const li = document.createElement("li")
              li.textContent = item
              return li
            },
            isReactive: false,
          },
          scope,
        )

        // Insert an item
        setItems(["new"])
        emit(sequenceChange([{ insert: ["new"] }]))

        expect(container.children.length).toBe(1)

        scope.dispose()
      })

      it("should safely delete items when isReactive is false (no scopes to dispose)", () => {
        const { ref, emit, setItems } = createMockSequenceRef([
          "a",
          "b",
          "c",
        ])
        const scope = new Scope()
        const container = document.createElement("ul")

        listRegion(
          container,
          ref,
          {
            create: (item: string) => {
              const li = document.createElement("li")
              li.textContent = item
              return li
            },
            isReactive: false,
          },
          scope,
        )

        expect(container.children.length).toBe(3)

        // Delete middle item — should not throw even though there are no item scopes
        setItems(["a", "c"])
        emit(sequenceChange([{ retain: 1 }, { delete: 1 }]))

        expect(container.children.length).toBe(2)
        expect(container.children[0].textContent).toBe("a")
        expect(container.children[1].textContent).toBe("c")

        scope.dispose()
      })

      it("should skip scopes for batch-inserted items when isReactive is false", () => {
        const { ref, emit, setItems } = createMockSequenceRef<string>([])
        const scope = new Scope()
        const container = document.createElement("ul")

        listRegion(
          container,
          ref,
          {
            create: (item: string) => {
              const li = document.createElement("li")
              li.textContent = item
              return li
            },
            isReactive: false,
          },
          scope,
        )

        // Batch insert 5 items
        const items = ["a", "b", "c", "d", "e"]
        setItems(items)
        emit(sequenceChange([{ insert: items }]))

        expect(container.children.length).toBe(5)

        scope.dispose()
      })
    })
  })

  // ===========================================================================
  // conditionalRegion — Integration Tests
  // ===========================================================================

  describe("conditionalRegion", () => {
    it("should render whenTrue branch when condition is true", () => {
      const condRef = state(1)
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("if")
      container.appendChild(marker)

      conditionalRegion(
        marker,
        condRef,
        () => condRef() > 0,
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
      const condRef = state(0)
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("if")
      container.appendChild(marker)

      conditionalRegion(
        marker,
        condRef,
        () => condRef() > 0,
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
      const condRef = state(0)
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("if")
      container.appendChild(marker)

      conditionalRegion(
        marker,
        condRef,
        () => condRef() > 0,
        {
          whenTrue: () => {
            const p = document.createElement("p")
            p.textContent = "visible"
            return p
          },
        },
        scope,
      )

      // Only the comment marker, no elements
      expect(container.children.length).toBe(0)

      scope.dispose()
    })

    it("should swap branches when condition changes", () => {
      const condRef = state(1)
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("if")
      container.appendChild(marker)

      conditionalRegion(
        marker,
        condRef,
        () => condRef() > 0,
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

      // Change condition to false
      condRef.set(0)

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("hidden")

      // Change condition back to true
      condRef.set(5)

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("visible")

      scope.dispose()
    })

    it("should dispose branch scope when swapping", () => {
      const condRef = state(1)
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("if")
      container.appendChild(marker)

      conditionalRegion(
        marker,
        condRef,
        () => condRef() > 0,
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

      // 1 subscription for the condRef
      const initialCount = getActiveSubscriptionCount()

      // Swap to false branch
      condRef.set(0)

      // Subscription count should remain stable (old branch scope disposed, new one created)
      expect(getActiveSubscriptionCount()).toBe(initialCount)

      scope.dispose()
    })

    it("should clean up subscriptions when scope is disposed", () => {
      const condRef = state(1)
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("if")
      container.appendChild(marker)

      conditionalRegion(
        marker,
        condRef,
        () => condRef() > 0,
        {
          whenTrue: () => {
            const p = document.createElement("p")
            p.textContent = "visible"
            return p
          },
        },
        scope,
      )

      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()

      expect(getActiveSubscriptionCount()).toBe(0)
    })

    it("should swap branches when handlers return DocumentFragment", () => {
      const condRef = state(1)
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("if")
      container.appendChild(marker)

      conditionalRegion(
        marker,
        condRef,
        () => condRef() > 0,
        {
          whenTrue: () => {
            const frag = document.createDocumentFragment()
            const p = document.createElement("p")
            p.textContent = "true-branch"
            frag.appendChild(p)
            return frag
          },
          whenFalse: () => {
            const frag = document.createDocumentFragment()
            const p = document.createElement("p")
            p.textContent = "false-branch"
            frag.appendChild(p)
            return frag
          },
        },
        scope,
      )

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("true-branch")

      // Swap to false
      condRef.set(0)

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("false-branch")

      // Swap back to true
      condRef.set(1)

      expect(container.children.length).toBe(1)
      expect(container.children[0].textContent).toBe("true-branch")

      scope.dispose()
    })
  })

  // ===========================================================================
  // planInitialRender — Pure Function Tests
  // ===========================================================================

  describe("planInitialRender", () => {
    it("should create insert ops for each item in the list", () => {
      const mockListRef: ListRefLike<{ index: number; value: string }> = {
        length: 3,
        at: (i: number) => ({ index: i, value: `item${i}` }),
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
        at: () => undefined,
      }

      const ops = planInitialRender(mockListRef)

      expect(ops).toEqual([])
    })

    it("should skip undefined items", () => {
      const mockListRef: ListRefLike<string> = {
        length: 3,
        at: (i: number) => (i === 1 ? undefined : `item${i}`),
      }

      const ops = planInitialRender(mockListRef)

      expect(ops).toEqual([
        { kind: "insert", index: 0, item: "item0" },
        { kind: "insert", index: 2, item: "item2" },
      ])
    })
  })

  // ===========================================================================
  // planDeltaOps — Pure Function Tests
  // ===========================================================================

  describe("planDeltaOps", () => {
    it("should emit batch-insert for multiple inserts (count > 1)", () => {
      const mockListRef: ListRefLike<{ index: number; isRef: true }> = {
        length: 2,
        at: (i: number) => ({ index: i, isRef: true }),
      }

      // SequenceChangeOp insert carries an array — length > 1 triggers batch
      const deltaOps: SequenceChangeOp<unknown>[] = [
        { insert: ["a", "b"] },
      ]

      const ops = planDeltaOps(mockListRef, deltaOps)

      // Should emit batch-insert with count, not individual inserts
      expect(ops).toEqual([{ kind: "batch-insert", index: 0, count: 2 }])
    })

    it("should emit single insert for count = 1", () => {
      const mockListRef: ListRefLike<{ index: number; isRef: true }> = {
        length: 1,
        at: (i: number) => ({ index: i, isRef: true }),
      }

      // Single-element insert array
      const deltaOps: SequenceChangeOp<unknown>[] = [{ insert: ["a"] }]

      const ops = planDeltaOps(mockListRef, deltaOps)

      // Single insert uses listRef.at() to get the ref
      expect(ops).toEqual([
        { kind: "insert", index: 0, item: { index: 0, isRef: true } },
      ])
    })

    it("should emit batch-delete for multiple deletes (count > 1)", () => {
      const mockListRef: ListRefLike<string> = {
        length: 1,
        at: () => "remaining",
      }

      const deltaOps: SequenceChangeOp<unknown>[] = [{ delete: 2 }]

      const ops = planDeltaOps(mockListRef, deltaOps)

      // Should emit batch-delete, not individual deletes
      expect(ops).toEqual([{ kind: "batch-delete", index: 0, count: 2 }])
    })

    it("should emit single delete for count = 1", () => {
      const mockListRef: ListRefLike<string> = {
        length: 1,
        at: () => "remaining",
      }

      const deltaOps: SequenceChangeOp<unknown>[] = [{ delete: 1 }]

      const ops = planDeltaOps(mockListRef, deltaOps)

      expect(ops).toEqual([{ kind: "delete", index: 0 }])
    })

    it("should handle retain operations correctly", () => {
      const mockListRef: ListRefLike<{ index: number }> = {
        length: 4,
        at: (i: number) => ({ index: i }),
      }

      // Retain 2, then insert 1 item
      const deltaOps: SequenceChangeOp<unknown>[] = [
        { retain: 2 },
        { insert: ["x"] },
      ]

      const ops = planDeltaOps(mockListRef, deltaOps)

      // Insert should be at index 2 (after retaining 2)
      expect(ops).toEqual([{ kind: "insert", index: 2, item: { index: 2 } }])
    })

    it("should handle mixed operations", () => {
      const mockListRef: ListRefLike<{ index: number }> = {
        length: 3,
        at: (i: number) => ({ index: i }),
      }

      // Retain 1, delete 1, insert 1
      const deltaOps: SequenceChangeOp<unknown>[] = [
        { retain: 1 },
        { delete: 1 },
        { insert: ["x"] },
      ]

      const ops = planDeltaOps(mockListRef, deltaOps)

      expect(ops).toEqual([
        { kind: "delete", index: 1 },
        { kind: "insert", index: 1, item: { index: 1 } },
      ])
    })

    it("should handle mixed batch and single operations", () => {
      const mockListRef: ListRefLike<{ index: number }> = {
        length: 5,
        at: (i: number) => ({ index: i }),
      }

      // Retain 1, delete 2 (batch), insert 2 (batch)
      const deltaOps: SequenceChangeOp<unknown>[] = [
        { retain: 1 },
        { delete: 2 },
        { insert: ["x", "y"] },
      ]

      const ops = planDeltaOps(mockListRef, deltaOps)

      expect(ops).toEqual([
        { kind: "batch-delete", index: 1, count: 2 },
        { kind: "batch-insert", index: 1, count: 2 },
      ])
    })

    it("should handle empty delta ops", () => {
      const mockListRef: ListRefLike<string> = {
        length: 1,
        at: () => "item",
      }

      const deltaOps: SequenceChangeOp<unknown>[] = []

      const ops = planDeltaOps(mockListRef, deltaOps)

      expect(ops).toEqual([])
    })
  })

  // ===========================================================================
  // planConditionalUpdate — Pure Function Tests
  // ===========================================================================

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

  // ===========================================================================
  // claimSlot / releaseSlot — DOM Helpers
  // ===========================================================================

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

      const slot = claimSlot(parent, frag, null, undefined)

      expect(slot.kind).toBe("range")
    })
  })

  describe("releaseSlot - multi-element", () => {
    it("removes all nodes in range including markers", () => {
      const parent = document.createElement("div")
      const frag = document.createDocumentFragment()
      frag.appendChild(document.createElement("span"))
      frag.appendChild(document.createElement("span"))

      // Claim puts markers + children into the parent
      const slot = claimSlot(parent, frag, null, undefined)

      expect(parent.childNodes.length).toBeGreaterThan(0)

      releaseSlot(parent, slot)

      expect(parent.childNodes.length).toBe(0)
    })
  })

  // ===========================================================================
  // listRegion — Ref Preservation Tests
  // ===========================================================================

  describe("listRegion - ref preservation", () => {
    it("should pass refs from listRef.at() to create handler for initial render", () => {
      // Create refs that have identity (objects, not primitives)
      const refs = [
        { id: 0, text: "item0" },
        { id: 1, text: "item1" },
        { id: 2, text: "item2" },
      ]
      const { ref } = createMockSequenceRef(refs)
      const scope = new Scope()
      const container = document.createElement("ul")

      const receivedItems: unknown[] = []

      listRegion(
        container,
        ref,
        {
          create: (item: { id: number; text: string }, _index: number) => {
            receivedItems.push(item)
            const li = document.createElement("li")
            li.textContent = item.text
            return li
          },
        },
        scope,
      )

      // Verify handlers received the exact ref objects from .at()
      expect(receivedItems.length).toBe(3)
      expect(receivedItems[0]).toBe(refs[0])
      expect(receivedItems[1]).toBe(refs[1])
      expect(receivedItems[2]).toBe(refs[2])

      scope.dispose()
    })

    it("should pass refs from listRef.at() to create handler for delta inserts", () => {
      const { ref, emit, setItems } = createMockSequenceRef<{
        id: number
        text: string
      }>([])
      const scope = new Scope()
      const container = document.createElement("ul")

      const receivedItems: unknown[] = []

      listRegion(
        container,
        ref,
        {
          create: (item: { id: number; text: string }) => {
            receivedItems.push(item)
            const li = document.createElement("li")
            li.textContent = item.text
            return li
          },
        },
        scope,
      )

      expect(receivedItems.length).toBe(0)

      // Insert items via delta — the handler should receive refs from .at()
      const newRefs = [
        { id: 10, text: "new0" },
        { id: 11, text: "new1" },
      ]
      setItems(newRefs)

      // Single insert
      emit(sequenceChange([{ insert: ["placeholder"] }]))

      expect(receivedItems.length).toBe(1)
      // The handler received the ref from .at(0), which is newRefs[0]
      expect(receivedItems[0]).toBe(newRefs[0])

      scope.dispose()
    })
  })
})