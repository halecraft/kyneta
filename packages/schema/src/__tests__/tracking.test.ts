// tracking.test.ts — pure tests for the read-tracking context (no interpreter).
//
// Exercises the functional core of jj:vtpxvkyk: scope capture, dedup,
// nesting, the no-scope guard, and suppression. Uses synthetic Dependency
// records — the interpreter-side instrumentation (withTracking) is tested
// separately against real refs.

import { describe, expect, it } from "vitest"
import type { Aspect, Dependency } from "../tracking.js"
import {
  currentScope,
  dependencyKey,
  reportRead,
  withoutTracking,
  withReadScope,
} from "../tracking.js"

// A synthetic dependency — `ref` is opaque to the context module.
const dep = (path: string, aspect: Aspect = "value"): Dependency => ({
  key: dependencyKey(path, aspect),
  aspect,
  ref: {} as any,
})

describe("withReadScope", () => {
  it("captures reads reported during the thunk", () => {
    const { value, deps } = withReadScope(() => {
      reportRead(dep("a/x"))
      reportRead(dep("a/y", "structure"))
      return 42
    })
    expect(value).toBe(42)
    expect(deps.map(d => d.key)).toEqual([
      dependencyKey("a/x", "value"),
      dependencyKey("a/y", "structure"),
    ])
  })

  it("dedups by key (first writer wins)", () => {
    const { deps } = withReadScope(() => {
      reportRead(dep("a/x"))
      reportRead(dep("a/x"))
      reportRead(dep("a/x"))
    })
    expect(deps).toHaveLength(1)
  })

  it("distinguishes aspects at the same path", () => {
    const { deps } = withReadScope(() => {
      reportRead(dep("a", "deep"))
      reportRead(dep("a", "structure"))
    })
    expect(deps).toHaveLength(2)
  })

  it("restores the previous scope after returning", () => {
    withReadScope(() => reportRead(dep("a")))
    // Outside any scope now — a stray read must not throw or leak.
    expect(currentScope()).toBe(false)
    reportRead(dep("leak"))
  })

  it("restores the scope even when the thunk throws", () => {
    expect(() =>
      withReadScope(() => {
        reportRead(dep("a"))
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(currentScope()).toBe(false)
  })
})

describe("no-scope guard", () => {
  it("reportRead is a no-op with no active scope", () => {
    expect(currentScope()).toBe(false)
    // Must not throw, must capture nothing.
    reportRead(dep("orphan"))
    expect(currentScope()).toBe(false)
  })
})

describe("nesting", () => {
  it("an inner scope collects independently; the outer resumes", () => {
    let inner: Dependency[] = []
    const { deps: outer } = withReadScope(() => {
      reportRead(dep("outer/before"))
      inner = withReadScope(() => {
        reportRead(dep("inner/x"))
      }).deps
      reportRead(dep("outer/after"))
    })
    expect(inner.map(d => d.key)).toEqual([dependencyKey("inner/x", "value")])
    expect(outer.map(d => d.key)).toEqual([
      dependencyKey("outer/before", "value"),
      dependencyKey("outer/after", "value"),
    ])
  })
})

describe("withoutTracking (suppression)", () => {
  it("suppresses reads while active, then resumes", () => {
    const { deps } = withReadScope(() => {
      reportRead(dep("tracked/before"))
      withoutTracking(() => {
        reportRead(dep("suppressed"))
      })
      reportRead(dep("tracked/after"))
    })
    expect(deps.map(d => d.key)).toEqual([
      dependencyKey("tracked/before", "value"),
      dependencyKey("tracked/after", "value"),
    ])
  })

  it("currentScope() reports false while suppressed", () => {
    withReadScope(() => {
      expect(currentScope()).toBe(true)
      withoutTracking(() => {
        expect(currentScope()).toBe(false)
      })
      expect(currentScope()).toBe(true)
    })
  })
})
