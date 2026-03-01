import { createTypedDoc, loro, Shape } from "@loro-extended/change"
import {
  LocalRef,
  REACTIVE,
  type ReactiveDelta,
  type ReactiveSubscribe,
} from "@loro-extended/reactive"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetScopeIdCounter, Scope } from "./scope.js"
import {
  activeSubscriptions,
  getActiveSubscriptionCount,
  resetSubscriptionIdCounter,
  subscribe,
  subscribeMultiple,
  subscribeWithValue,
  unsubscribe,
} from "./subscribe.js"

describe("subscribe", () => {
  beforeEach(() => {
    resetSubscriptionIdCounter()
    resetScopeIdCounter()
    activeSubscriptions.clear()
  })

  afterEach(() => {
    activeSubscriptions.clear()
  })

  describe("subscribe", () => {
    it("should subscribe to a TextRef and receive events", () => {
      const schema = Shape.doc({ title: Shape.text() })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const handler = vi.fn()

      const id = subscribe(doc.title, handler, scope)

      expect(id).toBe(1)
      expect(getActiveSubscriptionCount()).toBe(1)

      // Make a change
      doc.title.insert(0, "Hello")
      loro(doc).commit()

      expect(handler).toHaveBeenCalled()

      scope.dispose()
    })

    it("should subscribe to a CounterRef and receive events", () => {
      const schema = Shape.doc({ count: Shape.counter() })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const handler = vi.fn()

      subscribe(doc.count, handler, scope)

      doc.count.increment(5)
      loro(doc).commit()

      expect(handler).toHaveBeenCalled()

      scope.dispose()
    })

    it("should subscribe to a ListRef and receive events", () => {
      const schema = Shape.doc({ items: Shape.list(Shape.plain.string()) })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const handler = vi.fn()

      subscribe(doc.items, handler, scope)

      doc.items.push("item1")
      loro(doc).commit()

      expect(handler).toHaveBeenCalled()

      scope.dispose()
    })

    it("should unsubscribe when scope is disposed", () => {
      const schema = Shape.doc({ title: Shape.text() })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const handler = vi.fn()

      subscribe(doc.title, handler, scope)

      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()

      expect(getActiveSubscriptionCount()).toBe(0)

      // Make a change after dispose
      doc.title.insert(0, "Hello")
      loro(doc).commit()

      // Handler should not be called after dispose
      expect(handler).not.toHaveBeenCalled()
    })

    it("should return unique subscription IDs", () => {
      const schema = Shape.doc({ title: Shape.text() })
      const doc = createTypedDoc(schema)
      const scope = new Scope()

      const id1 = subscribe(doc.title, () => {}, scope)
      const id2 = subscribe(doc.title, () => {}, scope)
      const id3 = subscribe(doc.title, () => {}, scope)

      expect(id1).toBe(1)
      expect(id2).toBe(2)
      expect(id3).toBe(3)

      scope.dispose()
    })

    it("should track subscription in active subscriptions map", () => {
      const schema = Shape.doc({ title: Shape.text() })
      const doc = createTypedDoc(schema)
      const scope = new Scope()

      const id = subscribe(doc.title, () => {}, scope)

      expect(activeSubscriptions.has(id)).toBe(true)
      expect(activeSubscriptions.get(id)?.ref).toBe(doc.title)

      scope.dispose()

      expect(activeSubscriptions.has(id)).toBe(false)
    })
  })

  describe("unsubscribe", () => {
    it("should unsubscribe and return true for valid ID", () => {
      const schema = Shape.doc({ title: Shape.text() })
      const doc = createTypedDoc(schema)
      const scope = new Scope()

      const id = subscribe(doc.title, () => {}, scope)

      expect(getActiveSubscriptionCount()).toBe(1)

      const result = unsubscribe(id)

      expect(result).toBe(true)
      expect(getActiveSubscriptionCount()).toBe(0)

      // Clean up scope (subscription already removed)
      scope.dispose()
    })

    it("should return false for invalid ID", () => {
      const result = unsubscribe(999)

      expect(result).toBe(false)
    })

    it("should return false when called twice with same ID", () => {
      const schema = Shape.doc({ title: Shape.text() })
      const doc = createTypedDoc(schema)
      const scope = new Scope()

      const id = subscribe(doc.title, () => {}, scope)

      expect(unsubscribe(id)).toBe(true)
      expect(unsubscribe(id)).toBe(false)

      scope.dispose()
    })
  })

  describe("subscribeWithValue", () => {
    it("should call onValue immediately with initial value", () => {
      const schema = Shape.doc({ title: Shape.text() })
      const doc = createTypedDoc(schema)
      const scope = new Scope()

      doc.title.insert(0, "Hello")
      loro(doc).commit()

      const values: string[] = []
      subscribeWithValue(
        doc.title,
        () => doc.title.toString(),
        value => values.push(value),
        scope,
      )

      expect(values).toEqual(["Hello"])

      scope.dispose()
    })

    it("should call onValue on subsequent changes", () => {
      const schema = Shape.doc({ title: Shape.text() })
      const doc = createTypedDoc(schema)
      const scope = new Scope()

      const values: string[] = []
      subscribeWithValue(
        doc.title,
        () => doc.title.toString(),
        value => values.push(value),
        scope,
      )

      expect(values).toEqual([""])

      doc.title.insert(0, "Hello")
      loro(doc).commit()

      expect(values).toEqual(["", "Hello"])

      doc.title.insert(5, " World")
      loro(doc).commit()

      expect(values).toEqual(["", "Hello", "Hello World"])

      scope.dispose()
    })

    it("should stop receiving values after scope dispose", () => {
      const schema = Shape.doc({ count: Shape.counter() })
      const doc = createTypedDoc(schema)
      const scope = new Scope()

      const values: number[] = []
      subscribeWithValue(
        doc.count,
        () => doc.count.get(),
        value => values.push(value),
        scope,
      )

      doc.count.increment(1)
      loro(doc).commit()

      expect(values).toEqual([0, 1])

      scope.dispose()

      doc.count.increment(1)
      loro(doc).commit()

      // Should not receive value after dispose
      expect(values).toEqual([0, 1])
    })
  })

  describe("subscribeMultiple", () => {
    it("should subscribe to multiple refs", () => {
      const schema = Shape.doc({
        title: Shape.text(),
        count: Shape.counter(),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const handler = vi.fn()

      const ids = subscribeMultiple([doc.title, doc.count], handler, scope)

      expect(ids).toHaveLength(2)
      expect(getActiveSubscriptionCount()).toBe(2)

      scope.dispose()

      expect(getActiveSubscriptionCount()).toBe(0)
    })

    it("should call handler when any ref changes", () => {
      const schema = Shape.doc({
        title: Shape.text(),
        count: Shape.counter(),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const handler = vi.fn()

      subscribeMultiple([doc.title, doc.count], handler, scope)

      doc.title.insert(0, "Hello")
      loro(doc).commit()

      expect(handler).toHaveBeenCalledTimes(1)

      doc.count.increment(5)
      loro(doc).commit()

      expect(handler).toHaveBeenCalledTimes(2)

      scope.dispose()
    })
  })

  describe("subscription counter for testing", () => {
    it("should track active subscription count", () => {
      const schema = Shape.doc({
        a: Shape.text(),
        b: Shape.text(),
        c: Shape.text(),
      })
      const doc = createTypedDoc(schema)
      const scope = new Scope()

      expect(getActiveSubscriptionCount()).toBe(0)

      subscribe(doc.a, () => {}, scope)
      expect(getActiveSubscriptionCount()).toBe(1)

      subscribe(doc.b, () => {}, scope)
      expect(getActiveSubscriptionCount()).toBe(2)

      subscribe(doc.c, () => {}, scope)
      expect(getActiveSubscriptionCount()).toBe(3)

      scope.dispose()
      expect(getActiveSubscriptionCount()).toBe(0)
    })

    it("should reset counter with resetSubscriptionIdCounter", () => {
      const schema = Shape.doc({ title: Shape.text() })
      const doc = createTypedDoc(schema)
      const scope1 = new Scope()
      const scope2 = new Scope()

      const id1 = subscribe(doc.title, () => {}, scope1)
      expect(id1).toBe(1)

      scope1.dispose()
      resetSubscriptionIdCounter()

      const id2 = subscribe(doc.title, () => {}, scope2)
      expect(id2).toBe(1)

      scope2.dispose()
    })
  })

  describe("integration with scope hierarchy", () => {
    it("should unsubscribe child subscriptions when parent scope disposes", () => {
      const schema = Shape.doc({
        items: Shape.list(Shape.struct({ name: Shape.plain.string() })),
      })
      const doc = createTypedDoc(schema)
      const parentScope = new Scope("parent")

      // Simulate list items with their own scopes
      const childScope1 = parentScope.createChild()
      const childScope2 = parentScope.createChild()

      subscribe(doc.items, () => {}, childScope1)
      subscribe(doc.items, () => {}, childScope2)

      expect(getActiveSubscriptionCount()).toBe(2)

      // Disposing parent should cascade to children
      parentScope.dispose()

      expect(getActiveSubscriptionCount()).toBe(0)
    })

    it("should allow nested scopes with independent subscriptions", () => {
      const schema = Shape.doc({
        title: Shape.text(),
        count: Shape.counter(),
      })
      const doc = createTypedDoc(schema)

      const root = new Scope("root")
      const child1 = root.createChild()
      const child2 = root.createChild()

      subscribe(doc.title, () => {}, root)
      subscribe(doc.title, () => {}, child1)
      subscribe(doc.count, () => {}, child2)

      expect(getActiveSubscriptionCount()).toBe(3)

      // Dispose one child
      child1.dispose()
      expect(getActiveSubscriptionCount()).toBe(2)

      // Dispose root (cascades to remaining child)
      root.dispose()
      expect(getActiveSubscriptionCount()).toBe(0)
    })
  })

  describe("LocalRef support", () => {
    it("should subscribe to LocalRef and receive replace deltas", () => {
      const ref = new LocalRef(0)
      const scope = new Scope()
      const deltas: ReactiveDelta[] = []

      subscribe(ref, delta => deltas.push(delta), scope)

      ref.set(1)
      ref.set(2)

      expect(deltas).toEqual([{ type: "replace" }, { type: "replace" }])

      scope.dispose()
    })

    it("should work with subscribeWithValue for LocalRef", () => {
      const ref = new LocalRef("initial")
      const scope = new Scope()
      const values: string[] = []

      subscribeWithValue(
        ref,
        () => ref.get(),
        value => values.push(value),
        scope,
      )

      expect(values).toEqual(["initial"])

      ref.set("updated")

      expect(values).toEqual(["initial", "updated"])

      scope.dispose()
    })

    it("should unsubscribe LocalRef when scope is disposed", () => {
      const ref = new LocalRef(0)
      const scope = new Scope()
      const handler = vi.fn()

      subscribe(ref, handler, scope)

      ref.set(1)
      expect(handler).toHaveBeenCalledTimes(1)

      scope.dispose()

      ref.set(2)
      expect(handler).toHaveBeenCalledTimes(1) // No additional calls
    })
  })

  describe("custom reactive types", () => {
    it("should subscribe to custom reactive type", () => {
      // Create a minimal custom reactive type
      const listeners = new Set<(delta: ReactiveDelta) => void>()
      const customReactive = {
        [REACTIVE]: ((
          self: unknown,
          callback: (delta: ReactiveDelta) => void,
        ) => {
          listeners.add(callback)
          return () => listeners.delete(callback)
        }) as ReactiveSubscribe,
      }

      const scope = new Scope()
      const received: ReactiveDelta[] = []

      subscribe(customReactive, delta => received.push(delta), scope)

      // Emit a delta manually
      listeners.forEach(cb => cb({ type: "replace" }))

      expect(received).toEqual([{ type: "replace" }])

      scope.dispose()

      // Should be unsubscribed
      expect(listeners.size).toBe(0)
    })

    it("should throw for non-reactive values", () => {
      const scope = new Scope()
      const notReactive = { foo: "bar" }

      expect(() => {
        subscribe(notReactive, () => {}, scope)
      }).toThrow("non-reactive")

      scope.dispose()
    })
  })
})
