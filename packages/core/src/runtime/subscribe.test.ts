/**
 * Tests for subscribe.ts — subscription management using CHANGEFEED protocol.
 *
 * These tests use LocalRef from src/reactive (Phase 2) as the reactive
 * primitive, replacing the old @loro-extended/reactive types.
 */

import { CHANGEFEED, type ChangeBase } from "@kyneta/schema"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { state } from "../reactive/local-ref.js"
import { resetScopeIdCounter, Scope } from "./scope.js"
import {
  activeSubscriptions,
  getActiveSubscriptionCount,
  resetSubscriptionIdCounter,
  read,
  subscribe,
  unsubscribe,
  valueRegion,
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

  describe("read", () => {
    it("should read the current value from a LocalRef", () => {
      const ref = state(42)
      expect(read(ref)).toBe(42)
    })

    it("should read updated values after set", () => {
      const ref = state("hello")
      expect(read(ref)).toBe("hello")
      ref.set("world")
      expect(read(ref)).toBe("world")
    })

    it("should read from a custom changefeed type", () => {
      const customReactive = {
        [CHANGEFEED]: {
          get current() {
            return "custom-value"
          },
          subscribe(): () => void {
            return () => {}
          },
        },
      }

      expect(read(customReactive)).toBe("custom-value")
    })
  })

  describe("valueRegion", () => {
    beforeEach(() => {
      resetSubscriptionIdCounter()
      resetScopeIdCounter()
      activeSubscriptions.clear()
    })

    afterEach(() => {
      activeSubscriptions.clear()
    })

    it("should call onValue immediately with initial value (single ref)", () => {
      const ref = state("Hello")
      const scope = new Scope()

      const values: string[] = []
      valueRegion(
        [ref],
        () => ref(),
        value => values.push(value),
        scope,
      )

      expect(values).toEqual(["Hello"])

      scope.dispose()
    })

    it("should call onValue on subsequent changes (single ref)", () => {
      const ref = state("")
      const scope = new Scope()

      const values: string[] = []
      valueRegion(
        [ref],
        () => ref(),
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

    it("should fire on any ref's change and re-evaluate getValue (multiple refs)", () => {
      const firstName = state("Ada")
      const lastName = state("Lovelace")
      const scope = new Scope()

      const values: string[] = []
      valueRegion(
        [firstName, lastName],
        () => `${firstName()} ${lastName()}`,
        value => values.push(value),
        scope,
      )

      expect(values).toEqual(["Ada Lovelace"])

      firstName.set("Grace")
      expect(values).toEqual(["Ada Lovelace", "Grace Lovelace"])

      lastName.set("Hopper")
      expect(values).toEqual(["Ada Lovelace", "Grace Lovelace", "Grace Hopper"])

      scope.dispose()
    })

    it("should stop updates after scope disposal", () => {
      const ref = state(0)
      const scope = new Scope()

      const values: number[] = []
      valueRegion(
        [ref],
        () => ref(),
        value => values.push(value),
        scope,
      )

      ref.set(1)
      expect(values).toEqual([0, 1])

      scope.dispose()

      ref.set(2)
      // Should not receive value after dispose
      expect(values).toEqual([0, 1])
      expect(getActiveSubscriptionCount()).toBe(0)
    })

    it("should set initial value only with empty refs array (no subscriptions)", () => {
      const scope = new Scope()

      const values: string[] = []
      valueRegion(
        [],
        () => "static-value",
        value => values.push(value),
        scope,
      )

      expect(values).toEqual(["static-value"])
      expect(getActiveSubscriptionCount()).toBe(0)

      scope.dispose()
    })

    it("should use the getValue closure for transformed expressions", () => {
      const ref = state(5)
      const scope = new Scope()

      const values: string[] = []
      valueRegion(
        [ref],
        () => `count: ${ref()}`,
        value => values.push(value),
        scope,
      )

      expect(values).toEqual(["count: 5"])

      ref.set(10)
      expect(values).toEqual(["count: 5", "count: 10"])

      scope.dispose()
    })

    it("should clean up all subscriptions for multiple refs on dispose", () => {
      const a = state("a")
      const b = state(0)
      const c = state(true)
      const scope = new Scope()

      valueRegion(
        [a, b, c],
        () => `${a()}-${b()}-${c()}`,
        () => {},
        scope,
      )

      expect(getActiveSubscriptionCount()).toBe(3)

      scope.dispose()

      expect(getActiveSubscriptionCount()).toBe(0)
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

    it.each([
      { description: "non-reactive object", value: { foo: "bar" } },
      { description: "null", value: null },
      { description: "undefined", value: undefined },
      { description: "primitive", value: 42 },
    ])("should throw for $description", ({ value }) => {
      const scope = new Scope()

      expect(() => {
        subscribe(value, () => {}, scope)
      }).toThrow("non-reactive")

      scope.dispose()
    })
  })
})