/**
 * Todo App Integration Test (Task 9.5)
 *
 * Full integration test for a todo application that exercises all Kinetic features:
 * - List regions with O(k) updates
 * - Conditional regions for empty state
 * - Two-way input bindings
 * - Reactive expressions
 * - Scope-based cleanup
 *
 * This test validates that the client-side implementation is production-ready
 * before proceeding to SSR (Phase 10).
 *
 * Note: List region handlers receive PlainValueRef for value shapes, enabling
 * two-way binding patterns. Use `.get()` to read and `.set()` to write.
 *
 * @packageDocumentation
 */

import type { PlainValueRef } from "@loro-extended/change"

import { createTypedDoc, loro, Shape } from "@loro-extended/change"
import { JSDOM } from "jsdom"
import { beforeEach, describe, expect, it } from "vitest"

import {
  __conditionalRegion,
  __listRegion,
  __resetScopeIdCounter,
  __subscribeWithValue,
  Scope,
} from "../../src/index.js"
import { __bindTextValue } from "../../src/loro/index.js"
import { __resetSubscriptionIdCounter } from "../../src/runtime/subscribe.js"
import {
  assertMaxMutations,
  createCountingContainer,
} from "../../src/testing/counting-dom.js"

// Set up DOM globals
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>")
global.document = dom.window.document
global.Node = dom.window.Node
global.Element = dom.window.Element
global.Comment = dom.window.Comment
global.Text = dom.window.Text
global.Event = dom.window.Event
global.HTMLInputElement = dom.window.HTMLInputElement
global.HTMLTextAreaElement = dom.window.HTMLTextAreaElement

// =============================================================================
// Todo Schema (Simple version with plain values)
// =============================================================================

/**
 * Schema for a simple todo application.
 * Uses plain values for simplicity in list iteration.
 */
const todoSchema = Shape.doc({
  /** New todo input text */
  newTodoText: Shape.text(),
  /** List of todo items (plain strings for simplicity) */
  todos: Shape.list(Shape.plain.string()),
  /** Count of completed items (simulates filtering) */
  completedCount: Shape.counter(),
})

type TodoDoc = ReturnType<typeof createTypedDoc<typeof todoSchema>>

// =============================================================================
// Todo App Component (Simulated Compiled Output)
// =============================================================================

/**
 * Simulates what the compiled Kinetic code would generate for a todo app.
 *
 * This manually constructs the DOM and subscriptions that the compiler
 * would generate, allowing us to test the full client-side flow.
 */
