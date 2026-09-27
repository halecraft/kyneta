// `announce` fans `(ops, origin)` out to N prepare calls and one flush. This
// pins what each call receives: every prepare is marked as announced, and the
// flush carries the origin. A flush that dropped it would otherwise surface
// as a confusing echo-filter failure.

import { describe, expect, it, vi } from "vitest"
import { replaceChange } from "../change.js"
import type { WritableContext } from "../interpreters/writable.js"
import { announce } from "../interpreters/writable.js"
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

describe("announce", () => {
  it("prepares each op as announced and flushes once with the origin", () => {
    const { ctx, prepare, flush, runBatch } = stubContext()
    const ops = [
      { path: RawPath.empty.field("a"), change: replaceChange(1) },
      { path: RawPath.empty.field("b"), change: replaceChange(2) },
      { path: RawPath.empty.field("c"), change: replaceChange(3) },
    ]

    announce(ctx, ops, "tag")

    expect(runBatch).not.toHaveBeenCalled()
    expect(prepare).toHaveBeenCalledTimes(3)
    for (const call of prepare.mock.calls) {
      expect(call[2]).toEqual({ ingress: "announce" })
    }
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0]?.[0]).toEqual({
      ingress: "announce",
      origin: "tag",
    })
  })
})
