// frame-stack — what an authored batch did, frame by frame, as a pure table.
import { describe, expect, it } from "vitest"
import { type ChangeBase, isReplaceChange, replaceChange } from "../change.js"
import {
  abortFrame,
  closeFrame,
  emptyFrames,
  type FrameStack,
  inFrame,
  openFrame,
  record,
} from "../interpreters/frame-stack.js"
import { RawPath } from "../path.js"

/** Record a write to field `key`, whose inverse writes `undo:key`. */
function write(frames: FrameStack, key: string): FrameStack {
  const at = RawPath.empty.field(key)
  return record(frames, {
    at,
    op: { path: at, change: replaceChange(key) },
    inverse: replaceChange(`undo:${key}`),
  })
}

const replaced = (change: ChangeBase) =>
  isReplaceChange(change) ? change.value : undefined

const keys = (ops: readonly { path: RawPath }[]) =>
  ops.map(op => op.path.format())

describe("the frame stack", () => {
  it("is empty outside any frame, and open inside one", () => {
    expect(inFrame(emptyFrames)).toBe(false)
    expect(inFrame(openFrame(emptyFrames))).toBe(true)
  })

  it("a closed frame returns its ops in order, including a nested frame that closed", () => {
    let frames = write(openFrame(emptyFrames), "a")
    frames = write(write(openFrame(frames), "b"), "c")
    const inner = closeFrame(frames)
    expect(keys(inner.ops)).toEqual(["b", "c"])
    expect(inner.outcome).toBeUndefined()

    const outer = closeFrame(write(inner.frames, "d"))
    expect(keys(outer.ops)).toEqual(["a", "b", "c", "d"])
    expect(outer.frames).toBe(emptyFrames)
  })

  it("the outermost close pairs each op with its inverse, in order", () => {
    const { outcome } = closeFrame(
      write(write(openFrame(emptyFrames), "a"), "b"),
    )
    expect(outcome?.aborted).toBe(false)
    expect(keys(outcome?.ops ?? [])).toEqual(["a", "b"])
    expect(
      outcome?.inverses.map(e => [e.path.format(), replaced(e.change)]),
    ).toEqual([
      ["a", "undo:a"],
      ["b", "undo:b"],
    ])
  })

  it("an aborted nested frame compensates last first, and leaves the outer frame's ops", () => {
    let frames = write(openFrame(emptyFrames), "a")
    frames = write(write(openFrame(frames), "b"), "c")
    const aborted = abortFrame(frames)
    expect(aborted.outermost).toBe(false)
    expect(
      aborted.compensations.map(c => [c.at.format(), replaced(c.inverse)]),
    ).toEqual([
      ["c", "undo:c"],
      ["b", "undo:b"],
    ])

    const outer = closeFrame(write(aborted.frames, "d"))
    expect(keys(outer.ops)).toEqual(["a", "d"])
    expect(keys(outer.outcome?.ops ?? [])).toEqual(["a", "d"])
  })

  it("an aborted outermost frame compensates everything and empties the stack", () => {
    const frames = write(write(openFrame(emptyFrames), "a"), "b")
    const aborted = abortFrame(frames)
    expect(aborted.outermost).toBe(true)
    expect(aborted.compensations.map(c => c.at.format())).toEqual(["b", "a"])
    expect(aborted.frames).toBe(emptyFrames)
  })
})