function renderTodoApp(doc: TodoDoc, container: Element, scope: Scope): void {
  // === Header ===
  const header = document.createElement("header")
  const h1 = document.createElement("h1")
  h1.textContent = "todos"
  header.appendChild(h1)

  // New todo input with binding
  const newTodoInput = document.createElement("input") as HTMLInputElement
  newTodoInput.type = "text"
  newTodoInput.placeholder = "What needs to be done?"
  newTodoInput.className = "new-todo"
  __bindTextValue(newTodoInput, doc.newTodoText, scope)
  header.appendChild(newTodoInput)

  // Add todo on Enter
  newTodoInput.addEventListener("keydown", (e: Event) => {
    const keyEvent = e as KeyboardEvent
    if (keyEvent.key === "Enter") {
      const text = doc.newTodoText.toString().trim()
      if (text) {
        // Add new todo
        doc.todos.push(text)
        // Clear input
        const loroText = loro(doc.newTodoText)
        const currentLength = loroText.toString().length
        if (currentLength > 0) {
          loroText.delete(0, currentLength)
        }
      }
    }
  })

  container.appendChild(header)

  // === Main Section ===
  const main = document.createElement("section")
  main.className = "main"

  // Conditional: show list or empty state
  const mainMarker = document.createComment("kinetic:if:main")
  main.appendChild(mainMarker)

  __conditionalRegion(
    mainMarker,
    doc.todos,
    () => doc.todos.toArray().length > 0,
    {
      whenTrue: () => {
        const todoList = document.createElement("ul")
        todoList.className = "todo-list"

        // List region for todos
        __listRegion(
          todoList,
          doc.todos,
          {
            create: (itemRef: PlainValueRef<string>, index: number) => {
              // Get the current value from the ref
              const item = itemRef.get()

              const li = document.createElement("li")
              li.dataset.testid = "todo-item"
              li.dataset.index = String(index)

              // Label with text
              const label = document.createElement("label")
              label.textContent = item
              li.appendChild(label)

              // Delete button
              const destroyBtn = document.createElement("button")
              destroyBtn.className = "destroy"
              destroyBtn.textContent = "×"
              destroyBtn.addEventListener("click", () => {
                // Find current index by value comparison (indices may have shifted)
                // biome-ignore lint/complexity/useIndexOf: ListRef doesn't have indexOf
                const currentIndex = doc.todos.findIndex(t => t === item)
                if (currentIndex >= 0) {
                  doc.todos.delete(currentIndex, 1)
                }
              })
              li.appendChild(destroyBtn)

              return li
            },
          },
          scope,
        )

        return todoList
      },
      whenFalse: () => {
        const emptyState = document.createElement("p")
        emptyState.className = "empty-state"
        emptyState.textContent = "No todos yet. Add one above!"
        return emptyState
      },
    },
    scope,
  )

  container.appendChild(main)

  // === Footer ===
  const footer = document.createElement("footer")
  footer.className = "footer"

  // Item count
  const countSpan = document.createElement("span")
  countSpan.className = "todo-count"
  __subscribeWithValue(
    doc.todos,
    () => {
      const count = doc.todos.toArray().length
      return `${count} item${count === 1 ? "" : "s"}`
    },
    text => {
      countSpan.textContent = text
    },
    scope,
  )
  footer.appendChild(countSpan)

  container.appendChild(footer)
}

// =============================================================================
// Tests
// =============================================================================

