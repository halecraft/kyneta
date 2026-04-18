// governance — unit tests for three-valued predicate composition and Governance.
//
// Architecture mirrors governance.ts: pure function tests first (composeGate),
// then imperative shell tests (Governance).

import { Interpret, json, Schema } from "@kyneta/schema"
import type { PeerIdentityDetails } from "@kyneta/transport"
import { describe, expect, it, vi } from "vitest"
import { Exchange } from "../exchange.js"
import { composeGate, Governance } from "../governance.js"

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
// Pure function: composeGate
// ---------------------------------------------------------------------------

describe("composeGate", () => {
  describe("defaultWhenAllUndefined: true (open by default)", () => {
    const compose = (results: Iterable<boolean | undefined>) =>
      composeGate(results, true)

    it("single true → true", () => {
      expect(compose([true])).toBe(true)
    })

    it("single false → false", () => {
      expect(compose([false])).toBe(false)
    })

    it("single undefined → true (default open)", () => {
      expect(compose([undefined])).toBe(true)
    })

    it("deny wins regardless of order", () => {
      expect(compose([true, false])).toBe(false)
      expect(compose([false, true])).toBe(false)
    })

    it("true and undefined → true", () => {
      expect(compose([undefined, true])).toBe(true)
    })

    it("all undefined → default", () => {
      expect(compose([undefined, undefined])).toBe(true)
    })

    it("short-circuits on false — generator yields stop early", () => {
      let secondEvaluated = false
      function* gen(): Iterable<boolean | undefined> {
        yield false
        secondEvaluated = true
        yield true
      }
      compose(gen())
      expect(secondEvaluated).toBe(false)
    })

    it("empty iterable → default", () => {
      expect(compose([])).toBe(true)
    })
  })

  describe("defaultWhenAllUndefined: false (closed by default)", () => {
    const compose = (results: Iterable<boolean | undefined>) =>
      composeGate(results, false)

    it("all undefined → false", () => {
      expect(compose([undefined, undefined])).toBe(false)
    })

    it("single true overrides closed default", () => {
      expect(compose([true, undefined])).toBe(true)
    })
  })

  it("empty iterable → defaultWhenAllUndefined", () => {
    expect(composeGate([], true)).toBe(true)
    expect(composeGate([], false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Imperative shell: Governance
// ---------------------------------------------------------------------------

describe("Governance", () => {
  // -----------------------------------------------------------------------
  // Lifecycle: register, dispose, clear
  // -----------------------------------------------------------------------

  describe("lifecycle", () => {
    it("register → compose reflects policy; dispose → reverts to default", () => {
      const registry = new Governance()
      const dispose = registry.register({ canShare: () => false })
      expect(registry.canShare(doc, alice)).toBe(false)
      dispose()
      expect(registry.canShare(doc, alice)).toBe(true)
    })

    it("dispose is idempotent", () => {
      const registry = new Governance()
      const dispose = registry.register({ canShare: () => false })
      dispose()
      dispose() // must not throw or corrupt state
      expect(registry.canShare(doc, alice)).toBe(true)
    })

    it("clear() removes all policies and resets named policy map", () => {
      const registry = new Governance()
      registry.register({ name: "a", canShare: () => false })
      registry.register({ canAccept: () => false })
      registry.clear()

      expect(registry.canShare(doc, alice)).toBe(true)
      expect(registry.canAccept(doc, alice)).toBe(true)
      expect(registry.names).toEqual([])

      // Re-registering a name after clear should work fresh (not hit
      // the replacement path with a stale reference)
      registry.register({ name: "a", canShare: () => false })
      expect(registry.canShare(doc, alice)).toBe(false)
      expect(registry.names).toEqual(["a"])
    })

    it("adding a policy after initial registration affects live composition", () => {
      const registry = new Governance()
      registry.register({ canShare: () => true })
      expect(registry.canShare(doc, alice)).toBe(true)

      const dispose = registry.register({ canShare: () => false })
      expect(registry.canShare(doc, alice)).toBe(false)

      dispose()
      expect(registry.canShare(doc, alice)).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Named policies: replacement, order preservation, dispose-after-replace
  // -----------------------------------------------------------------------

  describe("named policies", () => {
    it("names reflects registered named policies in order", () => {
      const registry = new Governance()
      registry.register({ canShare: () => true }) // unnamed
      registry.register({ name: "b", canShare: () => true })
      registry.register({ name: "a", canShare: () => true })
      expect(registry.names).toEqual(["b", "a"])
    })

    it("same-name registration replaces in-place, preserving evaluation order", () => {
      const registry = new Governance()
      const order: string[] = []

      registry.register({
        name: "first",
        canShare: () => {
          order.push("first")
          return undefined
        },
      })
      registry.register({
        name: "second",
        canShare: () => {
          order.push("second")
          return undefined
        },
      })

      // Replace "first" — it should keep its position (index 0)
      registry.register({
        name: "first",
        canShare: () => {
          order.push("first-v2")
          return undefined
        },
      })

      registry.canShare(doc, alice)
      expect(order).toEqual(["first-v2", "second"])
    })

    it("dispose of a replaced policy does not remove its replacement", () => {
      // This is the most subtle invariant in the named policy system.
      // Policy A with name "x" is registered, then policy B with name "x"
      // replaces it. Disposing A must NOT remove B.
      const registry = new Governance()
      const disposeA = registry.register({ name: "x", canShare: () => false })
      registry.register({ name: "x", canShare: () => true })

      // disposeA targets the old policy object, which is no longer in #policies
      // (it was replaced in-place). Disposing it should be a no-op.
      disposeA()

      // B must still be in effect
      expect(registry.canShare(doc, alice)).toBe(true)
      expect(registry.names).toEqual(["x"])
    })

    it("dispose of the current named policy removes it from names", () => {
      const registry = new Governance()
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
      const registry = new Governance()
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
      const registry = new Governance()
      const error1 = new Error("fail-1")
      const error2 = new Error("fail-2")
      const dispose3 = vi.fn()

      registry.register({
        dispose: () => {
          throw error1
        },
      })
      registry.register({
        dispose: () => {
          throw error2
        },
      })
      registry.register({ dispose: dispose3 })

      const errors = registry.clear()

      expect(errors).toEqual([error1, error2])
      expect(dispose3).toHaveBeenCalledOnce()
    })

    it("individual policy disposal calls dispose once", () => {
      const registry = new Governance()
      const disposeFn = vi.fn()

      const dispose = registry.register({ dispose: disposeFn })
      dispose()

      expect(disposeFn).toHaveBeenCalledOnce()
    })

    it("dispose is called at most once even if both individual disposal and clear() run", () => {
      const registry = new Governance()
      const disposeFn = vi.fn()

      const dispose = registry.register({ dispose: disposeFn })
      dispose()
      registry.clear()

      expect(disposeFn).toHaveBeenCalledOnce()
    })

    it("named policy replacement calls dispose on the old policy", () => {
      const registry = new Governance()
      const oldDispose = vi.fn()
      const newDispose = vi.fn()

      registry.register({ name: "x", dispose: oldDispose })
      registry.register({ name: "x", dispose: newDispose })

      expect(oldDispose).toHaveBeenCalledOnce()
      expect(newDispose).not.toHaveBeenCalled()
    })

    it("after clear(), re-registering a policy with dispose works fresh", () => {
      const registry = new Governance()
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
      const registry = new Governance()
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
  // resolve: first-wins, short-circuit
  // -----------------------------------------------------------------------

  describe("resolve composition", () => {
    const bound = json.bind(Schema.struct({ value: Schema.string() }))

    it("first non-undefined result wins; later policies not called", () => {
      const registry = new Governance()
      const disposition = Interpret(bound)
      const second = vi.fn(
        (
          _docId: unknown,
          _peer: unknown,
          _replicaType: unknown,
          _mergeStrategy: unknown,
          _schemaHash: unknown,
        ) => Interpret(bound),
      )

      registry.register({ resolve: () => undefined })
      registry.register({ resolve: () => disposition })
      registry.register({ resolve: second })

      const result = registry.resolve(
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
      const registry = new Governance()
      registry.register({ resolve: () => undefined })

      const result = registry.resolve(
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
  // canReset: three-valued gate composition for epoch boundaries
  // -----------------------------------------------------------------------

  describe("canReset composition", () => {
    it("defaults to true when all policies return undefined", () => {
      const registry = new Governance()
      registry.register({ canReset: () => undefined })
      expect(registry.canReset(doc, alice, "collaborative")).toBe(true)
    })

    it("false from any policy vetoes the reset", () => {
      const registry = new Governance()
      registry.register({ canReset: () => true })
      registry.register({ canReset: () => false })
      expect(registry.canReset(doc, alice, "collaborative")).toBe(false)
    })

    it("true from at least one policy permits the reset", () => {
      const registry = new Governance()
      registry.register({ canReset: () => undefined })
      registry.register({ canReset: () => true })
      expect(registry.canReset(doc, alice, "collaborative")).toBe(true)
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
    exchange.register({
      dispose: () => {
        throw error
      },
    })
    await expect(exchange.shutdown()).rejects.toThrow(error)
  })

  it("shutdown wraps multiple dispose errors in AggregateError", async () => {
    const exchange = new Exchange()
    exchange.register({
      dispose: () => {
        throw new Error("a")
      },
    })
    exchange.register({
      dispose: () => {
        throw new Error("b")
      },
    })
    await expect(exchange.shutdown()).rejects.toThrow(AggregateError)
  })

  it("reset rethrows a single dispose error after completing cleanup", () => {
    const exchange = new Exchange()
    const error = new Error("dispose-fail")
    exchange.register({
      dispose: () => {
        throw error
      },
    })
    expect(() => exchange.reset()).toThrow(error)
  })

  it("shutdown completes all cleanup steps even when dispose throws", async () => {
    const exchange = new Exchange({ identity: { peerId: "test" } })
    exchange.register({
      dispose: () => {
        throw new Error("boom")
      },
    })

    // Create a doc so the cache is non-empty
    const bound = json.bind(Schema.struct({ v: Schema.string() }))
    exchange.get("test-doc", bound)
    expect(exchange.has("test-doc")).toBe(true)

    try {
      await exchange.shutdown()
    } catch {
      /* expected */
    }

    // Doc cache was cleared despite the dispose error — Exchange is inert.
    // If rethrowErrors fired before cache/synchronizer cleanup, this would
    // still be true (the error would have aborted shutdown early).
    expect(exchange.has("test-doc")).toBe(false)
  })
})
