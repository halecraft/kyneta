import { beforeEach, describe, expect, it, vi } from "vitest"
import { ScopeDisposedError } from "../errors.js"
import { resetScopeIdCounter, Scope } from "./scope.js"

describe("Scope", () => {
  beforeEach(() => {
    resetScopeIdCounter()
  })

  describe("creation", () => {
    it("should assign unique IDs (auto-generated or custom)", () => {
      const scope1 = new Scope()
      const scope2 = new Scope()
      const custom = new Scope("my-scope")

      expect(scope1.id).toBe("scope-1")
      expect(scope2.id).toBe("scope-2")
      expect(custom.id).toBe("my-scope")
      expect(scope1.disposed).toBe(false)
    })
  })

  describe("onDispose", () => {
    it("should register cleanup functions", () => {
      const scope = new Scope()
      const cleanup = vi.fn()

      scope.onDispose(cleanup)

      expect(scope.cleanupCount).toBe(1)
      expect(cleanup).not.toHaveBeenCalled()
    })

    it("should throw if scope is disposed", () => {
      const scope = new Scope()
      scope.dispose()

      expect(() => scope.onDispose(() => {})).toThrow(ScopeDisposedError)
    })
  })

  describe("dispose", () => {
    it("should call cleanup functions in reverse order (LIFO)", () => {
      const scope = new Scope()
      const order: number[] = []

      scope.onDispose(() => order.push(1))
      scope.onDispose(() => order.push(2))
      scope.onDispose(() => order.push(3))

      scope.dispose()

      expect(order).toEqual([3, 2, 1])
      expect(scope.disposed).toBe(true)
    })

    it("should be idempotent (safe to call multiple times)", () => {
      const scope = new Scope()
      const cleanup = vi.fn()
      scope.onDispose(cleanup)

      scope.dispose()
      scope.dispose()
      scope.dispose()

      expect(cleanup).toHaveBeenCalledTimes(1)
    })

    it("should continue cleanup even if one throws", () => {
      const scope = new Scope()
      const cleanup1 = vi.fn()
      const cleanup2 = vi.fn(() => {
        throw new Error("cleanup error")
      })
      const cleanup3 = vi.fn()

      scope.onDispose(cleanup1)
      scope.onDispose(cleanup2)
      scope.onDispose(cleanup3)

      // Suppress console.error for this test
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {})

      scope.dispose()

      consoleError.mockRestore()

      // All cleanups should have been attempted
      expect(cleanup3).toHaveBeenCalled()
      expect(cleanup2).toHaveBeenCalled()
      expect(cleanup1).toHaveBeenCalled()
    })

    it("should clear cleanup list after dispose", () => {
      const scope = new Scope()
      scope.onDispose(() => {})
      scope.onDispose(() => {})

      expect(scope.cleanupCount).toBe(2)

      scope.dispose()

      expect(scope.cleanupCount).toBe(0)
    })
  })

  describe("child scopes", () => {
    it("should create child scopes", () => {
      const parent = new Scope("parent")
      const child = parent.createChild()

      expect(parent.childCount).toBe(1)
      expect(child.disposed).toBe(false)
    })

    it("should throw if parent is disposed", () => {
      const parent = new Scope()
      parent.dispose()

      expect(() => parent.createChild()).toThrow(ScopeDisposedError)
    })

    it("should dispose children before parent cleanups", () => {
      const parent = new Scope()
      const child = parent.createChild()
      const order: string[] = []

      parent.onDispose(() => order.push("parent"))
      child.onDispose(() => order.push("child"))

      parent.dispose()

      expect(order).toEqual(["child", "parent"])
    })

    it("should cascade dispose to all children", () => {
      const parent = new Scope()
      const child1 = parent.createChild()
      const child2 = parent.createChild()

      parent.dispose()

      expect(child1.disposed).toBe(true)
      expect(child2.disposed).toBe(true)
    })

    it("should cascade dispose to nested children (depth-first)", () => {
      const root = new Scope()
      const child = root.createChild()
      const grandchild = child.createChild()
      const order: string[] = []

      root.onDispose(() => order.push("root"))
      child.onDispose(() => order.push("child"))
      grandchild.onDispose(() => order.push("grandchild"))

      root.dispose()

      expect(order).toEqual(["grandchild", "child", "root"])
    })

    it("should remove child from parent when disposed directly", () => {
      const parent = new Scope()
      const child = parent.createChild()

      expect(parent.childCount).toBe(1)

      child.dispose()

      expect(parent.childCount).toBe(0)
    })

    it("should clear children set after parent dispose", () => {
      const parent = new Scope()
      parent.createChild()
      parent.createChild()

      expect(parent.childCount).toBe(2)

      parent.dispose()

      expect(parent.childCount).toBe(0)
    })
  })

  describe("totalCleanupCount", () => {
    it("should count cleanups in current scope only when no children", () => {
      const scope = new Scope()
      scope.onDispose(() => {})
      scope.onDispose(() => {})

      expect(scope.totalCleanupCount).toBe(2)
    })

    it("should count cleanups in all descendants", () => {
      const root = new Scope()
      const child = root.createChild()
      const grandchild = child.createChild()

      root.onDispose(() => {})
      child.onDispose(() => {})
      child.onDispose(() => {})
      grandchild.onDispose(() => {})

      expect(root.totalCleanupCount).toBe(4)
      expect(child.totalCleanupCount).toBe(3)
      expect(grandchild.totalCleanupCount).toBe(1)
    })
  })

  describe("real-world scenarios", () => {
    it("should handle list item cleanup pattern", () => {
      const listScope = new Scope("list")
      const itemCleanups: string[] = []

      // Simulate adding 3 list items
      const items = ["a", "b", "c"]
      const itemScopes = items.map(item => {
        const scope = listScope.createChild()
        scope.onDispose(() => itemCleanups.push(`cleanup ${item}`))
        return scope
      })

      expect(listScope.childCount).toBe(3)

      // Simulate deleting item "b"
      itemScopes[1].dispose()

      expect(listScope.childCount).toBe(2)
      expect(itemCleanups).toEqual(["cleanup b"])

      // Dispose entire list
      // Set iteration is in insertion order, so remaining children [a, c] are disposed in that order
      listScope.dispose()

      expect(itemCleanups).toEqual(["cleanup b", "cleanup a", "cleanup c"])
    })

    it("should handle conditional region swap pattern", () => {
      const conditionalScope = new Scope("conditional")
      let currentBranchScope: Scope | null = null
      const cleanups: string[] = []

      // Initial render of "then" branch
      currentBranchScope = conditionalScope.createChild()
      currentBranchScope.onDispose(() => cleanups.push("then cleanup"))

      // Swap to "else" branch
      currentBranchScope.dispose()
      currentBranchScope = conditionalScope.createChild()
      currentBranchScope.onDispose(() => cleanups.push("else cleanup"))

      expect(cleanups).toEqual(["then cleanup"])

      // Dispose entire conditional
      conditionalScope.dispose()

      expect(cleanups).toEqual(["then cleanup", "else cleanup"])
    })
  })
})
