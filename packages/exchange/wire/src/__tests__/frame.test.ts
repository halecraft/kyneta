// Frame encode/decode tests.
//
// Verifies the 6-byte frame header (version + flags + Uint32 payload length)
// for both single and batch frames, using both CBOR and JSON codecs.

import { describe, expect, it } from "vitest"
import { encodeFrame, encodeBatchFrame, decodeFrame, FrameDecodeError } from "../frame.js"
import { cborCodec } from "../cbor.js"
import { jsonCodec } from "../json.js"
import { WIRE_VERSION, HEADER_SIZE, FrameFlags } from "../constants.js"
import type { ChannelMsg, DiscoverMsg, InterestMsg, OfferMsg } from "@kyneta/exchange"
import type { MessageCodec } from "../codec.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the 6-byte frame header fields. */
function readHeader(frame: Uint8Array) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  return {
    version: view.getUint8(0),
    flags: view.getUint8(1),
    payloadLength: view.getUint32(2, false),
  }
}

// Run the same suite for both codecs
const codecs: [string, MessageCodec][] = [
  ["CBOR", cborCodec],
  ["JSON", jsonCodec],
]

// ---------------------------------------------------------------------------
// Single frame encode/decode
// ---------------------------------------------------------------------------

describe.each(codecs)("Frame (%s) — single message", (_name, codec) => {
  it("encodes a frame with correct header", () => {
    const msg: DiscoverMsg = { type: "discover", docIds: ["doc-1"] }
    const frame = encodeFrame(codec, msg)

    expect(frame).toBeInstanceOf(Uint8Array)
    expect(frame.length).toBeGreaterThan(HEADER_SIZE)

    const header = readHeader(frame)
    expect(header.version).toBe(WIRE_VERSION)
    expect(header.flags).toBe(FrameFlags.NONE)
    expect(header.payloadLength).toBe(frame.length - HEADER_SIZE)
  })

  it("round-trips a discover message", () => {
    const msg: DiscoverMsg = { type: "discover", docIds: ["a", "b", "c"] }
    const frame = encodeFrame(codec, msg)
    const decoded = decodeFrame(codec, frame)

    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toEqual(msg)
  })

  it("round-trips an interest message", () => {
    const msg: InterestMsg = {
      type: "interest",
      docId: "doc-xyz",
      version: "42",
      reciprocate: true,
    }
    const frame = encodeFrame(codec, msg)
    const decoded = decodeFrame(codec, frame)

    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toEqual(msg)
  })

  it("round-trips an offer with binary payload", () => {
    const binaryData = new Uint8Array([10, 20, 30, 40, 50])
    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-1",
      offerType: "snapshot",
      payload: { encoding: "binary", data: binaryData },
      version: "7",
    }
    const frame = encodeFrame(codec, msg)
    const decoded = decodeFrame(codec, frame)

    expect(decoded).toHaveLength(1)
    const offer = decoded[0] as OfferMsg
    expect(offer.type).toBe("offer")
    expect(offer.payload.encoding).toBe("binary")
    expect(offer.payload.data).toBeInstanceOf(Uint8Array)
    expect(offer.payload.data).toEqual(binaryData)
  })

  it("round-trips an offer with JSON payload", () => {
    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-2",
      offerType: "delta",
      payload: { encoding: "json", data: '{"key":"value"}' },
      version: "3",
      reciprocate: false,
    }
    const frame = encodeFrame(codec, msg)
    const decoded = decodeFrame(codec, frame)

    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toEqual(msg)
  })

  it("round-trips establish-request", () => {
    const msg: ChannelMsg = {
      type: "establish-request",
      identity: { peerId: "peer-1", name: "Alice", type: "user" },
    }
    const frame = encodeFrame(codec, msg)
    const decoded = decodeFrame(codec, frame)

    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toEqual(msg)
  })

  it("round-trips establish-response", () => {
    const msg: ChannelMsg = {
      type: "establish-response",
      identity: { peerId: "peer-2", type: "service" },
    }
    const frame = encodeFrame(codec, msg)
    const decoded = decodeFrame(codec, frame)

    expect(decoded).toHaveLength(1)
    expect(decoded[0]!.type).toBe("establish-response")
  })
})

// ---------------------------------------------------------------------------
// Batch frame encode/decode
// ---------------------------------------------------------------------------