describe("Todo App Integration", () => {
  beforeEach(() => {
    __resetSubscriptionIdCounter()
    __resetScopeIdCounter()
  })

  describe("Initial render", () => {
    it("should render empty state when no todos", () => {
      const doc = createTypedDoc(todoSchema)
      const container = document.createElement("div")
      const scope = new Scope("test")

      renderTodoApp(doc, container, scope)

      // Should have header
      expect(container.querySelector("header")).not.toBeNull()
      expect(container.querySelector("h1")?.textContent).toBe("todos")

      // Should have input
      const input = container.querySelector(".new-todo") as HTMLInputElement
      expect(input).not.toBeNull()
      expect(input.placeholder).toBe("What needs to be done?")

      // Should show empty state
      expect(container.querySelector(".empty-state")).not.toBeNull()
      expect(container.querySelector(".todo-list")).toBeNull()

      // Should have footer with count
      expect(container.querySelector(".todo-count")?.textContent).toBe(
        "0 items",
      )

      scope.dispose()
    })

    it("should render todo list when items exist", () => {
      const doc = createTypedDoc(todoSchema)
      doc.todos.push("First todo")
      doc.todos.push("Second todo")

      const container = document.createElement("div")
      const scope = new Scope("test")

      renderTodoApp(doc, container, scope)

      // Should show list, not empty state
      expect(container.querySelector(".empty-state")).toBeNull()
      expect(container.querySelector(".todo-list")).not.toBeNull()

      // Should have two items
      const items = container.querySelectorAll('[data-testid="todo-item"]')
      expect(items.length).toBe(2)

      // Items should have correct text
      expect(items[0].querySelector("label")?.textContent).toBe("First todo")
      expect(items[1].querySelector("label")?.textContent).toBe("Second todo")

      // Footer should show count
      expect(container.querySelector(".todo-count")?.textContent).toBe(
        "2 items",
      )

      scope.dispose()
    })
  })

  describe("Adding todos", () => {
    it("should add a new todo via input binding and Enter key", () => {
      const doc = createTypedDoc(todoSchema)
      const container = document.createElement("div")
      const scope = new Scope("test")

      renderTodoApp(doc, container, scope)

      const input = container.querySelector(".new-todo") as HTMLInputElement

      // Type into input via Loro (simulating binding)
      doc.newTodoText.insert(0, "Buy groceries")

      // Dispatch Enter key
      const keyEvent = new dom.window.KeyboardEvent("keydown", { key: "Enter" })
      input.dispatchEvent(keyEvent)

      // Should have added a todo
      expect(doc.todos.toArray().length).toBe(1)
      expect(doc.todos.toArray()[0]).toBe("Buy groceries")

      // Input should be cleared
      expect(doc.newTodoText.toString()).toBe("")

      // UI should update
      const items = container.querySelectorAll('[data-testid="todo-item"]')
      expect(items.length).toBe(1)

      scope.dispose()
    })

    it("should not add empty todos", () => {
      const doc = createTypedDoc(todoSchema)
      const container = document.createElement("div")
      const scope = new Scope("test")

      renderTodoApp(doc, container, scope)

      const input = container.querySelector(".new-todo") as HTMLInputElement

      // Dispatch Enter without text
      const keyEvent = new dom.window.KeyboardEvent("keydown", { key: "Enter" })
      input.dispatchEvent(keyEvent)

      // Should not add a todo
      expect(doc.todos.toArray().length).toBe(0)

      // Whitespace-only should also be rejected
      doc.newTodoText.insert(0, "   ")
      input.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "Enter" }),
      )
      expect(doc.todos.toArray().length).toBe(0)

      scope.dispose()
    })

    it("should add multiple todos sequentially", () => {
      const doc = createTypedDoc(todoSchema)
      const container = document.createElement("div")
      const scope = new Scope("test")

      renderTodoApp(doc, container, scope)

      const input = container.querySelector(".new-todo") as HTMLInputElement

      // Add first todo
      doc.newTodoText.insert(0, "First")
      input.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "Enter" }),
      )

      // Add second todo
      doc.newTodoText.insert(0, "Second")
      input.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "Enter" }),
      )

      // Add third todo
      doc.newTodoText.insert(0, "Third")
      input.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "Enter" }),
      )

      // Should have all three
      expect(doc.todos.toArray().length).toBe(3)
      const items = container.querySelectorAll('[data-testid="todo-item"]')
      expect(items.length).toBe(3)

      scope.dispose()
    })
  })

  describe("Deleting todos", () => {
    it("should remove todo when delete button is clicked", () => {
      const doc = createTypedDoc(todoSchema)
      doc.todos.push("Todo to delete")

      const container = document.createElement("div")
      const scope = new Scope("test")

      renderTodoApp(doc, container, scope)

      expect(
        container.querySelectorAll('[data-testid="todo-item"]').length,
      ).toBe(1)

      // Click delete button
      const deleteBtn = container.querySelector(".destroy") as HTMLButtonElement
      deleteBtn.click()

      // Should remove from Loro
      expect(doc.todos.toArray().length).toBe(0)

      // UI should show empty state
      expect(container.querySelector(".empty-state")).not.toBeNull()
      expect(
        container.querySelectorAll('[data-testid="todo-item"]').length,
      ).toBe(0)

      scope.dispose()
    })

    it("should delete correct item when multiple exist", () => {
      const doc = createTypedDoc(todoSchema)
      doc.todos.push("First")
      doc.todos.push("Second")
      doc.todos.push("Third")

      const container = document.createElement("div")
      const scope = new Scope("test")

      renderTodoApp(doc, container, scope)

      // Delete the middle item
      const items = container.querySelectorAll('[data-testid="todo-item"]')
      const middleDeleteBtn = items[1].querySelector(
        ".destroy",
      ) as HTMLButtonElement
      middleDeleteBtn.click()

      // Should have First and Third remaining
      expect(doc.todos.toArray()).toEqual(["First", "Third"])

      const remainingItems = container.querySelectorAll(
        '[data-testid="todo-item"]',
      )
      expect(remainingItems.length).toBe(2)
      expect(remainingItems[0].querySelector("label")?.textContent).toBe(
        "First",
      )
      expect(remainingItems[1].querySelector("label")?.textContent).toBe(
        "Third",
      )

      scope.dispose()
    })
  })

  describe("O(k) verification", () => {
    // Single comprehensive O(k) test - detailed counting tests exist in integration.test.ts
    it("should achieve O(1) DOM operations for single insert", () => {
      const { container, counts, reset } = createCountingContainer("div")
      const doc = createTypedDoc(todoSchema)

      const scope = new Scope("test")
      renderTodoApp(doc, container, scope)

      // Reset counts after initial render
      reset()

      // Add a todo
      doc.todos.push("New todo")

      // Should be O(1) for the list insertion
      // Plus conditional region might switch from empty state to list
      assertMaxMutations(counts, {
        insertBefore: 3, // List item insertion + conditional region switch
        removeChild: 1, // Empty state removed
        appendChild: 4, // Building the new todo item (label, button) + list
      })

      scope.dispose()
    })

    it("should preserve DOM node identity when adding siblings (core O(k) invariant)", () => {
      const doc = createTypedDoc(todoSchema)
      doc.todos.push("Existing 1")
      doc.todos.push("Existing 2")

      const container = document.createElement("div")
      const scope = new Scope("test")

      renderTodoApp(doc, container, scope)

      // Get references to existing items
      const itemsBefore = container.querySelectorAll(
        '[data-testid="todo-item"]',
      )
      const firstItem = itemsBefore[0]
      const secondItem = itemsBefore[1]

      // Add a new item
      doc.todos.push("New item")

      // Existing items should be the same DOM nodes (not re-created)
      const itemsAfter = container.querySelectorAll('[data-testid="todo-item"]')
      expect(itemsAfter[0]).toBe(firstItem)
      expect(itemsAfter[1]).toBe(secondItem)
      expect(itemsAfter.length).toBe(3)

      scope.dispose()
    })
  })

  describe("Reactive updates", () => {
    it("should switch between empty state and list reactively", () => {
      const doc = createTypedDoc(todoSchema)
      const container = document.createElement("div")
      const scope = new Scope("test")

      renderTodoApp(doc, container, scope)

      // Initially empty
      expect(container.querySelector(".empty-state")).not.toBeNull()
      expect(container.querySelector(".todo-list")).toBeNull()

      // Add a todo
      doc.todos.push("First")

      // Should switch to list
      expect(container.querySelector(".empty-state")).toBeNull()
      expect(container.querySelector(".todo-list")).not.toBeNull()

      // Delete the todo
      doc.todos.delete(0, 1)

      // Should switch back to empty state
      expect(container.querySelector(".empty-state")).not.toBeNull()
      expect(container.querySelector(".todo-list")).toBeNull()

      scope.dispose()
    })

    it("should update item count reactively", () => {
      const doc = createTypedDoc(todoSchema)
      const container = document.createElement("div")
      const scope = new Scope("test")

      renderTodoApp(doc, container, scope)

      const countSpan = container.querySelector(".todo-count")
      expect(countSpan?.textContent).toBe("0 items")

      // Add items
      doc.todos.push("Item 1")
      expect(countSpan?.textContent).toBe("1 item")

      doc.todos.push("Item 2")
      expect(countSpan?.textContent).toBe("2 items")

      doc.todos.push("Item 3")
      expect(countSpan?.textContent).toBe("3 items")

      // Delete item
      doc.todos.delete(0, 1)
      expect(countSpan?.textContent).toBe("2 items")

      scope.dispose()
    })
  })

  describe("Input binding", () => {
    it("should sync input value with Loro text", () => {
      const doc = createTypedDoc(todoSchema)
      const container = document.createElement("div")
      const scope = new Scope("test")

      renderTodoApp(doc, container, scope)

      const input = container.querySelector(".new-todo") as HTMLInputElement

      // Initial state
      expect(input.value).toBe("")

      // Update Loro, should reflect in input
      doc.newTodoText.insert(0, "Hello")
      expect(input.value).toBe("Hello")

      scope.dispose()
    })

    it("should update Loro when typing in input", () => {
      const doc = createTypedDoc(todoSchema)
      const container = document.createElement("div")
      const scope = new Scope("test")

      renderTodoApp(doc, container, scope)

      const input = container.querySelector(".new-todo") as HTMLInputElement

      // Simulate typing by setting value and dispatching input event
      input.value = "Typed text"
      input.dispatchEvent(new dom.window.Event("input"))

      // Note: The binding updates Loro via the input event handler
      // This tests the bidirectional nature
      expect(doc.newTodoText.toString()).toBe("Typed text")

      scope.dispose()
    })
  })

  describe("Cleanup", () => {
    it("should not update DOM after scope disposal (critical memory safety)", () => {
      const doc = createTypedDoc(todoSchema)
      const container = document.createElement("div")
      const scope = new Scope("test")

      renderTodoApp(doc, container, scope)

      // Capture initial state
      const countSpan = container.querySelector(".todo-count")
      const initialCount = countSpan?.textContent
      expect(initialCount).toBe("0 items")

      // Dispose the scope
      scope.dispose()
      expect(scope.disposed).toBe(true)

      // Add items AFTER dispose - these should NOT trigger UI updates
      doc.todos.push("Item 1")
      doc.todos.push("Item 2")

      // CRITICAL: Count text should NOT have changed
      // This verifies subscriptions were actually cleaned up
      expect(countSpan?.textContent).toBe(initialCount)

      // No errors should occur - subscriptions are gone
      doc.todos.push("Item 3")
    })
  })

  describe("Edge cases", () => {
    it("should handle rapid add/delete operations", () => {
      const doc = createTypedDoc(todoSchema)
      const container = document.createElement("div")
      const scope = new Scope("test")

      renderTodoApp(doc, container, scope)

      // Rapid operations
      for (let i = 0; i < 10; i++) {
        doc.todos.push(`Item ${i}`)
      }

      expect(doc.todos.toArray().length).toBe(10)
      expect(
        container.querySelectorAll('[data-testid="todo-item"]').length,
      ).toBe(10)

      // Delete all
      for (let i = 9; i >= 0; i--) {
        doc.todos.delete(i, 1)
      }

      expect(doc.todos.toArray().length).toBe(0)
      expect(container.querySelector(".empty-state")).not.toBeNull()

      scope.dispose()
    })

    it("should handle special characters in todo text", () => {
      const doc = createTypedDoc(todoSchema)
      const container = document.createElement("div")
      const scope = new Scope("test")

      renderTodoApp(doc, container, scope)

      // Add todos with special characters
      doc.todos.push("<script>alert('xss')</script>")
      doc.todos.push("Todo with émojis 🎉")
      doc.todos.push("Quotes: \"double\" and 'single'")

      const items = container.querySelectorAll('[data-testid="todo-item"]')
      expect(items.length).toBe(3)

      // Text should be rendered (textContent is safe)
      expect(items[0].querySelector("label")?.textContent).toBe(
        "<script>alert('xss')</script>",
      )
      expect(items[1].querySelector("label")?.textContent).toBe(
        "Todo with émojis 🎉",
      )
      expect(items[2].querySelector("label")?.textContent).toBe(
        "Quotes: \"double\" and 'single'",
      )

      scope.dispose()
    })
  })
})
