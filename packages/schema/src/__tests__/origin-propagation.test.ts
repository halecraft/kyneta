// `executeBatch` is the single primitive that fans `(ops, options)` out
// to N prepare calls and one flush. This pins the structural contract:
// every prepare and the final flush see the same options value. If a
// future refactor accidentally drops options on the flush call (the
// most plausible regression), this catches it directly rather than
// surfacing as a confusing substrate-write or echo-filter failure.

import { describe, expect, it, vi } from "vitest"
import { replaceChange } from "../change.js"
import type { WritableContext } from "../interpreters/writable.js"
import { executeBatch } from "../interpreters/writable.js"
import { RawPath } from "../path.js"

function stubContext(): {
  ctx: WritableContext
  prepare: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  runBatch: ReturnType<typeof vi.fn>
} {
  const prepare = vi.fn()
  const flush = vi.fn()
  // Trivial bracket: invoke body directly. The point of this stub is
  // to observe (prepare, flush) options-propagation; the runBatch shape
  // doesn't matter beyond "calls its body."
  const runBatch = vi.fn((work: () => void) => work())
  const ctx = {
    reader: {} as any,
    prepare,
    flush,
    runBatch,
    dispatch: vi.fn(),
  } as unknown as WritableContext
  return { ctx, prepare, flush, runBatch }
}

describe("BatchOptions propagation through executeBatch", () => {
  it("forwards the same options reference to every prepare and to flush", () => {
    const { ctx, prepare, flush } = stubContext()
    const options = { origin: "tag", replay: true }
    const ops = [
      { path: RawPath.empty.field("a"), change: replaceChange(1) },
      { path: RawPath.empty.field("b"), change: replaceChange(2) },
      { path: RawPath.empty.field("c"), change: replaceChange(3) },
    ]

    executeBatch(ctx, ops, options)

    expect(prepare).toHaveBeenCalledTimes(3)
    for (const call of prepare.mock.calls) {
      expect(call[2]).toBe(options)
    }
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0]?.[0]).toBe(options)
  })

  it("forwards undefined when no options are provided", () => {
    const { ctx, prepare, flush } = stubContext()
    executeBatch(ctx, [
      { path: RawPath.empty.field("x"), change: replaceChange(0) },
    ])
    expect(prepare.mock.calls[0]?.[2]).toBeUndefined()
    expect(flush.mock.calls[0]?.[0]).toBeUndefined()
  })
})
