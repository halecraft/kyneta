// doc-governance — unit tests for three-valued predicate composition and DocGovernance.
//
// Architecture mirrors doc-governance.ts: pure function tests first (composeRule),
// then imperative shell tests (DocGovernance).

import { Interpret, json, Schema } from "@kyneta/schema"
import type { PeerIdentityDetails } from "@kyneta/transport"
import { describe, expect, it, vi } from "vitest"
import type { OnUnresolvedDoc } from "../exchange.js"
import { Exchange } from "../exchange.js"
import { composeRule, type DocPolicy, DocGovernance } from "../doc-governance.js"

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
    const compose = (policies: DocPolicy[]) =>
      composeRule(policies, "route", doc, alice, true)

    it("single policy returning true → true", () => {
      expect(compose([{ route: () => true }])).toBe(true)
    })

    it("single policy returning false → false", () => {
      expect(compose([{ route: () => false }])).toBe(false)
    })

    it("single policy returning undefined → true (default open)", () => {
      expect(compose([{ route: () => undefined }])).toBe(true)
    })

    it("deny wins regardless of order", () => {
      expect(compose([{ route: () => true }, { route: () => false }])).toBe(
        false,
      )
      expect(compose([{ route: () => false }, { route: () => true }])).toBe(
        false,
      )
    })

    it("true and undefined → true", () => {
      expect(compose([{ route: () => undefined }, { route: () => true }])).toBe(
        true,
      )
    })

    it("all undefined → default", () => {
      expect(
        compose([{ route: () => undefined }, { route: () => undefined }]),
      ).toBe(true)
    })

    it("short-circuits on false — subsequent policies not evaluated", () => {
      const second = vi.fn(() => true as boolean | undefined)
      compose([{ route: () => false }, { route: second }])
      expect(second).not.toHaveBeenCalled()
    })

    it("policies without the evaluated field are transparent", () => {
      // A policy with only `authorize` should not affect `route` composition
      expect(compose([{ authorize: () => false }])).toBe(true)
    })
  })

  describe("defaultWhenAllUndefined: false (closed by default)", () => {
    const compose = (policies: DocPolicy[]) =>
      composeRule(policies, "route", doc, alice, false)

    it("all undefined → false", () => {
      expect(
        compose([{ route: () => undefined }, { route: () => undefined }]),
      ).toBe(false)
    })

    it("single true overrides closed default", () => {
      expect(compose([{ route: () => true }, { route: () => undefined }])).toBe(
        true,
      )
    })
  })

  it("empty policies array → defaultWhenAllUndefined", () => {
    expect(composeRule([], "route", doc, alice, true)).toBe(true)
    expect(composeRule([], "route", doc, alice, false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Imperative shell: DocGovernance
// ---------------------------------------------------------------------------

describe("DocGovernance", () => {
  // -----------------------------------------------------------------------
  // Lifecycle: register, dispose, clear
  // -----------------------------------------------------------------------

  describe("lifecycle", () => {
    it("register → compose reflects policy; dispose → reverts to default", () => {
      const registry = new DocGovernance()
      const dispose = registry.register({ route: () => false })
      expect(registry.route(doc, alice)).toBe(false)
      dispose()
      expect(registry.route(doc, alice)).toBe(true)
    })

    it("dispose is idempotent", () => {
      const registry = new DocGovernance()
      const dispose = registry.register({ route: () => false })
      dispose()
      dispose() // must not throw or corrupt state
      expect(registry.route(doc, alice)).toBe(true)
    })

    it("clear() removes all policies and resets named policy map", () => {
      const registry = new DocGovernance()
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

    it("adding a policy after initial registration affects live composition", () => {
      const registry = new DocGovernance()
      registry.register({ route: () => true })
      expect(registry.route(doc, alice)).toBe(true)

      const dispose = registry.register({ route: () => false })
      expect(registry.route(doc, alice)).toBe(false)

      dispose()
      expect(registry.route(doc, alice)).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Named policies: replacement, order preservation, dispose-after-replace
  // -----------------------------------------------------------------------

  describe("named policies", () => {
    it("names reflects registered named policies in order", () => {
      const registry = new DocGovernance()
      registry.register({ route: () => true }) // unnamed
      registry.register({ name: "b", route: () => true })
      registry.register({ name: "a", route: () => true })
      expect(registry.names).toEqual(["b", "a"])
    })

    it("same-name registration replaces in-place, preserving evaluation order", () => {
      const registry = new DocGovernance()
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

    it("dispose of a replaced policy does not remove its replacement", () => {
      // This is the most subtle invariant in the named policy system.
      // Policy A with name "x" is registered, then policy B with name "x"
      // replaces it. Disposing A must NOT remove B.
      const registry = new DocGovernance()
      const disposeA = registry.register({ name: "x", route: () => false })
      registry.register({ name: "x", route: () => true })

      // disposeA targets the old policy object, which is no longer in #policies
      // (it was replaced in-place). Disposing it should be a no-op.
      disposeA()

      // B must still be in effect
      expect(registry.route(doc, alice)).toBe(true)
      expect(registry.names).toEqual(["x"])
    })

    it("dispose of the current named policy removes it from names", () => {
      const registry = new DocGovernance()
      const dispose = registry.register({ name: "room" })
      expect(registry.names).toContain("room")
      dispose()
      expect(registry.names).not.toContain("room")
    })
  })

  // -----------------------------------------------------------------------
  // dispose hook
  // -----------------------------------------------------------------------

  describe("dispose hook", () => {
    it("clear() calls dispose on all registered policies and returns []", () => {
      const registry = new DocGovernance()
      const dispose1 = vi.fn()
      const dispose2 = vi.fn()

      registry.register({ dispose: dispose1 })
      registry.register({ dispose: dispose2 })

      const errors = registry.clear()

      expect(dispose1).toHaveBeenCalledOnce()
      expect(dispose2).toHaveBeenCalledOnce()
      expect(errors).toEqual([])
    })

    it("clear() collects errors from dispose callbacks without stopping", () => {
      const registry = new DocGovernance()
      const error1 = new Error("fail-1")
      const error2 = new Error("fail-2")
      const dispose3 = vi.fn()

      registry.register({ dispose: () => { throw error1 } })
      registry.register({ dispose: () => { throw error2 } })
      registry.register({ dispose: dispose3 })

      const errors = registry.clear()

      expect(errors).toEqual([error1, error2])
      expect(dispose3).toHaveBeenCalledOnce()
    })

    it("individual policy disposal calls dispose once", () => {
      const registry = new DocGovernance()
      const disposeFn = vi.fn()

      const dispose = registry.register({ dispose: disposeFn })
      dispose()

      expect(disposeFn).toHaveBeenCalledOnce()
    })

    it("dispose is called at most once even if both individual disposal and clear() run", () => {
      const registry = new DocGovernance()
      const disposeFn = vi.fn()

      const dispose = registry.register({ dispose: disposeFn })
      dispose()
      registry.clear()

      expect(disposeFn).toHaveBeenCalledOnce()
    })

    it("named policy replacement calls dispose on the old policy", () => {
      const registry = new DocGovernance()
      const oldDispose = vi.fn()
      const newDispose = vi.fn()

      registry.register({ name: "x", dispose: oldDispose })
      registry.register({ name: "x", dispose: newDispose })

      expect(oldDispose).toHaveBeenCalledOnce()
      expect(newDispose).not.toHaveBeenCalled()
    })

    it("after clear(), re-registering a policy with dispose works fresh", () => {
      const registry = new DocGovernance()
      const disposeFn = vi.fn()

      registry.register({ name: "a", dispose: disposeFn })
      registry.clear()

      expect(disposeFn).toHaveBeenCalledOnce()
      disposeFn.mockClear()

      const disposeFn2 = vi.fn()
      registry.register({ name: "a", dispose: disposeFn2 })
      const errors = registry.clear()

      expect(disposeFn2).toHaveBeenCalledOnce()
      expect(errors).toEqual([])
    })

    it("disposer that calls register() during clear() does not corrupt the sweep", () => {
      const registry = new DocGovernance()
      const latecomer = vi.fn()

      registry.register({
        dispose: () => {
          // Re-entrant: register a new policy during clear() iteration.
          // The snapshot-then-clear design ensures this new policy is NOT
          // part of the current sweep — it survives into the fresh state.
          registry.register({ name: "latecomer", dispose: latecomer })
        },
      })
      registry.register({ dispose: vi.fn() })

      const errors = registry.clear()
      expect(errors).toEqual([])

      // The latecomer was registered during clear() — it should NOT have
      // been swept (it wasn't in the snapshot). It's now the only policy.
      expect(latecomer).not.toHaveBeenCalled()
      expect(registry.names).toEqual(["latecomer"])

      // A second clear() should sweep the latecomer.
      registry.clear()
      expect(latecomer).toHaveBeenCalledOnce()
    })
  })

  // -----------------------------------------------------------------------
  // onUnresolvedDoc: first-wins, short-circuit
  // -----------------------------------------------------------------------

  describe("onUnresolvedDoc composition", () => {
    const bound = json.bind(Schema.struct({ value: Schema.string() }))

    it("first non-undefined result wins; later policies not called", () => {
      const registry = new DocGovernance()
      const disposition = Interpret(bound)
      const second = vi.fn((): ReturnType<OnUnresolvedDoc> => Interpret(bound))

      registry.register({ onUnresolvedDoc: () => undefined })
      registry.register({ onUnresolvedDoc: () => disposition })
      registry.register({ onUnresolvedDoc: second })

      const result = registry.onUnresolvedDoc(
        doc,
        alice,
        ["plain", 1, 0],
        "authoritative",
        "hash",
      )
      expect(result).toBe(disposition)
      expect(second).not.toHaveBeenCalled()
    })

    it("all undefined → undefined", () => {
      const registry = new DocGovernance()
      registry.register({ onUnresolvedDoc: () => undefined })

      const result = registry.onUnresolvedDoc(
        doc,
        alice,
        ["plain", 1, 0],
        "authoritative",
        "hash",
      )
      expect(result).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // onDocDismissed: broadcast (all handlers called)
  // -----------------------------------------------------------------------

  describe("onDocDismissed composition", () => {
    it("all handlers are invoked (broadcast, not gate)", () => {
      const registry = new DocGovernance()
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      registry.register({ route: () => true }) // no onDocDismissed — must not throw
      registry.register({ onDocDismissed: handler1 })
      registry.register({ onDocDismissed: handler2 })

      registry.docDismissed(doc, alice, "remote")

      expect(handler1).toHaveBeenCalledWith(doc, alice, "remote")
      expect(handler2).toHaveBeenCalledWith(doc, alice, "remote")
    })

    it("passes origin through to handlers", () => {
      const registry = new DocGovernance()
      const handler = vi.fn()

      registry.register({ onDocDismissed: handler })

      registry.docDismissed(doc, alice, "local")
      expect(handler).toHaveBeenCalledWith(doc, alice, "local")

      handler.mockClear()

      registry.docDismissed(doc, alice, "remote")
      expect(handler).toHaveBeenCalledWith(doc, alice, "remote")
    })
  })

  // -----------------------------------------------------------------------
  // onDocCreated: broadcast (all handlers called)
  // -----------------------------------------------------------------------

  describe("onDocCreated composition", () => {
    it("all handlers are invoked (broadcast, not gate)", () => {
      const registry = new DocGovernance()
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      registry.register({ route: () => true }) // no onDocCreated — must not throw
      registry.register({ onDocCreated: handler1 })
      registry.register({ onDocCreated: handler2 })

      registry.docCreated(doc, alice, "interpret", "local")

      expect(handler1).toHaveBeenCalledOnce()
      expect(handler2).toHaveBeenCalledOnce()
      expect(handler1).toHaveBeenCalledWith(doc, alice, "interpret", "local")
    })
  })
})

// ---------------------------------------------------------------------------
// rethrowErrors (via Exchange shutdown/reset)
// ---------------------------------------------------------------------------

describe("rethrowErrors (via Exchange shutdown/reset)", () => {
  it("shutdown rethrows a single dispose error after completing cleanup", async () => {
    const exchange = new Exchange()
    const error = new Error("dispose-fail")
    exchange.register({ dispose: () => { throw error } })
    await expect(exchange.shutdown()).rejects.toThrow(error)
  })

  it("shutdown wraps multiple dispose errors in AggregateError", async () => {
    const exchange = new Exchange()
    exchange.register({ dispose: () => { throw new Error("a") } })
    exchange.register({ dispose: () => { throw new Error("b") } })
    await expect(exchange.shutdown()).rejects.toThrow(AggregateError)
  })

  it("reset rethrows a single dispose error after completing cleanup", () => {
    const exchange = new Exchange()
    const error = new Error("dispose-fail")
    exchange.register({ dispose: () => { throw error } })
    expect(() => exchange.reset()).toThrow(error)
  })

  it("shutdown completes all cleanup steps even when dispose throws", async () => {
    const exchange = new Exchange({ identity: { peerId: "test" } })
    exchange.register({ dispose: () => { throw new Error("boom") } })

    // Create a doc so the cache is non-empty
    const bound = json.bind(Schema.struct({ v: Schema.string() }))
    exchange.get("test-doc", bound)
    expect(exchange.has("test-doc")).toBe(true)

    try { await exchange.shutdown() } catch { /* expected */ }

    // Doc cache was cleared despite the dispose error — Exchange is inert.
    // If rethrowErrors fired before cache/synchronizer cleanup, this would
    // still be true (the error would have aborted shutdown early).
    expect(exchange.has("test-doc")).toBe(false)
  })
})
