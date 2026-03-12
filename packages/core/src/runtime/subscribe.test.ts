/**
 * Tests for subscribe.ts — subscription management using CHANGEFEED protocol.
 *
 * These tests use LocalRef from src/reactive (Phase 2) as the reactive
 * primitive, replacing the old @loro-extended/reactive types.
 */

import { CHANGEFEED, type ChangeBase, hasChangefeed } from "@kyneta/schema"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LocalRef, state } from "../reactive/local-ref.js"
import { resetScopeIdCounter, Scope } from "./scope.js"
import {
  activeSubscriptions,
  getActiveSubscriptionCount,
  getActiveSubscriptions,
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
    it("should subscribe to a LocalRef and receive changes", () => {
      const ref = state(0)
      const scope = new Scope()
      const handler = vi.fn()

      const id = subscribe(ref, handler, scope)

      expect(id).toBe(1)
      expect(getActiveSubscriptionCount()).toBe(1)

      // Make a change
      ref.set(42)

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0][0]).toEqual({
        type: "replace",
        value: 42,
      })

      scope.dispose()
    })

    it("should subscribe to a string LocalRef and receive changes", () => {
      const ref = state("hello")
      const scope = new Scope()
      const handler = vi.fn()

      subscribe(ref, handler, scope)

      ref.set("world")

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler.mock.calls[0][0]).toEqual({
        type: "replace",
        value: "world",
      })

      scope.dispose()
    })

    it("should receive multiple changes", () => {
      const ref = state(0)
      const scope = new Scope()
      const handler = vi.fn()

      subscribe(ref, handler, scope)

      ref.set(1)
      ref.set(2)
      ref.set(3)

      expect(handler).toHaveBeenCalledTimes(3)

      scope.dispose()
    })

    it("should unsubscribe when scope is disposed", () => {
      const ref = state(0)
      const scope = new Scope()
      const handler = vi.fn()

      subscribe(ref, handler, scope)

      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()

      expect(getActiveSubscriptionCount()).toBe(0)

      // Make a change after dispose
      ref.set(99)

      // Handler should not be called after dispose
      expect(handler).not.toHaveBeenCalled()
    })

    it("should return unique subscription IDs", () => {
      const ref = state(0)
      const scope = new Scope()

      const id1 = subscribe(ref, () => {}, scope)
      const id2 = subscribe(ref, () => {}, scope)
      const id3 = subscribe(ref, () => {}, scope)

      expect(id1).toBe(1)
      expect(id2).toBe(2)
      expect(id3).toBe(3)

      scope.dispose()
    })

    it("should track subscription in active subscriptions map", () => {
      const ref = state(0)
      const scope = new Scope()

      const id = subscribe(ref, () => {}, scope)

      expect(activeSubscriptions.has(id)).toBe(true)
      expect(activeSubscriptions.get(id)?.ref).toBe(ref)

      scope.dispose()

      expect(activeSubscriptions.has(id)).toBe(false)
    })
  })

  describe("unsubscribe", () => {
    it("should unsubscribe and return true for valid ID", () => {
      const ref = state(0)
      const scope = new Scope()

      const id = subscribe(ref, () => {}, scope)

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
      const ref = state(0)
      const scope = new Scope()

      const id = subscribe(ref, () => {}, scope)

      expect(unsubscribe(id)).toBe(true)
      expect(unsubscribe(id)).toBe(false)

      scope.dispose()
    })
  })

  describe("subscribeWithValue", () => {
    it("should call onValue immediately with initial value", () => {
      const ref = state("Hello")
      const scope = new Scope()

      const values: string[] = []
      subscribeWithValue(
        ref,
        () => ref.get(),
        value => values.push(value),
        scope,
      )

      expect(values).toEqual(["Hello"])

      scope.dispose()
    })

    it("should call onValue on subsequent changes", () => {
      const ref = state("")
      const scope = new Scope()

      const values: string[] = []
      subscribeWithValue(
        ref,
        () => ref.get(),
        value => values.push(value),
        scope,
      )

      expect(values).toEqual([""])

      ref.set("Hello")

      expect(values).toEqual(["", "Hello"])

      ref.set("Hello World")

      expect(values).toEqual(["", "Hello", "Hello World"])

      scope.dispose()
    })

    it("should stop receiving values after scope dispose", () => {
      const ref = state(0)
      const scope = new Scope()

      const values: number[] = []
      subscribeWithValue(
        ref,
        () => ref.get(),
        value => values.push(value),
        scope,
      )

      ref.set(1)

      expect(values).toEqual([0, 1])

      scope.dispose()

      ref.set(2)

      // Should not receive value after dispose
      expect(values).toEqual([0, 1])
    })

    it("should use the getValue closure, not CHANGEFEED.current", () => {
      // This tests the critical design: getValue evaluates the user's
      // expression, which may transform the raw ref value.
      const ref = state(5)
      const scope = new Scope()

      const values: string[] = []
      subscribeWithValue(
        ref,
        () => `count: ${ref.get()}`, // transformed expression
        value => values.push(value),
        scope,
      )

      expect(values).toEqual(["count: 5"])

      ref.set(10)

      expect(values).toEqual(["count: 5", "count: 10"])

      scope.dispose()
    })
  })

  describe("subscribeMultiple", () => {
    it("should subscribe to multiple refs", () => {
      const a = state("a")
      const b = state(0)
      const scope = new Scope()
      const handler = vi.fn()

      const ids = subscribeMultiple([a, b], handler, scope)

      expect(ids).toHaveLength(2)
      expect(getActiveSubscriptionCount()).toBe(2)

      scope.dispose()

      expect(getActiveSubscriptionCount()).toBe(0)
    })

    it("should call handler when any ref changes", () => {
      const a = state("a")
      const b = state(0)
      const scope = new Scope()
      const handler = vi.fn()

      subscribeMultiple([a, b], handler, scope)

      a.set("hello")

      expect(handler).toHaveBeenCalledTimes(1)

      b.set(5)

      expect(handler).toHaveBeenCalledTimes(2)

      scope.dispose()
    })
  })

  describe("subscription counter for testing", () => {
    it("should track active subscription count", () => {
      const a = state(1)
      const b = state(2)
      const c = state(3)
      const scope = new Scope()

      expect(getActiveSubscriptionCount()).toBe(0)

      subscribe(a, () => {}, scope)
      expect(getActiveSubscriptionCount()).toBe(1)

      subscribe(b, () => {}, scope)
      expect(getActiveSubscriptionCount()).toBe(2)

      subscribe(c, () => {}, scope)
      expect(getActiveSubscriptionCount()).toBe(3)

      scope.dispose()
      expect(getActiveSubscriptionCount()).toBe(0)
    })

    it("should reset counter with resetSubscriptionIdCounter", () => {
      const ref = state(0)
      const scope1 = new Scope()
      const scope2 = new Scope()

      const id1 = subscribe(ref, () => {}, scope1)
      expect(id1).toBe(1)

      scope1.dispose()
      resetSubscriptionIdCounter()

      const id2 = subscribe(ref, () => {}, scope2)
      expect(id2).toBe(1)

      scope2.dispose()
    })
  })

  describe("getActiveSubscriptions", () => {
    it("should return a read-only view", () => {
      const readOnly = getActiveSubscriptions()
      expect(readOnly).toBe(activeSubscriptions)
    })
  })

  describe("integration with scope hierarchy", () => {
    it("should unsubscribe child subscriptions when parent scope disposes", () => {
      const ref = state(0)
      const parentScope = new Scope()

      // Simulate list items with their own scopes
      const childScope1 = parentScope.createChild()
      const childScope2 = parentScope.createChild()

      subscribe(ref, () => {}, childScope1)
      subscribe(ref, () => {}, childScope2)

      expect(getActiveSubscriptionCount()).toBe(2)

      // Disposing parent should cascade to children
      parentScope.dispose()

      expect(getActiveSubscriptionCount()).toBe(0)
    })

    it("should allow nested scopes with independent subscriptions", () => {
      const a = state("a")
      const b = state(0)

      const root = new Scope()
      const child1 = root.createChild()
      const child2 = root.createChild()

      subscribe(a, () => {}, root)
      subscribe(a, () => {}, child1)
      subscribe(b, () => {}, child2)

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
    it("should subscribe to LocalRef and receive replace changes", () => {
      const ref = new LocalRef(0)
      const scope = new Scope()
      const changes: ChangeBase[] = []

      subscribe(ref, change => changes.push(change), scope)

      ref.set(1)
      ref.set(2)

      expect(changes).toEqual([
        { type: "replace", value: 1 },
        { type: "replace", value: 2 },
      ])

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
    it("should subscribe to custom changefeed type", () => {
      // Create a minimal custom changefeed type
      const listeners = new Set<(change: ChangeBase) => void>()
      const customReactive = {
        [CHANGEFEED]: {
          get current() {
            return null
          },
          subscribe(callback: (change: ChangeBase) => void): () => void {
            listeners.add(callback)
            return () => listeners.delete(callback)
          },
        },
      }

      const scope = new Scope()
      const received: ChangeBase[] = []

      subscribe(customReactive, change => received.push(change), scope)

      // Emit a change manually
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

    it("should throw for null", () => {
      const scope = new Scope()

      expect(() => {
        subscribe(null, () => {}, scope)
      }).toThrow("non-reactive")

      scope.dispose()
    })

    it("should throw for undefined", () => {
      const scope = new Scope()

      expect(() => {
        subscribe(undefined, () => {}, scope)
      }).toThrow("non-reactive")

      scope.dispose()
    })

    it("should throw for primitives", () => {
      const scope = new Scope()

      expect(() => {
        subscribe(42, () => {}, scope)
      }).toThrow("non-reactive")

      scope.dispose()
    })
  })
})