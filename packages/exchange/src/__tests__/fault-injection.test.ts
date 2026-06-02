// fault-injection — unit tests for the shared op-weighted, deferred-arm
// write-fault primitive that store backends' faultFactories consume.

import { describe, expect, it } from "vitest"
import { makeArmedFault } from "../testing/fault-injection.js"

describe("makeArmedFault", () => {
  it("is latent until armed — pre-arm calls pass through to the target", () => {
    const seen: string[] = []
    const target = {
      put: (k: string): string => {
        seen.push(k)
        return "ok"
      },
    }
    const { proxy, arm } = makeArmedFault(target, { put: 1 })

    expect(proxy.put("a")).toBe("ok")
    expect(proxy.put("b")).toBe("ok")
    arm(1)
    expect(() => proxy.put("c")).toThrow()

    // "c" failed before delegating; only "a"/"b" reached the target.
    expect(seen).toEqual(["a", "b"])
  })

  it("op-weighting: a weighted call fails when the armed tick lands in its range", () => {
    const batched: number[][] = []
    const target = {
      put: (_k: string): void => {},
      batch: (ops: number[]): void => {
        batched.push(ops)
      },
    }
    const { proxy, arm } = makeArmedFault(target, {
      put: 1,
      batch: ops => (ops as number[]).length,
    })

    arm(2)
    proxy.put("x") // tick 1 — ok
    // batch spans ticks 2..3; armed 2 is in range → fail before delegating.
    expect(() => proxy.batch([10, 20])).toThrow()
    expect(batched).toEqual([])
  })

  it("forwards unlisted methods untouched even when armed", () => {
    const target = {
      put: (): void => {},
      read: (): number => 42,
    }
    const { proxy, arm } = makeArmedFault(target, { put: 1 })

    arm(1)
    // `read` is not a seam: never counts, never fails.
    expect(proxy.read()).toBe(42)
    expect(() => proxy.put()).toThrow()
  })

  it("rejects (does not synchronously throw) for async seams", async () => {
    const target = { query: async (): Promise<string> => "row" }
    const { proxy, arm } = makeArmedFault(target, { query: 1 })

    arm(1)
    await expect(proxy.query()).rejects.toThrow()
  })

  it("arm rejects n < 1", () => {
    const { arm } = makeArmedFault({ a: (): void => {} }, { a: 1 })
    expect(() => arm(0)).toThrow(/n must be/)
  })
})
