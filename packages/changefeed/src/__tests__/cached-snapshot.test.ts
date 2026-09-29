import { describe, expect, it, vi } from "vitest"
import { cachedSnapshot } from "../cached-snapshot.js"

describe("cachedSnapshot", () => {
  it("builds lazily, and returns the same value until invalidated", () => {
    let state = 1
    const build = vi.fn(() => ({ state }))
    const snapshot = cachedSnapshot(build)
    expect(build).not.toHaveBeenCalled()

    const first = snapshot.get()
    expect(snapshot.get()).toBe(first)
    expect(build).toHaveBeenCalledTimes(1)

    state = 2
    snapshot.invalidate()
    expect(build).toHaveBeenCalledTimes(1)
    const second = snapshot.get()
    expect(second).not.toBe(first)
    expect(second).toEqual({ state: 2 })
    expect(build).toHaveBeenCalledTimes(2)
  })

  it("caches a build that returned undefined", () => {
    const build = vi.fn(() => undefined)
    const snapshot = cachedSnapshot(build)
    snapshot.get()
    snapshot.get()
    expect(build).toHaveBeenCalledTimes(1)
  })
})
