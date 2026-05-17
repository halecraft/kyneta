// frame-stream-parser — round-trip, split, coalesced, and reset tests.

import { complete, encodeBinaryFrame, WIRE_VERSION } from "@kyneta/wire"
import { describe, expect, it } from "vitest"
import { FrameStreamParser } from "../frame-stream-parser.js"

describe("FrameStreamParser", () => {
  it("single frame round-trip", () => {
    const frame = encodeBinaryFrame(
      complete(WIRE_VERSION, new Uint8Array([1, 2, 3])),
    )
    const parser = new FrameStreamParser()
    const results = parser.feed(frame)

    expect(results).toHaveLength(1)
    const r = results[0]
    expect(r).toBeDefined()
    if (r === undefined) throw new Error("unreachable")
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(new Uint8Array(r.value)).toEqual(frame)
  })

  it("split delivery: partial feed yields nothing, remainder completes", () => {
    const frame = encodeBinaryFrame(
      complete(WIRE_VERSION, new Uint8Array([1, 2, 3])),
    )
    const mid = Math.floor(frame.length / 2)
    const parser = new FrameStreamParser()

    const first = parser.feed(frame.slice(0, mid))
    expect(first).toHaveLength(0)

    const second = parser.feed(frame.slice(mid))
    expect(second).toHaveLength(1)
    const r = second[0]
    if (!r || !r.ok) throw new Error("expected ok result")
    expect(new Uint8Array(r.value)).toEqual(frame)
  })

  it("coalesced delivery: two frames in one buffer yield two results with correct content", () => {
    const frame1 = encodeBinaryFrame(
      complete(WIRE_VERSION, new Uint8Array([10])),
    )
    const frame2 = encodeBinaryFrame(
      complete(WIRE_VERSION, new Uint8Array([20])),
    )
    const combined = new Uint8Array(frame1.length + frame2.length)
    combined.set(frame1, 0)
    combined.set(frame2, frame1.length)

    const parser = new FrameStreamParser()
    const results = parser.feed(combined)

    expect(results).toHaveLength(2)
    for (const r of results) {
      expect(r.ok).toBe(true)
    }

    const r0 = results[0]
    const r1 = results[1]
    if (r0 === undefined || r1 === undefined) {
      throw new Error("Expected two results")
    }
    if (!r0.ok || !r1.ok) {
      throw new Error("Expected both results to be ok")
    }
    expect(new Uint8Array(r0.value)).toEqual(frame1)
    expect(new Uint8Array(r1.value)).toEqual(frame2)
  })

  it("extracts a zero-payload frame", () => {
    const parser = new FrameStreamParser()
    // Build a 6-byte header with payload length = 0
    const header = new Uint8Array(6)
    header[0] = 2 // version
    header[1] = 0 // type
    new DataView(header.buffer).setUint32(2, 0, false) // payload length = 0

    const frames = parser.feed(header)
    expect(frames).toHaveLength(1)
    const f = frames[0]
    if (f === undefined) {
      throw new Error("Expected one frame")
    }
    expect(f.ok).toBe(true)
    if (!f.ok) {
      throw new Error("Expected ok result")
    }
    expect(new Uint8Array(f.value)).toEqual(header)
  })

  it("empty chunk produces no frames", () => {
    const parser = new FrameStreamParser()
    const frames = parser.feed(new Uint8Array(0))
    expect(frames).toHaveLength(0)
  })

  it("reset() clears partial state", () => {
    const frame = encodeBinaryFrame(
      complete(WIRE_VERSION, new Uint8Array([1, 2, 3])),
    )
    const parser = new FrameStreamParser()

    // Feed partial — should accumulate internally
    parser.feed(frame.slice(0, 4))

    // Reset — discard accumulated state
    parser.reset()

    // Feed a fresh complete frame — should get exactly one result
    const results = parser.feed(frame)
    expect(results).toHaveLength(1)
    const r = results[0]
    if (!r || !r.ok) throw new Error("expected ok result")
    expect(new Uint8Array(r.value)).toEqual(frame)
  })
})
