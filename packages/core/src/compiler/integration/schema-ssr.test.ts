/**
 * Schema-Driven Integration Tests
 *
 * Validates that core's runtime regions work end-to-end with real
 * schema-interpreted refs from @kyneta/schema. No mock refs — these
 * tests exercise the full path: schema definition → interpret →
 * subscribe → reactive DOM update.
 *
 * Requires the schema package to be built (`npx tsup` in packages/schema).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  Schema,
  LoroSchema,
  interpret,

  bottomInterpreter,
  withReadable,
  withCaching,
  withWritable,
  createWritableContext,
  withChangefeed,
  hasChangefeed,
  CHANGEFEED,
  Zero,
  isIncrementChange,
} from "@kyneta/schema"
import type {
  Readable,
  Writable,
  ReadableSequenceRef,
} from "@kyneta/schema"

import {
  subscribe,
  textRegion,
  listRegion,
  conditionalRegion,
  read,
  valueRegion,
  Scope,
} from "../../runtime/index.js"
import {
  activeSubscriptions,
  getActiveSubscriptionCount,
  resetSubscriptionIdCounter,
  resetScopeIdCounter,
  createCountingContainer,
  assertMaxMutations,
} from "../../testing/index.js"
import { installDOMGlobals, resetTestState } from "./helpers.js"

// ---------------------------------------------------------------------------
// JSDOM setup
// ---------------------------------------------------------------------------

installDOMGlobals()

// ---------------------------------------------------------------------------
// Schema fixture
// ---------------------------------------------------------------------------

const todoSchema = LoroSchema.doc({
  title: LoroSchema.text(),
  count: LoroSchema.counter(),
  items: Schema.list(
    Schema.struct({
      text: LoroSchema.text(),
      done: LoroSchema.plain.boolean(),
    }),
  ),
})

const writableInterpreter = withWritable(withCaching(withReadable(bottomInterpreter)))

function createDoc(storeOverrides: Record<string, unknown> = {}) {
  const store = {
    ...Zero.structural(todoSchema),
    ...storeOverrides,
  } as Record<string, unknown>
  const ctx = createWritableContext(store)
  const enriched = withChangefeed(writableInterpreter)
  const doc = interpret(todoSchema, enriched, ctx) as Readable<
    typeof todoSchema
  > &
    Writable<typeof todoSchema>
  return { doc, store, ctx }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("schema-driven integration tests", () => {
  beforeEach(() => {
    resetTestState()
  })

  afterEach(() => {
    activeSubscriptions.clear()
  })

  // =========================================================================
  // Fixture sanity checks
  // =========================================================================

  describe("schema ref shapes", () => {
    it("should produce callable refs with [CHANGEFEED]", () => {
      const { doc } = createDoc({ title: "Hello" })

      // Text ref is callable
      expect(typeof doc.title).toBe("function")
      expect((doc.title as unknown as () => string)()).toBe("Hello")

      // Counter ref is callable
      expect(typeof doc.count).toBe("function")
      expect((doc.count as unknown as () => number)()).toBe(0)

      // All have CHANGEFEED
      expect(hasChangefeed(doc.title)).toBe(true)
      expect(hasChangefeed(doc.count)).toBe(true)
      expect(hasChangefeed(doc.items)).toBe(true)

      // CHANGEFEED is non-enumerable
      expect(Object.keys(doc)).not.toContain(CHANGEFEED)
    })

    it("should read current values via read() helper", () => {
      const { doc } = createDoc({ title: "World", count: 5 })

      expect(read(doc.title as any)).toBe("World")
      expect(read(doc.count as any)).toBe(5)
    })
  })

  // =========================================================================
  // textRegion with schema text ref
  // =========================================================================

  describe("textRegion with schema text ref", () => {
    it("should set initial text content", () => {
      const { doc } = createDoc({ title: "Hello" })
      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, doc.title, scope)

      expect(textNode.textContent).toBe("Hello")

      scope.dispose()
    })

    it("should update surgically via insertData on text insert", () => {
      const { doc } = createDoc({ title: "Hello" })
      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, doc.title, scope)
      expect(textNode.textContent).toBe("Hello")

      // Track insertData calls
      let insertDataCalled = false
      const origInsertData = textNode.insertData.bind(textNode)
      textNode.insertData = (offset: number, data: string) => {
        insertDataCalled = true
        origInsertData(offset, data)
      }

      // Insert " World" at position 5
      doc.title.insert(5, " World")

      expect(insertDataCalled).toBe(true)
      expect(textNode.textContent).toBe("Hello World")

      scope.dispose()
    })

    it("should update surgically via deleteData on text delete", () => {
      const { doc } = createDoc({ title: "Hello World" })
      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, doc.title, scope)
      expect(textNode.textContent).toBe("Hello World")

      let deleteDataCalled = false
      const origDeleteData = textNode.deleteData.bind(textNode)
      textNode.deleteData = (offset: number, count: number) => {
        deleteDataCalled = true
        origDeleteData(offset, count)
      }

      // Delete " World" (5 chars starting at position 5)
      doc.title.delete(5, 6)

      expect(deleteDataCalled).toBe(true)
      expect(textNode.textContent).toBe("Hello")

      scope.dispose()
    })
  })

  // =========================================================================
  // valueRegion with schema counter ref
  // =========================================================================

  describe("valueRegion with schema counter ref", () => {
    it("should set initial value and update on increment", () => {
      const { doc } = createDoc({ count: 0 })
      const scope = new Scope()
      const textNode = document.createTextNode("")

      valueRegion(
        [doc.count],
        () => read(doc.count as any),
        (v) => {
          textNode.textContent = String(v)
        },
        scope,
      )

      expect(textNode.textContent).toBe("0")

      doc.count.increment(1)
      expect(textNode.textContent).toBe("1")

      doc.count.increment(5)
      expect(textNode.textContent).toBe("6")

      scope.dispose()
    })

    it("should emit IncrementChange (not ReplaceChange)", () => {
      const { doc } = createDoc({ count: 0 })
      const scope = new Scope()
      const changes: any[] = []

      subscribe(
        doc.count,
        (change) => changes.push(change),
        scope,
      )

      doc.count.increment(3)

      expect(changes).toHaveLength(1)
      expect(isIncrementChange(changes[0])).toBe(true)
      expect(changes[0].type).toBe("increment")
      expect(changes[0].amount).toBe(3)

      scope.dispose()
    })
  })

  // =========================================================================
  // listRegion with schema sequence ref
  // =========================================================================

  describe("listRegion with schema sequence ref", () => {
    it("should render initial items", () => {
      const { doc } = createDoc({
        items: [
          { text: "Buy milk", done: false },
          { text: "Write tests", done: true },
        ],
      })
      const scope = new Scope()
      const container = document.createElement("div")

      listRegion(
        container,
        doc.items,
        {
          create: (item: any) => {
            const li = document.createElement("li")
            li.textContent = (item.text as unknown as () => string)()
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(2)
      expect(container.children[0].textContent).toBe("Buy milk")
      expect(container.children[1].textContent).toBe("Write tests")

      scope.dispose()
    })

    it("should add a DOM element on push", () => {
      const { doc } = createDoc({
        items: [{ text: "First", done: false }],
      })
      const scope = new Scope()
      const container = document.createElement("div")

      listRegion(
        container,
        doc.items,
        {
          create: (item: any) => {
            const li = document.createElement("li")
            li.textContent = (item.text as unknown as () => string)()
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(1)

      doc.items.push({ text: "Second", done: false } as any)

      expect(container.children.length).toBe(2)
      expect(container.children[1].textContent).toBe("Second")

      scope.dispose()
    })

    it("should satisfy ListRefLike<T> structurally", () => {
      const { doc } = createDoc({
        items: [
          { text: "A", done: false },
          { text: "B", done: true },
        ],
      })

      // ListRefLike requires .length and .at(index)
      const ref = doc.items as unknown as { length: number; at(i: number): unknown }
      expect(typeof ref.length).toBe("number")
      expect(ref.length).toBe(2)
      expect(typeof ref.at).toBe("function")

      // .at() returns child refs that are themselves callable with [CHANGEFEED]
      const child = ref.at(0) as any
      expect(child).toBeDefined()
      expect(hasChangefeed(child)).toBe(true)

      // Child ref's text field is itself a callable text ref
      expect(typeof child.text).toBe("function")
      expect((child.text as unknown as () => string)()).toBe("A")
      expect(hasChangefeed(child.text)).toBe(true)
    })
  })

  // =========================================================================
  // conditionalRegion with schema counter ref
  // =========================================================================

  describe("conditionalRegion with schema counter ref", () => {
    it("should swap branches on condition change", () => {
      const { doc } = createDoc({ count: 0 })
      const scope = new Scope()
      const container = document.createElement("div")
      const marker = document.createComment("cond")
      container.appendChild(marker)

      conditionalRegion(
        marker,
        doc.count,
        () => (read(doc.count as any) as number) > 0,
        {
          whenTrue: () => {
            const el = document.createElement("span")
            el.textContent = "Has items"
            return el
          },
          whenFalse: () => {
            const el = document.createElement("span")
            el.textContent = "Empty"
            return el
          },
        },
        scope,
      )

      // Initial: count is 0 → false branch
      expect(container.textContent).toContain("Empty")

      // Increment → true branch
      doc.count.increment(1)
      expect(container.textContent).toContain("Has items")
      expect(container.textContent).not.toContain("Empty")

      scope.dispose()
    })
  })

  // =========================================================================
  // O(k) list verification with schema sequence ref
  // =========================================================================

  describe("O(k) list operations", () => {
    it("should perform O(1) insertBefore for a single push on a 10-item list", () => {
      const initialItems = Array.from({ length: 10 }, (_, i) => ({
        text: `Item ${i}`,
        done: false,
      }))

      const { doc } = createDoc({ items: initialItems })
      const scope = new Scope()
      const { container, counts, reset } = createCountingContainer()

      listRegion(
        container,
        doc.items,
        {
          create: (item: any) => {
            const li = document.createElement("li")
            li.textContent = (item.text as unknown as () => string)()
            return li
          },
        },
        scope,
      )

      expect(container.childNodes.length).toBe(10)

      // Reset counts after initial render so we only measure the push
      reset()

      // Push a single item
      doc.items.push({ text: "New item", done: false } as any)

      // Exactly 1 insertBefore for the new item
      expect(counts.insertBefore).toBe(1)

      expect(container.childNodes.length).toBe(11)
      expect(
        (container.childNodes[10] as HTMLElement).textContent,
      ).toBe("New item")

      scope.dispose()
    })
  })

  // =========================================================================
  // Scope disposal stops schema ref subscriptions
  // =========================================================================

  describe("scope disposal", () => {
    it("should stop textRegion subscription on dispose", () => {
      const { doc } = createDoc({ title: "Hello" })
      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, doc.title, scope)
      expect(textNode.textContent).toBe("Hello")
      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()
      expect(getActiveSubscriptionCount()).toBe(0)

      // Mutation after dispose should NOT update the text node
      doc.title.insert(5, " World")
      expect(textNode.textContent).toBe("Hello")
    })

    it("should stop listRegion subscription on dispose", () => {
      const { doc } = createDoc({
        items: [{ text: "A", done: false }],
      })
      const scope = new Scope()
      const container = document.createElement("div")

      listRegion(
        container,
        doc.items,
        {
          create: (item: any) => {
            const li = document.createElement("li")
            li.textContent = (item.text as unknown as () => string)()
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(1)
      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()
      expect(getActiveSubscriptionCount()).toBe(0)

      // Mutation after dispose should NOT update the DOM
      doc.items.push({ text: "B", done: false } as any)
      expect(container.children.length).toBe(1)
    })

    it("should stop valueRegion subscription on dispose", () => {
      const { doc } = createDoc({ count: 0 })
      const scope = new Scope()
      const textNode = document.createTextNode("")

      valueRegion(
        [doc.count],
        () => read(doc.count as any),
        (v) => {
          textNode.textContent = String(v)
        },
        scope,
      )

      expect(textNode.textContent).toBe("0")
      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()
      expect(getActiveSubscriptionCount()).toBe(0)

      doc.count.increment(1)
      expect(textNode.textContent).toBe("0")
    })
  })
})