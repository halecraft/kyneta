// stream-frame-parser.test — unit tests for the pure stream frame parser.
//
// Tests the behavioral contracts of feedBytes:
// 1. Single frame extraction (the base case)
// 2. Write coalescing (multiple frames in one chunk)
// 3. Arbitrary chunk boundaries (byte-at-a-time as the extreme case)
// 4. Round-trip encode → parse → decode correctness
// 5. Empty chunks are no-ops
// 6. Zero-length payload frames
// 7. Large payloads delivered in small chunks
//
// The byte-at-a-time test subsumes all partial-header / partial-payload /
// boundary-crossing variants — if it passes, every possible split point works.

import { SYNC_AUTHORITATIVE } from "@kyneta/schema"
import type { ChannelMsg, InterestMsg, PresentMsg } from "@kyneta/transport"
import { describe, expect, it } from "vitest"
import { cborCodec } from "../cbor.js"
import { HEADER_SIZE, WIRE_VERSION } from "../constants.js"
import { decodeBinaryFrame, encodeComplete } from "../frame.js"
import { feedBytes, initialParserState } from "../stream-frame-parser.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePresent(docId: string): PresentMsg {
  return {
    type: "present",
    docs: [
      {
        docId,
        schemaHash: "00test",
        replicaType: ["plain", 1, 0] as const,
        syncProtocol: SYNC_AUTHORITATIVE,
      },
    ],
  }
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const a of arrays) {
    result.set(a, offset)
    offset += a.length
  }
  return result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("feedBytes", () => {
  it("extracts a single complete frame from one chunk", () => {
    const frame = encodeComplete(cborCodec, makePresent("doc-1"))
    const state = initialParserState()

    const result = feedBytes(state, frame)

    expect(result.frames).toHaveLength(1)
    expect(result.frames[0]).toEqual(frame)
    expect(result.state.phase).toBe("header")
    expect(result.state.offset).toBe(0)
  })

  it("extracts multiple frames from one chunk (write coalescing)", () => {
    const frame1 = encodeComplete(cborCodec, makePresent("doc-a"))
    const frame2 = encodeComplete(cborCodec, makePresent("doc-b"))
    const frame3 = encodeComplete(cborCodec, makePresent("doc-c"))
    const combined = concat(frame1, frame2, frame3)

    const result = feedBytes(initialParserState(), combined)

    expect(result.frames).toHaveLength(3)
    expect(result.frames[0]).toEqual(frame1)
    expect(result.frames[1]).toEqual(frame2)
    expect(result.frames[2]).toEqual(frame3)
  })

  it("handles byte-at-a-time delivery (subsumes all split-boundary cases)", () => {
    const frame = encodeComplete(cborCodec, makePresent("byte-by-byte"))

    let state = initialParserState()
    const allFrames: Uint8Array[] = []

    for (let i = 0; i < frame.length; i++) {
      const result = feedBytes(state, frame.slice(i, i + 1))
      allFrames.push(...result.frames)
      state = result.state
    }

    expect(allFrames).toHaveLength(1)
    expect(allFrames[0]).toEqual(frame)
  })

  it("round-trips: encode → feedBytes → decodeBinaryFrame → decode → matches original", () => {
    const messages: ChannelMsg[] = [
      makePresent("seq-1"),
      { type: "interest", docId: "seq-2" } satisfies InterestMsg,
      makePresent("seq-3"),
    ]

    const frames = messages.map(msg => encodeComplete(cborCodec, msg))
    const combined = concat(...frames)

    const result = feedBytes(initialParserState(), combined)
    expect(result.frames).toHaveLength(3)

    for (let i = 0; i < 3; i++) {
      const frameBytes = result.frames.at(i)
      if (!frameBytes) throw new Error(`Expected frame at index ${i}`)
      const decoded = decodeBinaryFrame(frameBytes)
      expect(decoded.content.kind).toBe("complete")
      if (decoded.content.kind === "complete") {
        const decoded_msgs = cborCodec.decode(decoded.content.payload)
        expect(decoded_msgs).toHaveLength(1)
        expect(decoded_msgs[0]).toEqual(messages[i])
      }
    }
  })

  it("empty chunk is a no-op at any parse phase", () => {
    const frame = encodeComplete(cborCodec, makePresent("doc-empty"))
    const empty = new Uint8Array(0)

    // Empty at start
    const state = initialParserState()
    const r1 = feedBytes(state, empty)
    expect(r1.frames).toHaveLength(0)

    // Empty mid-header
    const r2 = feedBytes(state, frame.slice(0, 3))
    const r3 = feedBytes(r2.state, empty)
    expect(r3.frames).toHaveLength(0)
    expect(r3.state.phase).toBe("header")
    expect(r3.state.offset).toBe(3)

    // Empty mid-payload
    const r4 = feedBytes(state, frame.slice(0, HEADER_SIZE + 1))
    const r5 = feedBytes(r4.state, empty)
    expect(r5.frames).toHaveLength(0)
    expect(r5.state.phase).toBe("payload")

    // Complete after empty
    const r6 = feedBytes(r3.state, frame.slice(3))
    expect(r6.frames).toHaveLength(1)
    expect(r6.frames[0]).toEqual(frame)
  })

  it("handles zero-length payload frames", () => {
    // Construct a frame with payloadLength = 0 (header only, 6 bytes)
    const frame = new Uint8Array(HEADER_SIZE)
    const view = new DataView(frame.buffer)
    view.setUint8(0, WIRE_VERSION) // version
    view.setUint8(1, 0x00) // type COMPLETE
    view.setUint32(2, 0, false) // payloadLength = 0

    const result = feedBytes(initialParserState(), frame)

    expect(result.frames).toHaveLength(1)
    expect(result.frames[0]).toEqual(frame)
    expect(result.state.phase).toBe("header")
    expect(result.state.offset).toBe(0)
  })

  it("handles zero-length payload followed by a normal frame", () => {
    const zeroFrame = new Uint8Array(HEADER_SIZE)
    const view = new DataView(zeroFrame.buffer)
    view.setUint8(0, WIRE_VERSION)
    view.setUint8(1, 0x00)
    view.setUint32(2, 0, false)

    const normalFrame = encodeComplete(cborCodec, makePresent("after-zero"))
    const combined = concat(zeroFrame, normalFrame)

    const result = feedBytes(initialParserState(), combined)

    expect(result.frames).toHaveLength(2)
    expect(result.frames[0]).toEqual(zeroFrame)
    expect(result.frames[1]).toEqual(normalFrame)
  })

  it("handles large payload delivered in small chunks", () => {
    const docs: PresentMsg["docs"] = []
    for (let i = 0; i < 5000; i++) {
      docs.push({
        docId: `large-doc-${i.toString().padStart(5, "0")}`,
        schemaHash: "00test",
        replicaType: ["plain", 1, 0] as const,
        syncProtocol: SYNC_AUTHORITATIVE,
      })
    }

    const original: PresentMsg = { type: "present", docs }
    const frameBytes = encodeComplete(cborCodec, original)

    // Feed in 4KB chunks
    const chunkSize = 4096
    let state = initialParserState()
    const allFrames: Uint8Array[] = []

    for (let offset = 0; offset < frameBytes.length; offset += chunkSize) {
      const chunk = frameBytes.slice(
        offset,
        Math.min(offset + chunkSize, frameBytes.length),
      )
      const result = feedBytes(state, chunk)
      allFrames.push(...result.frames)
      state = result.state
    }

    expect(allFrames).toHaveLength(1)
    expect(allFrames[0]).toEqual(frameBytes)

    // Verify round-trip decode
    const firstFrame = allFrames.at(0)
    if (!firstFrame) throw new Error("Expected at least one frame")
    const decoded = decodeBinaryFrame(firstFrame)
    expect(decoded.content.kind).toBe("complete")
    if (decoded.content.kind === "complete") {
      const messages = cborCodec.decode(decoded.content.payload)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toEqual(original)
    }
  })
})