describe.each(codecs)("Frame (%s) — batch", (_name, codec) => {
  it("encodes a batch frame with BATCH flag", () => {
    const msgs: ChannelMsg[] = [
      { type: "discover", docIds: ["d1"] },
      { type: "interest", docId: "d1", version: "0" },
    ]
    const frame = encodeBatchFrame(codec, msgs)

    const header = readHeader(frame)
    expect(header.version).toBe(WIRE_VERSION)
    expect(header.flags & FrameFlags.BATCH).toBeTruthy()
    expect(header.payloadLength).toBe(frame.length - HEADER_SIZE)
  })

  it("round-trips a batch of mixed messages", () => {
    const msgs: ChannelMsg[] = [
      {
        type: "establish-request",
        identity: { peerId: "p1", name: "One", type: "user" },
      },
      { type: "discover", docIds: ["d1", "d2"] },
      { type: "interest", docId: "d1", version: "5", reciprocate: true },
      {
        type: "offer",
        docId: "d1",
        offerType: "delta",
        payload: { encoding: "binary", data: new Uint8Array([1, 2, 3]) },
        version: "6",
        reciprocate: false,
      },
    ]
    const frame = encodeBatchFrame(codec, msgs)
    const decoded = decodeFrame(codec, frame)

    expect(decoded).toHaveLength(4)
    expect(decoded[0]!.type).toBe("establish-request")
    expect(decoded[1]!.type).toBe("discover")
    expect(decoded[2]!.type).toBe("interest")
    expect(decoded[3]!.type).toBe("offer")

    // Verify binary payload survived
    const offer = decoded[3] as OfferMsg
    expect(offer.payload.data).toEqual(new Uint8Array([1, 2, 3]))
  })

  it("round-trips an empty batch", () => {
    const frame = encodeBatchFrame(codec, [])
    const decoded = decodeFrame(codec, frame)
    expect(decoded).toEqual([])
  })

  it("round-trips a single-element batch", () => {
    const msgs: ChannelMsg[] = [{ type: "discover", docIds: ["only-one"] }]
    const frame = encodeBatchFrame(codec, msgs)
    const decoded = decodeFrame(codec, frame)

    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toEqual(msgs[0])
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("Frame — error handling", () => {
  it("rejects frame shorter than header size", () => {
    const tooShort = new Uint8Array(3)
    expect(() => decodeFrame(cborCodec, tooShort)).toThrow(FrameDecodeError)
    expect(() => decodeFrame(cborCodec, tooShort)).toThrow("too short")
  })

  it("rejects unsupported wire version", () => {
    // Create a valid-length frame with wrong version
    const frame = new Uint8Array(HEADER_SIZE + 4)
    const view = new DataView(frame.buffer)
    view.setUint8(0, 0xff) // bad version
    view.setUint8(1, FrameFlags.NONE)
    view.setUint32(2, 4, false)

    expect(() => decodeFrame(cborCodec, frame)).toThrow(FrameDecodeError)
    expect(() => decodeFrame(cborCodec, frame)).toThrow("Unsupported wire version")
  })

  it("rejects truncated frame (payload shorter than declared)", () => {
    const frame = new Uint8Array(HEADER_SIZE + 2)
    const view = new DataView(frame.buffer)
    view.setUint8(0, WIRE_VERSION)
    view.setUint8(1, FrameFlags.NONE)
    view.setUint32(2, 100, false) // claims 100 bytes but only 2 available

    expect(() => decodeFrame(cborCodec, frame)).toThrow(FrameDecodeError)
    expect(() => decodeFrame(cborCodec, frame)).toThrow("truncated")
  })

  it("rejects frame with invalid payload and reports 'decode_failed' code", () => {
    // Create a frame with valid header but garbage payload
    const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    const frame = new Uint8Array(HEADER_SIZE + garbage.length)
    const view = new DataView(frame.buffer)
    view.setUint8(0, WIRE_VERSION)
    view.setUint8(1, FrameFlags.NONE)
    view.setUint32(2, garbage.length, false)
    frame.set(garbage, HEADER_SIZE)

    try {
      decodeFrame(cborCodec, frame)
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(FrameDecodeError)
      expect((error as FrameDecodeError).code).toBe("decode_failed")
    }
  })

  it("FrameDecodeError has correct code property", () => {
    const tooShort = new Uint8Array(2)
    try {
      decodeFrame(cborCodec, tooShort)
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(FrameDecodeError)
      expect((error as FrameDecodeError).code).toBe("truncated_frame")
    }
  })

  it("FrameDecodeError code is 'unsupported_version' for wrong version", () => {
    const frame = new Uint8Array(HEADER_SIZE)
    const view = new DataView(frame.buffer)
    view.setUint8(0, 99) // wrong version
    view.setUint8(1, 0)
    view.setUint32(2, 0, false)

    try {
      decodeFrame(cborCodec, frame)
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(FrameDecodeError)
      expect((error as FrameDecodeError).code).toBe("unsupported_version")
    }
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Frame — edge cases", () => {
  it("handles zero-length payload (valid for empty batch)", () => {
    // An empty batch with JSON codec: encodeBatchFrame produces a valid frame
    const frame = encodeBatchFrame(jsonCodec, [])
    const header = readHeader(frame)

    // Payload should be "[]" (2 bytes for JSON) or similar
    expect(header.payloadLength).toBeGreaterThan(0)

    const decoded = decodeFrame(jsonCodec, frame)
    expect(decoded).toEqual([])
  })

  it("handles frame with exact header size when payload length is 0", () => {
    // Manually create a frame with 0-length payload
    const frame = new Uint8Array(HEADER_SIZE)
    const view = new DataView(frame.buffer)
    view.setUint8(0, WIRE_VERSION)
    view.setUint8(1, FrameFlags.NONE)
    view.setUint32(2, 0, false)

    // This should fail during decode because 0 bytes isn't valid CBOR/JSON
    expect(() => decodeFrame(cborCodec, frame)).toThrow()
  })

  it("normalizes Buffer subclass input", () => {
    // Encode a message, then create a new Uint8Array from it
    // (simulating what happens when Buffer is converted)
    const msg: DiscoverMsg = { type: "discover", docIds: ["test"] }
    const frame = encodeFrame(cborCodec, msg)

    // Create a copy via ArrayBuffer (simulates Buffer → Uint8Array path)
    const copy = new Uint8Array(frame.buffer.slice(0))
    const decoded = decodeFrame(cborCodec, copy)

    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toEqual(msg)
  })
})