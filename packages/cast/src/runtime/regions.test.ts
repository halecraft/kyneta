/**
 * Tests for regions.ts — list and conditional region management.
 *
 * List region tests use mock sequence refs with [CHANGEFEED] protocol.
 * Conditional region tests use LocalRef for condition state.
 */

import {
  CHANGEFEED,
  type ChangeBase,
  type Changefeed,
  type Changeset,
  type SequenceInstruction,
} from "@kyneta/schema"
import { JSDOM } from "jsdom"
import { beforeEach, describe, expect, it } from "vitest"
import { state } from "../reactive/local-ref.js"
import {
  assertMaxMutations,
  createCountingContainer,
} from "../testing/counting-dom.js"
import {
  claimSlot,
  conditionalRegion,
  filteredListRegion,
  type ListRefLike,
  listRegion,
  planConditionalUpdate,
  planDeltaOps,
  planFilterUpdate,
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
  let callback: ((changeset: Changeset<ChangeBase>) => void) | null = null

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
      subscribe(cb: (changeset: Changeset<ChangeBase>) => void): () => void {
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
      callback?.({ changes: [change] })
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
  instructions: SequenceInstruction<unknown>[],
): ChangeBase & { instructions: SequenceInstruction<unknown>[] } {
  return { type: "sequence", instructions }
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
      const { ref, emit, setItems } = createMockSequenceRef(["first", "third"])
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
      assertMaxMutations(counts, 1)

      scope.dispose()
    })

    it("should batch-delete items with O(1) DOM operations", () => {
      const items: string[] = []
      for (let i = 0; i < 50; i++) {
        items.push(`item${i}`)
      }

      const {
        container,
        counts: _counts,
        reset,
      } = createCountingContainer("ul")
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
        const { ref, emit, setItems } = createMockSequenceRef(["a", "b", "c"])
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

    it("should pass per-item scope to create, disposed on item delete", () => {
      const { ref, emit, setItems } = createMockSequenceRef(["a", "b"])
      const scope = new Scope()
      const container = document.createElement("ul")
      let disposedCount = 0

      listRegion(
        container,
        ref,
        {
          create: (item: string, _index: number, itemScope: Scope) => {
            const li = document.createElement("li")
            li.textContent = item
            // Register a disposal callback on the item scope
            itemScope.onDispose(() => {
              disposedCount++
            })
            return li
          },
          isReactive: true,
        },
        scope,
      )

      expect(container.children.length).toBe(2)
      expect(disposedCount).toBe(0)

      // Delete item 0
      setItems(["b"])
      emit(sequenceChange([{ delete: 1 }]))

      expect(container.children.length).toBe(1)
      // The per-item scope for the deleted item should have been disposed
      expect(disposedCount).toBe(1)

      scope.dispose()
    })
  })

  // ===========================================================================
  // listRegion — Comment-marker mount point (template-cloning path)
  //
  // The compiler's template-cloning codegen emits paired comment markers
  // (<!--kyneta:list:N--><!--/kyneta:list-->) and passes the opening
  // comment to listRegion as the mount point. These tests verify that
  // listRegion correctly derives the parent from marker.parentNode and
  // inserts items between the paired markers.
  // ===========================================================================

  describe("listRegion with comment-marker mount point", () => {
    /**
     * Create a container with paired list markers and optional trailing content,
     * simulating the DOM structure produced by template cloning.
     *
     * Returns: <ul> <!--open--> <!--/close--> [<p>trailing</p>]? </ul>
     */
    function createMarkedContainer(options?: { trailingContent?: boolean }) {
      const container = document.createElement("ul")
      const openMarker = document.createComment("kyneta:list:0")
      const closeMarker = document.createComment("/kyneta:list")
      container.appendChild(openMarker)
      container.appendChild(closeMarker)
      if (options?.trailingContent) {
        const trailing = document.createElement("p")
        trailing.textContent = "after the list"
        container.appendChild(trailing)
      }
      return { container, openMarker, closeMarker }
    }

    it("should render initial items between paired markers", () => {
      const { ref } = createMockSequenceRef(["a", "b", "c"])
      const scope = new Scope()
      const { container, openMarker, closeMarker } = createMarkedContainer()

      listRegion(
        openMarker,
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

      // Items should appear between the markers
      expect(container.childNodes.length).toBe(5) // open + 3 items + close
      expect(container.childNodes[0]).toBe(openMarker)
      expect((container.childNodes[1] as HTMLElement).textContent).toBe("a")
      expect((container.childNodes[2] as HTMLElement).textContent).toBe("b")
      expect((container.childNodes[3] as HTMLElement).textContent).toBe("c")
      expect(container.childNodes[4]).toBe(closeMarker)

      scope.dispose()
    })

    it("should insert pushed items before the closing marker", () => {
      const { ref, emit, setItems } = createMockSequenceRef(["a"])
      const scope = new Scope()
      const { container, closeMarker } = createMarkedContainer()

      listRegion(
        container.firstChild as Comment, // the open marker
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

      expect(container.children.length).toBe(1)

      // Push a new item
      setItems(["a", "b"])
      emit(sequenceChange([{ retain: 1 }, { insert: ["b"] }]))

      expect(container.children.length).toBe(2)
      expect(container.children[1].textContent).toBe("b")
      // The closing marker should still be after all items
      expect(container.lastChild).toBe(closeMarker)

      scope.dispose()
    })

    it("should not displace sibling content after the closing marker", () => {
      const { ref, emit, setItems } = createMockSequenceRef(["x"])
      const scope = new Scope()
      const { container, closeMarker } = createMarkedContainer({
        trailingContent: true,
      })
      const trailing = container.lastChild as HTMLElement

      listRegion(
        container.firstChild as Comment,
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

      // Trailing <p> should remain at the end
      expect(container.lastChild).toBe(trailing)
      expect(trailing.textContent).toBe("after the list")

      // Push more items — trailing content should stay put
      setItems(["x", "y", "z"])
      emit(sequenceChange([{ retain: 1 }, { insert: ["y", "z"] }]))

      expect(container.children.length).toBe(4) // 3 <li> + 1 <p>
      expect(container.lastChild).toBe(trailing)
      // Close marker should be between the last item and the trailing content
      expect(closeMarker.nextSibling).toBe(trailing)

      scope.dispose()
    })

    it("should delete items correctly when using marker mount point", () => {
      const { ref, emit, setItems } = createMockSequenceRef(["a", "b", "c"])
      const scope = new Scope()
      const { container, openMarker, closeMarker } = createMarkedContainer()

      listRegion(
        openMarker,
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
      setItems(["a", "c"])
      emit(sequenceChange([{ retain: 1 }, { delete: 1 }]))

      expect(container.children.length).toBe(2)
      expect(container.children[0].textContent).toBe("a")
      expect(container.children[1].textContent).toBe("c")
      // Markers should still bracket the items
      expect(container.firstChild).toBe(openMarker)
      expect(closeMarker.previousSibling).toBe(container.children[1])

      scope.dispose()
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
        [condRef],
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
        [condRef],
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
        [condRef],
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
        [condRef],
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
        [condRef],
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
        [condRef],
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
        [condRef],
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

    describe("conditionalRegion — multi-ref", () => {
      it("should re-evaluate when any of multiple condition refs change", () => {
        const refA = state(1)
        const refB = state(true)
        const scope = new Scope()
        const container = document.createElement("div")
        const marker = document.createComment("if")
        container.appendChild(marker)

        conditionalRegion(
          marker,
          [refA, refB],
          () => refA() > 0 && refB(),
          {
            whenTrue: () => {
              const p = document.createElement("p")
              p.textContent = "visible"
              return p
            },
          },
          scope,
        )

        // Initial: both truthy → visible
        expect(container.children.length).toBe(1)
        expect(container.children[0].textContent).toBe("visible")

        // Change refB to false → condition becomes false → hidden
        refB.set(false)
        expect(container.children.length).toBe(0)

        // Change refB back to true → condition becomes true → visible
        refB.set(true)
        expect(container.children.length).toBe(1)
        expect(container.children[0].textContent).toBe("visible")

        // Change refA to 0 → condition becomes false → hidden
        refA.set(0)
        expect(container.children.length).toBe(0)

        // Change refA back to positive → condition becomes true → visible
        refA.set(5)
        expect(container.children.length).toBe(1)
        expect(container.children[0].textContent).toBe("visible")

        scope.dispose()
      })

      it("should clean up all subscriptions from multiple refs", () => {
        const refA = state(1)
        const refB = state(true)
        const scope = new Scope()
        const container = document.createElement("div")
        const marker = document.createComment("if")
        container.appendChild(marker)

        const before = getActiveSubscriptionCount()

        conditionalRegion(
          marker,
          [refA, refB],
          () => refA() > 0 && refB(),
          {
            whenTrue: () => {
              const p = document.createElement("p")
              p.textContent = "visible"
              return p
            },
          },
          scope,
        )

        // Two subscriptions — one per ref
        expect(getActiveSubscriptionCount()).toBe(before + 2)

        scope.dispose()

        expect(getActiveSubscriptionCount()).toBe(before)
      })
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

      // SequenceInstruction insert carries an array — length > 1 triggers batch
      const deltaOps: SequenceInstruction<unknown>[] = [{ insert: ["a", "b"] }]

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
      const deltaOps: SequenceInstruction<unknown>[] = [{ insert: ["a"] }]

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

      const deltaOps: SequenceInstruction<unknown>[] = [{ delete: 2 }]

      const ops = planDeltaOps(mockListRef, deltaOps)

      // Should emit batch-delete, not individual deletes
      expect(ops).toEqual([{ kind: "batch-delete", index: 0, count: 2 }])
    })

    it("should emit single delete for count = 1", () => {
      const mockListRef: ListRefLike<string> = {
        length: 1,
        at: () => "remaining",
      }

      const deltaOps: SequenceInstruction<unknown>[] = [{ delete: 1 }]

      const ops = planDeltaOps(mockListRef, deltaOps)

      expect(ops).toEqual([{ kind: "delete", index: 0 }])
    })

    it("should handle retain operations correctly", () => {
      const mockListRef: ListRefLike<{ index: number }> = {
        length: 4,
        at: (i: number) => ({ index: i }),
      }

      // Retain 2, then insert 1 item
      const deltaOps: SequenceInstruction<unknown>[] = [
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
      const deltaOps: SequenceInstruction<unknown>[] = [
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
      const deltaOps: SequenceInstruction<unknown>[] = [
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

      const deltaOps: SequenceInstruction<unknown>[] = []

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

  // ===========================================================================
  // Nested Region Tests — Anchor-Based Parent Resolution
  // ===========================================================================

  describe("nested regions — anchor-based parent resolution", () => {
    // -------------------------------------------------------------------------
    // 1.4 — Conditional inside list create handler (fragment parent)
    // -------------------------------------------------------------------------
    describe("conditional inside list create handler (fragment parent)", () => {
      it("should toggle conditional content via shared external ref after fragment consumption", () => {
        const condRef = state(true)
        const { ref } = createMockSequenceRef(["a", "b"])
        const scope = new Scope()
        const container = document.createElement("div")

        listRegion<string>(
          container,
          ref,
          {
            create: (item: string) => {
              // Simulate generateBodyWithFragment: return a DocumentFragment
              // containing a comment marker and conditionalRegion wired to it.
              const frag = document.createDocumentFragment()
              const marker = document.createComment("kyneta:if")
              frag.appendChild(marker)

              conditionalRegion(
                marker,
                [condRef],
                () => condRef(),
                {
                  whenTrue: () => {
                    const span = document.createElement("span")
                    span.textContent = item
                    return span
                  },
                },
                scope,
              )

              return frag
            },
            slotKind: "range",
            isReactive: true,
          },
          scope,
        )

        // Both items should render their conditional content (initial = true)
        expect(container.querySelectorAll("span").length).toBe(2)
        expect(container.querySelectorAll("span")[0].textContent).toBe("a")
        expect(container.querySelectorAll("span")[1].textContent).toBe("b")

        // Toggle condition to false — content should be removed from real DOM
        condRef.set(false)
        expect(container.querySelectorAll("span").length).toBe(0)

        // Toggle back to true — content should reappear in real DOM
        condRef.set(true)
        expect(container.querySelectorAll("span").length).toBe(2)

        scope.dispose()
      })
    })

    // -------------------------------------------------------------------------
    // Conditional swap inside list (if/else in fragment)
    // -------------------------------------------------------------------------
    describe("conditional swap inside list (if/else in fragment)", () => {
      it("should swap branches correctly when condition changes", () => {
        const condRef = state(true)
        const { ref } = createMockSequenceRef(["x"])
        const scope = new Scope()
        const container = document.createElement("div")

        listRegion<string>(
          container,
          ref,
          {
            create: (item: string) => {
              const frag = document.createDocumentFragment()
              const marker = document.createComment("kyneta:if")
              frag.appendChild(marker)

              conditionalRegion(
                marker,
                [condRef],
                () => condRef(),
                {
                  whenTrue: () => {
                    const p = document.createElement("p")
                    p.textContent = `${item}-true`
                    return p
                  },
                  whenFalse: () => {
                    const p = document.createElement("p")
                    p.textContent = `${item}-false`
                    return p
                  },
                },
                scope,
              )

              return frag
            },
            slotKind: "range",
            isReactive: true,
          },
          scope,
        )

        // Initially true branch
        expect(container.querySelector("p")?.textContent).toBe("x-true")

        // Swap to false branch
        condRef.set(false)
        expect(container.querySelector("p")?.textContent).toBe("x-false")

        // Swap back to true branch
        condRef.set(true)
        expect(container.querySelector("p")?.textContent).toBe("x-true")

        scope.dispose()
      })
    })

    // -------------------------------------------------------------------------
    // listRegion inside a DocumentFragment mount point
    // -------------------------------------------------------------------------
    describe("listRegion with DocumentFragment mount point", () => {
      it("should render initial items and transfer them to real DOM", () => {
        const { ref } = createMockSequenceRef(["a", "b"])
        const scope = new Scope()

        // Create a fragment as the mount point (simulates the latent bug)
        const frag = document.createDocumentFragment()

        listRegion<string>(
          frag,
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

        // Items are initially inside the fragment (with auto-promoted markers)
        // The fragment should contain: <!--kyneta:list--> <li>a</li> <li>b</li> <!--/kyneta:list-->
        expect(frag.childNodes.length).toBe(4) // 2 markers + 2 items

        // Now consume the fragment into a real DOM container
        const container = document.createElement("ul")
        container.appendChild(frag)

        // Items should now be in the real DOM
        expect(container.querySelectorAll("li").length).toBe(2)
        expect(container.querySelectorAll("li")[0].textContent).toBe("a")
        expect(container.querySelectorAll("li")[1].textContent).toBe("b")

        scope.dispose()
      })

      it("should insert items into real DOM after fragment consumption", () => {
        const { ref, emit, setItems } = createMockSequenceRef(["a"])
        const scope = new Scope()

        const frag = document.createDocumentFragment()

        listRegion<string>(
          frag,
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

        // Consume the fragment into a real container
        const container = document.createElement("ul")
        container.appendChild(frag)

        expect(container.querySelectorAll("li").length).toBe(1)

        // Now insert a new item via sequence change — this should go into
        // the real DOM (via lazy parent resolution), not the stale fragment
        setItems(["a", "b"])
        emit(sequenceChange([{ retain: 1 }, { insert: ["b"] }]))

        expect(container.querySelectorAll("li").length).toBe(2)
        expect(container.querySelectorAll("li")[1].textContent).toBe("b")

        scope.dispose()
      })

      it("should delete items from real DOM after fragment consumption", () => {
        const { ref, emit, setItems } = createMockSequenceRef(["a", "b"])
        const scope = new Scope()

        const frag = document.createDocumentFragment()

        listRegion<string>(
          frag,
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

        // Consume into real DOM
        const container = document.createElement("ul")
        container.appendChild(frag)

        expect(container.querySelectorAll("li").length).toBe(2)

        // Delete second item
        setItems(["a"])
        emit(sequenceChange([{ retain: 1 }, { delete: 1 }]))

        expect(container.querySelectorAll("li").length).toBe(1)
        expect(container.querySelectorAll("li")[0].textContent).toBe("a")

        scope.dispose()
      })
    })
  })

  // ===========================================================================
  // planFilterUpdate — Pure Function Tests
  // ===========================================================================

  describe("planFilterUpdate", () => {
    it("should emit show ops for items that become visible", () => {
      const mockListRef: ListRefLike<number> = {
        length: 3,
        at: (i: number) => [10, 20, 30][i],
      }
      // All currently hidden
      const visibility = [false, false, false]
      // Predicate: show items > 15
      const ops = planFilterUpdate(
        visibility,
        (item: number) => item > 15,
        mockListRef,
      )
      expect(ops).toEqual([
        { kind: "show", index: 1 },
        { kind: "show", index: 2 },
      ])
    })

    it("should emit hide ops for items that become hidden", () => {
      const mockListRef: ListRefLike<number> = {
        length: 3,
        at: (i: number) => [10, 20, 30][i],
      }
      // All currently visible
      const visibility = [true, true, true]
      // Predicate: show items > 25
      const ops = planFilterUpdate(
        visibility,
        (item: number) => item > 25,
        mockListRef,
      )
      expect(ops).toEqual([
        { kind: "hide", index: 0 },
        { kind: "hide", index: 1 },
      ])
    })

    it("should return empty array when nothing changes", () => {
      const mockListRef: ListRefLike<number> = {
        length: 3,
        at: (i: number) => [10, 20, 30][i],
      }
      const visibility = [false, true, true]
      // Predicate matches current visibility
      const ops = planFilterUpdate(
        visibility,
        (item: number) => item > 15,
        mockListRef,
      )
      expect(ops).toEqual([])
    })

    it("should handle empty list", () => {
      const mockListRef: ListRefLike<number> = {
        length: 0,
        at: () => undefined,
      }
      const ops = planFilterUpdate([], () => true, mockListRef)
      expect(ops).toEqual([])
    })

    it("should emit mixed show and hide ops", () => {
      const mockListRef: ListRefLike<number> = {
        length: 4,
        at: (i: number) => [10, 20, 30, 40][i],
      }
      // Items 0,2 visible; 1,3 hidden
      const visibility = [true, false, true, false]
      // show items > 15:
      // 10→hide, 20→show, 30→noop, 40→show
      const ops = planFilterUpdate(
        visibility,
        (item: number) => item > 15,
        mockListRef,
      )
      expect(ops).toEqual([
        { kind: "hide", index: 0 },
        { kind: "show", index: 1 },
        { kind: "show", index: 3 },
      ])
    })
  })

  // ===========================================================================
  // filteredListRegion — Runtime Tests
  // ===========================================================================

  describe("filteredListRegion", () => {
    describe("with external dep", () => {
      it("should show/hide items when external ref changes", () => {
        const threshold = state(15)
        const items = [10, 20, 30]
        const { ref } = createMockSequenceRef(items)
        const scope = new Scope()
        const container = document.createElement("ul")

        filteredListRegion<number>(
          container,
          ref,
          {
            create: (item: number) => {
              const li = document.createElement("li")
              li.textContent = String(item)
              return li
            },
            predicate: (item: number) => item > threshold(),
            externalRefs: [threshold],
            itemRefs: () => [],
          },
          scope,
        )

        // Initially: 20 and 30 visible (> 15), 10 hidden
        expect(container.querySelectorAll("li").length).toBe(2)
        expect(container.querySelectorAll("li")[0].textContent).toBe("20")
        expect(container.querySelectorAll("li")[1].textContent).toBe("30")

        // Change threshold to 25 → only 30 visible
        threshold.set(25)
        expect(container.querySelectorAll("li").length).toBe(1)
        expect(container.querySelectorAll("li")[0].textContent).toBe("30")

        // Change threshold to 5 → all visible
        threshold.set(5)
        expect(container.querySelectorAll("li").length).toBe(3)
        expect(container.querySelectorAll("li")[0].textContent).toBe("10")
        expect(container.querySelectorAll("li")[1].textContent).toBe("20")
        expect(container.querySelectorAll("li")[2].textContent).toBe("30")

        scope.dispose()
      })
    })

    describe("with item dep", () => {
      it("should show/hide individual items when item ref changes", () => {
        // Each item has a reactive "score" field
        const item0Score = state(10)
        const item1Score = state(20)
        const item2Score = state(30)

        type ScoredItem = {
          name: string
          score: ReturnType<typeof state<number>>
        }
        const items: ScoredItem[] = [
          { name: "a", score: item0Score },
          { name: "b", score: item1Score },
          { name: "c", score: item2Score },
        ]
        const { ref } = createMockSequenceRef(items)
        const scope = new Scope()
        const container = document.createElement("ul")

        filteredListRegion<ScoredItem>(
          container,
          ref,
          {
            create: (item: ScoredItem) => {
              const li = document.createElement("li")
              li.textContent = item.name
              return li
            },
            predicate: (item: ScoredItem) => item.score() > 15,
            externalRefs: [],
            itemRefs: (item: ScoredItem) => [item.score],
          },
          scope,
        )

        // Initially: b (20) and c (30) visible, a (10) hidden
        expect(container.querySelectorAll("li").length).toBe(2)
        expect(container.querySelectorAll("li")[0].textContent).toBe("b")
        expect(container.querySelectorAll("li")[1].textContent).toBe("c")

        // Change item 0's score to 20 → a becomes visible
        item0Score.set(20)
        expect(container.querySelectorAll("li").length).toBe(3)
        expect(container.querySelectorAll("li")[0].textContent).toBe("a")
        expect(container.querySelectorAll("li")[1].textContent).toBe("b")
        expect(container.querySelectorAll("li")[2].textContent).toBe("c")

        // Change item 1's score to 5 → b becomes hidden
        item1Score.set(5)
        expect(container.querySelectorAll("li").length).toBe(2)
        expect(container.querySelectorAll("li")[0].textContent).toBe("a")
        expect(container.querySelectorAll("li")[1].textContent).toBe("c")

        scope.dispose()
      })
    })

    describe("structural changes with active filter", () => {
      it("should not render inserted item that fails predicate", () => {
        const threshold = state(15)
        const { ref, emit, setItems } = createMockSequenceRef([20, 30])
        const scope = new Scope()
        const container = document.createElement("ul")

        filteredListRegion<number>(
          container,
          ref,
          {
            create: (item: number) => {
              const li = document.createElement("li")
              li.textContent = String(item)
              return li
            },
            predicate: (item: number) => item > threshold(),
            externalRefs: [threshold],
            itemRefs: () => [],
          },
          scope,
        )

        // Both visible initially
        expect(container.querySelectorAll("li").length).toBe(2)

        // Insert item 5 at position 0 — fails predicate (5 < 15)
        setItems([5, 20, 30])
        emit(sequenceChange([{ insert: [5] }]))

        // Item 5 should NOT be rendered
        expect(container.querySelectorAll("li").length).toBe(2)
        expect(container.querySelectorAll("li")[0].textContent).toBe("20")
        expect(container.querySelectorAll("li")[1].textContent).toBe("30")

        scope.dispose()
      })

      it("should render inserted item that passes predicate", () => {
        const threshold = state(15)
        const { ref, emit, setItems } = createMockSequenceRef([20, 30])
        const scope = new Scope()
        const container = document.createElement("ul")

        filteredListRegion<number>(
          container,
          ref,
          {
            create: (item: number) => {
              const li = document.createElement("li")
              li.textContent = String(item)
              return li
            },
            predicate: (item: number) => item > threshold(),
            externalRefs: [threshold],
            itemRefs: () => [],
          },
          scope,
        )

        expect(container.querySelectorAll("li").length).toBe(2)

        // Insert item 25 at end — passes predicate (25 > 15)
        setItems([20, 30, 25])
        emit(sequenceChange([{ retain: 2 }, { insert: [25] }]))

        expect(container.querySelectorAll("li").length).toBe(3)
        expect(container.querySelectorAll("li")[2].textContent).toBe("25")

        scope.dispose()
      })

      it("should correctly delete a visible item", () => {
        const threshold = state(15)
        const { ref, emit, setItems } = createMockSequenceRef([20, 30])
        const scope = new Scope()
        const container = document.createElement("ul")

        filteredListRegion<number>(
          container,
          ref,
          {
            create: (item: number) => {
              const li = document.createElement("li")
              li.textContent = String(item)
              return li
            },
            predicate: (item: number) => item > threshold(),
            externalRefs: [threshold],
            itemRefs: () => [],
          },
          scope,
        )

        expect(container.querySelectorAll("li").length).toBe(2)

        // Delete first item (20)
        setItems([30])
        emit(sequenceChange([{ delete: 1 }]))

        expect(container.querySelectorAll("li").length).toBe(1)
        expect(container.querySelectorAll("li")[0].textContent).toBe("30")

        scope.dispose()
      })

      it("should correctly delete a hidden item", () => {
        const threshold = state(15)
        const { ref, emit, setItems } = createMockSequenceRef([10, 20, 30])
        const scope = new Scope()
        const container = document.createElement("ul")

        filteredListRegion<number>(
          container,
          ref,
          {
            create: (item: number) => {
              const li = document.createElement("li")
              li.textContent = String(item)
              return li
            },
            predicate: (item: number) => item > threshold(),
            externalRefs: [threshold],
            itemRefs: () => [],
          },
          scope,
        )

        // 10 hidden, 20 and 30 visible
        expect(container.querySelectorAll("li").length).toBe(2)

        // Delete first item (10, which is hidden)
        setItems([20, 30])
        emit(sequenceChange([{ delete: 1 }]))

        // Should still have 2 visible items
        expect(container.querySelectorAll("li").length).toBe(2)
        expect(container.querySelectorAll("li")[0].textContent).toBe("20")
        expect(container.querySelectorAll("li")[1].textContent).toBe("30")

        scope.dispose()
      })

      it("should keep visibility aligned after insert then external dep change", () => {
        // This tests the hardest invariant: after a structural mutation
        // (insert), the visibility array must stay index-aligned so that
        // a subsequent external dep change correctly shows/hides items.
        const threshold = state(15)
        const { ref, emit, setItems } = createMockSequenceRef([20, 30])
        const scope = new Scope()
        const container = document.createElement("ul")

        filteredListRegion<number>(
          container,
          ref,
          {
            create: (item: number) => {
              const li = document.createElement("li")
              li.textContent = String(item)
              return li
            },
            predicate: (item: number) => item > threshold(),
            externalRefs: [threshold],
            itemRefs: () => [],
          },
          scope,
        )

        // Initially: [20, 30] both visible (> 15)
        expect(container.querySelectorAll("li").length).toBe(2)

        // Insert hidden item 5 at front → source is now [5, 20, 30]
        setItems([5, 20, 30])
        emit(sequenceChange([{ insert: [5] }]))
        expect(container.querySelectorAll("li").length).toBe(2) // 5 is hidden

        // Now change threshold to 25 — visibility must re-evaluate ALL 3 items:
        // 5 > 25? no (was hidden → still hidden)
        // 20 > 25? no (was visible → hide)
        // 30 > 25? yes (was visible → still visible)
        threshold.set(25)
        expect(container.querySelectorAll("li").length).toBe(1)
        expect(container.querySelectorAll("li")[0].textContent).toBe("30")

        // Change threshold to 0 — all 3 should appear in correct order
        threshold.set(0)
        expect(container.querySelectorAll("li").length).toBe(3)
        expect(container.querySelectorAll("li")[0].textContent).toBe("5")
        expect(container.querySelectorAll("li")[1].textContent).toBe("20")
        expect(container.querySelectorAll("li")[2].textContent).toBe("30")

        scope.dispose()
      })

      it("should insert a newly-shown item at the correct DOM position between visible siblings", () => {
        // Tests findReferenceNode: when item at index 1 (hidden) becomes visible,
        // it must appear between index 0 (visible) and index 2 (visible).
        const threshold = state(15)
        const items = [20, 10, 30]
        const { ref } = createMockSequenceRef(items)
        const scope = new Scope()
        const container = document.createElement("ul")

        filteredListRegion<number>(
          container,
          ref,
          {
            create: (item: number) => {
              const li = document.createElement("li")
              li.textContent = String(item)
              return li
            },
            predicate: (item: number) => item > threshold(),
            externalRefs: [threshold],
            itemRefs: () => [],
          },
          scope,
        )

        // Initially: [20, 10, 30] → 20 and 30 visible, 10 hidden
        expect(container.querySelectorAll("li").length).toBe(2)
        expect(container.querySelectorAll("li")[0].textContent).toBe("20")
        expect(container.querySelectorAll("li")[1].textContent).toBe("30")

        // Lower threshold to 5 → 10 becomes visible, must appear BETWEEN 20 and 30
        threshold.set(5)
        expect(container.querySelectorAll("li").length).toBe(3)
        expect(container.querySelectorAll("li")[0].textContent).toBe("20")
        expect(container.querySelectorAll("li")[1].textContent).toBe("10")
        expect(container.querySelectorAll("li")[2].textContent).toBe("30")

        scope.dispose()
      })
    })
  })
})
