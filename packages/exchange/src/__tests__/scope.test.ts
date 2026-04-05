// scope — unit tests for three-valued predicate composition and ScopeRegistry.
//
// Architecture mirrors scope.ts: pure function tests first (composeRule),
// then imperative shell tests (ScopeRegistry).

import { describe, expect, it, vi } from "vitest"
import type { PeerIdentityDetails } from "@kyneta/transport"
import type { Classify } from "../exchange.js"
import { composeRule, ScopeRegistry, type Scope } from "../scope.js"
import { bindPlain, Interpret, Reject, Schema } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const peer = (id: string): PeerIdentityDetails => ({
  peerId: id,
  type: "user",
})

const doc = "doc:test"
const alice = peer("alice")

// ---------------------------------------------------------------------------
// Pure function: composeRule
// ---------------------------------------------------------------------------

describe("composeRule", () => {
  describe("defaultWhenAllUndefined: true (open by default)", () => {
    const compose = (scopes: Scope[]) =>
      composeRule(scopes, "route", doc, alice, true)

    it("single scope returning true → true", () => {
      expect(compose([{ route: () => true }])).toBe(true)
    })

    it("single scope returning false → false", () => {
      expect(compose([{ route: () => false }])).toBe(false)
    })

    it("single scope returning undefined → true (default open)", () => {
      expect(compose([{ route: () => undefined }])).toBe(true)
    })

    it("deny wins regardless of order", () => {
      expect(
        compose([{ route: () => true }, { route: () => false }]),
      ).toBe(false)
      expect(
        compose([{ route: () => false }, { route: () => true }]),
      ).toBe(false)
    })

    it("true and undefined → true", () => {
      expect(
        compose([{ route: () => undefined }, { route: () => true }]),
      ).toBe(true)
    })

    it("all undefined → default", () => {
      expect(
        compose([{ route: () => undefined }, { route: () => undefined }]),
      ).toBe(true)
    })

    it("short-circuits on false — subsequent scopes not evaluated", () => {
      const second = vi.fn(() => true as boolean | undefined)
      compose([{ route: () => false }, { route: second }])
      expect(second).not.toHaveBeenCalled()
    })

    it("scopes without the evaluated field are transparent", () => {
      // A scope with only `authorize` should not affect `route` composition
      expect(compose([{ authorize: () => false }])).toBe(true)
    })
  })

  describe("defaultWhenAllUndefined: false (closed by default)", () => {
    const compose = (scopes: Scope[]) =>
      composeRule(scopes, "route", doc, alice, false)

    it("all undefined → false", () => {
      expect(
        compose([{ route: () => undefined }, { route: () => undefined }]),
      ).toBe(false)
    })

    it("single true overrides closed default", () => {
      expect(
        compose([{ route: () => true }, { route: () => undefined }]),
      ).toBe(true)
    })
  })

  it("empty scopes array → defaultWhenAllUndefined", () => {
    expect(composeRule([], "route", doc, alice, true)).toBe(true)
    expect(composeRule([], "route", doc, alice, false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Imperative shell: ScopeRegistry
// ---------------------------------------------------------------------------

describe("ScopeRegistry", () => {
  // -----------------------------------------------------------------------
  // Lifecycle: register, dispose, clear
  // -----------------------------------------------------------------------

  describe("lifecycle", () => {
    it("register → compose reflects scope; dispose → reverts to default", () => {
      const registry = new ScopeRegistry()
      const dispose = registry.register({ route: () => false })
      expect(registry.route(doc, alice)).toBe(false)
      dispose()
      expect(registry.route(doc, alice)).toBe(true)
    })

    it("dispose is idempotent", () => {
      const registry = new ScopeRegistry()
      const dispose = registry.register({ route: () => false })
      dispose()
      dispose() // must not throw or corrupt state
      expect(registry.route(doc, alice)).toBe(true)
    })

    it("clear() removes all scopes and resets named scope map", () => {
      const registry = new ScopeRegistry()
      registry.register({ name: "a", route: () => false })
      registry.register({ authorize: () => false })
      registry.clear()

      expect(registry.route(doc, alice)).toBe(true)
      expect(registry.authorize(doc, alice)).toBe(true)
      expect(registry.names).toEqual([])

      // Re-registering a name after clear should work fresh (not hit
      // the replacement path with a stale reference)
      registry.register({ name: "a", route: () => false })
      expect(registry.route(doc, alice)).toBe(false)
      expect(registry.names).toEqual(["a"])
    })

    it("adding a scope after initial registration affects live composition", () => {
      const registry = new ScopeRegistry()
      registry.register({ route: () => true })
      expect(registry.route(doc, alice)).toBe(true)

      const dispose = registry.register({ route: () => false })
      expect(registry.route(doc, alice)).toBe(false)

      dispose()
      expect(registry.route(doc, alice)).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Named scopes: replacement, order preservation, dispose-after-replace
  // -----------------------------------------------------------------------

  describe("named scopes", () => {
    it("names reflects registered named scopes in order", () => {
      const registry = new ScopeRegistry()
      registry.register({ route: () => true }) // unnamed
      registry.register({ name: "b", route: () => true })
      registry.register({ name: "a", route: () => true })
      expect(registry.names).toEqual(["b", "a"])
    })

    it("same-name registration replaces in-place, preserving evaluation order", () => {
      const registry = new ScopeRegistry()
      const order: string[] = []

      registry.register({
        name: "first",
        route: () => {
          order.push("first")
          return undefined
        },
      })
      registry.register({
        name: "second",
        route: () => {
          order.push("second")
          return undefined
        },
      })

      // Replace "first" — it should keep its position (index 0)
      registry.register({
        name: "first",
        route: () => {
          order.push("first-v2")
          return undefined
        },
      })

      registry.route(doc, alice)
      expect(order).toEqual(["first-v2", "second"])
    })

    it("dispose of a replaced scope does not remove its replacement", () => {
      // This is the most subtle invariant in the named scope system.
      // Scope A with name "x" is registered, then scope B with name "x"
      // replaces it. Disposing A must NOT remove B.
      const registry = new ScopeRegistry()
      const disposeA = registry.register({ name: "x", route: () => false })
      registry.register({ name: "x", route: () => true })

      // disposeA targets the old scope object, which is no longer in #scopes
      // (it was replaced in-place). Disposing it should be a no-op.
      disposeA()

      // B must still be in effect
      expect(registry.route(doc, alice)).toBe(true)
      expect(registry.names).toEqual(["x"])
    })

    it("dispose of the current named scope removes it from names", () => {
      const registry = new ScopeRegistry()
      const dispose = registry.register({ name: "room" })
      expect(registry.names).toContain("room")
      dispose()
      expect(registry.names).not.toContain("room")
    })
  })

  // -----------------------------------------------------------------------
  // classify: first-wins, short-circuit
  // -----------------------------------------------------------------------

  describe("classify composition", () => {
    const bound = bindPlain(Schema.doc({ value: Schema.string() }))

    it("first non-undefined result wins; later scopes not called", () => {
      const registry = new ScopeRegistry()
      const disposition = Interpret(bound)
      const second = vi.fn((): ReturnType<Classify> => Interpret(bound))

      registry.register({ classify: () => undefined })
      registry.register({ classify: () => disposition })
      registry.register({ classify: second })

      const result = registry.classify(
        doc,
        alice,
        ["plain", 1, 0],
        "sequential",
        "hash",
      )
      expect(result).toBe(disposition)
      expect(second).not.toHaveBeenCalled()
    })

    it("all undefined → undefined", () => {
      const registry = new ScopeRegistry()
      registry.register({ classify: () => undefined })

      const result = registry.classify(
        doc,
        alice,
        ["plain", 1, 0],
        "sequential",
        "hash",
      )
      expect(result).toBeUndefined()
    })

    it("hasClassify tracks handler presence across register/dispose", () => {
      const registry = new ScopeRegistry()
      expect(registry.hasClassify).toBe(false)

      const dispose = registry.register({ classify: () => undefined })
      expect(registry.hasClassify).toBe(true)

      dispose()
      expect(registry.hasClassify).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // onDocDismissed: broadcast (all handlers called)
  // -----------------------------------------------------------------------

  describe("onDocDismissed composition", () => {
    it("all handlers are invoked (broadcast, not gate)", () => {
      const registry = new ScopeRegistry()
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      registry.register({ route: () => true }) // no onDocDismissed — must not throw
      registry.register({ onDocDismissed: handler1 })
      registry.register({ onDocDismissed: handler2 })

      registry.docDismissed(doc, alice)

      expect(handler1).toHaveBeenCalledWith(doc, alice)
      expect(handler2).toHaveBeenCalledWith(doc, alice)
    })
  })
})