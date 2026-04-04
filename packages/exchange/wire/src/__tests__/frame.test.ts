// Binary frame encode/decode tests.
//
// Verifies the 7-byte frame header (version + type + hashAlgo + Uint32 payload length)
// for both complete and fragment frames, using cborCodec only.
// Batching is orthogonal to framing — not tested here.

import type {
  ChannelMsg,
  InterestMsg,
  OfferMsg,
  PresentMsg,
} from "@kyneta/exchange"
import { describe, expect, it } from "vitest"
import { cborCodec } from "../cbor.js"
import {
  BinaryFrameType,
  FRAGMENT_META_SIZE,
  HASH_ALGO,
  HEADER_SIZE,
  WIRE_VERSION,
} from "../constants.js"
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  encodeComplete,
  encodeCompleteBatch,
  FrameDecodeError,
} from "../frame.js"
import { complete, fragment, isComplete, isFragment } from "../frame-types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the 7-byte frame header fields. */
function readHeader(frame: Uint8Array) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  return {
    version: view.getUint8(0),
    type: view.getUint8(1),
    hashAlgo: view.getUint8(2),
    payloadLength: view.getUint32(3, false),
  }
}

// ---------------------------------------------------------------------------
// Complete frame encode/decode
// ---------------------------------------------------------------------------

describe("Binary frame — complete", () => {
  it("encodes a complete frame with correct 7-byte header", () => {
    const msg: PresentMsg = {
      type: "present",
      docs: [
        {
          docId: "doc-1",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "sequential" as const,
        },
      ],
    }
    const frame = encodeComplete(cborCodec, msg)

    expect(frame).toBeInstanceOf(Uint8Array)
    expect(frame.length).toBeGreaterThan(HEADER_SIZE)

    const header = readHeader(frame)
    expect(header.version).toBe(WIRE_VERSION)
    expect(header.type).toBe(BinaryFrameType.COMPLETE)
    expect(header.hashAlgo).toBe(HASH_ALGO.NONE)
    expect(header.payloadLength).toBe(frame.length - HEADER_SIZE)
  })

  it("round-trips a present message", () => {
    const msg: PresentMsg = {
      type: "present",
      docs: [
        {
          docId: "a",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "sequential" as const,
        },
        {
          docId: "b",
          schemaHash: "00test",
          replicaType: ["yjs", 1, 0] as const,
          mergeStrategy: "causal" as const,
        },
        {
          docId: "c",
          schemaHash: "00test",
          replicaType: ["loro", 1, 0] as const,
          mergeStrategy: "lww" as const,
        },
      ],
    }
    const encoded = encodeComplete(cborCodec, msg)
    const frame = decodeBinaryFrame(encoded)

    expect(isComplete(frame)).toBe(true)
    expect(frame.version).toBe(WIRE_VERSION)
    expect(frame.hash).toBeNull()

    const decoded = cborCodec.decode(frame.content.payload)
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
    const encoded = encodeComplete(cborCodec, msg)
    const frame = decodeBinaryFrame(encoded)
    const decoded = cborCodec.decode(frame.content.payload)

    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toEqual(msg)
  })

  it("round-trips an offer with binary payload", () => {
    const binaryData = new Uint8Array([10, 20, 30, 40, 50])
    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-1",
      payload: { kind: "entirety", encoding: "binary", data: binaryData },
      version: "7",
    }
    const encoded = encodeComplete(cborCodec, msg)
    const frame = decodeBinaryFrame(encoded)
    const decoded = cborCodec.decode(frame.content.payload)
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
      payload: { kind: "since", encoding: "json", data: '{"key":"value"}' },
      version: "3",
      reciprocate: false,
    }
    const encoded = encodeComplete(cborCodec, msg)
    const frame = decodeBinaryFrame(encoded)
    const decoded = cborCodec.decode(frame.content.payload)

    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toEqual(msg)
  })

  it("round-trips establish-request", () => {
    const msg: ChannelMsg = {
      type: "establish-request",
      identity: { peerId: "peer-1", name: "Alice", type: "user" },
    }
    const encoded = encodeComplete(cborCodec, msg)
    const frame = decodeBinaryFrame(encoded)
    const decoded = cborCodec.decode(frame.content.payload)

    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toEqual(msg)
  })

  it("round-trips establish-response", () => {
    const msg: ChannelMsg = {
      type: "establish-response",
      identity: { peerId: "peer-2", type: "service" },
    }
    const encoded = encodeComplete(cborCodec, msg)
    const frame = decodeBinaryFrame(encoded)
    const decoded = cborCodec.decode(frame.content.payload)

    expect(decoded).toHaveLength(1)
    expect(decoded[0]?.type).toBe("establish-response")
  })
})

// ---------------------------------------------------------------------------
// Batch via complete frame (batching is codec-level)
// ---------------------------------------------------------------------------

describe("Binary frame — batch (via complete frame)", () => {
  it("encodes a batch as a complete frame (no BATCH flag)", () => {
    const msgs: ChannelMsg[] = [
      {
        type: "present",
        docs: [
          {
            docId: "d1",
            schemaHash: "00test",
            replicaType: ["plain", 1, 0] as const,
            mergeStrategy: "sequential" as const,
          },
        ],
      },
      { type: "interest", docId: "d1", version: "0" },
    ]
    const encoded = encodeCompleteBatch(cborCodec, msgs)

    const header = readHeader(encoded)
    expect(header.version).toBe(WIRE_VERSION)
    expect(header.type).toBe(BinaryFrameType.COMPLETE)
    expect(header.hashAlgo).toBe(HASH_ALGO.NONE)
  })

  it("round-trips a batch of mixed messages", () => {
    const msgs: ChannelMsg[] = [
      {
        type: "establish-request",
        identity: { peerId: "p1", name: "One", type: "user" },
      },
      {
        type: "present",
        docs: [
          {
            docId: "d1",
            schemaHash: "00test",
            replicaType: ["plain", 1, 0] as const,
            mergeStrategy: "sequential" as const,
          },
          {
            docId: "d2",
            schemaHash: "00test",
            replicaType: ["yjs", 1, 0] as const,
            mergeStrategy: "causal" as const,
          },
        ],
      },
      { type: "interest", docId: "d1", version: "5", reciprocate: true },
      {
        type: "offer",
        docId: "d1",
        payload: {
          kind: "since",
          encoding: "binary",
          data: new Uint8Array([1, 2, 3]),
        },
        version: "6",
        reciprocate: false,
      },
    ]
    const encoded = encodeCompleteBatch(cborCodec, msgs)
    const frame = decodeBinaryFrame(encoded)

    expect(isComplete(frame)).toBe(true)
    const decoded = cborCodec.decode(frame.content.payload)

    expect(decoded).toHaveLength(4)
    expect(decoded[0]?.type).toBe("establish-request")
    expect(decoded[1]?.type).toBe("present")
    expect(decoded[2]?.type).toBe("interest")
    expect(decoded[3]?.type).toBe("offer")

    const offer = decoded[3] as OfferMsg
    expect(offer.payload.data).toEqual(new Uint8Array([1, 2, 3]))
  })

  it("round-trips an empty batch", () => {
    const encoded = encodeCompleteBatch(cborCodec, [])
    const frame = decodeBinaryFrame(encoded)
    const decoded = cborCodec.decode(frame.content.payload)
    expect(decoded).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Fragment frame encode/decode
// ---------------------------------------------------------------------------

describe("Binary frame — fragment", () => {
  it("encodes a fragment frame with correct header", () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc])
    const frame = fragment(
      WIRE_VERSION,
      "abcdef0123456789",
      2,
      5,
      1000,
      payload,
    )
    const encoded = encodeBinaryFrame(frame)

    const header = readHeader(encoded)
    expect(header.version).toBe(WIRE_VERSION)
    expect(header.type).toBe(BinaryFrameType.FRAGMENT)
    expect(header.hashAlgo).toBe(HASH_ALGO.NONE)
    expect(header.payloadLength).toBe(payload.length)
  })

  it("fragment frame size = header + fragment meta + payload", () => {
    const payload = new Uint8Array(42)
    const frame = fragment(WIRE_VERSION, "abcdef0123456789", 0, 3, 126, payload)
    const encoded = encodeBinaryFrame(frame)

    expect(encoded.length).toBe(
      HEADER_SIZE + FRAGMENT_META_SIZE + payload.length,
    )
  })

  it("round-trips a fragment frame", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const frameId = "a1b2c3d4e5f60718"
    const original = fragment(WIRE_VERSION, frameId, 3, 10, 500, payload)
    const encoded = encodeBinaryFrame(original)
    const decoded = decodeBinaryFrame(encoded)

    expect(isFragment(decoded)).toBe(true)
    expect(decoded.version).toBe(WIRE_VERSION)
    expect(decoded.hash).toBeNull()

    if (decoded.content.kind === "fragment") {
      expect(decoded.content.frameId).toBe(frameId)
      expect(decoded.content.index).toBe(3)
      expect(decoded.content.total).toBe(10)
      expect(decoded.content.totalSize).toBe(500)
      expect(decoded.content.payload).toEqual(payload)
    }
  })

  it("preserves frameId through round-trip", () => {
    const frameId = "0000000000000000"
    const frame = fragment(WIRE_VERSION, frameId, 0, 1, 5, new Uint8Array([42]))
    const encoded = encodeBinaryFrame(frame)
    const decoded = decodeBinaryFrame(encoded)

    if (decoded.content.kind === "fragment") {
      expect(decoded.content.frameId).toBe(frameId)
    }
  })

  it("handles max values for index and total", () => {
    const frame = fragment(
      WIRE_VERSION,
      "ffffffffffffffff",
      0xfffffffe,
      0xffffffff,
      0xffffffff,
      new Uint8Array([1]),
    )
    const encoded = encodeBinaryFrame(frame)
    const decoded = decodeBinaryFrame(encoded)

    if (decoded.content.kind === "fragment") {
      expect(decoded.content.index).toBe(0xfffffffe)
      expect(decoded.content.total).toBe(0xffffffff)
      expect(decoded.content.totalSize).toBe(0xffffffff)
    }
  })
})

// ---------------------------------------------------------------------------
// encodeBinaryFrame — generic
// ---------------------------------------------------------------------------

describe("Binary frame — encodeBinaryFrame generic", () => {
  it("encodes a complete frame from Frame<Uint8Array>", () => {
    const payload = cborCodec.encode({
      type: "present",
      docs: [
        {
          docId: "x",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "sequential" as const,
        },
      ],
    })
    const frame = complete(WIRE_VERSION, payload)
    const encoded = encodeBinaryFrame(frame)

    const decoded = decodeBinaryFrame(encoded)
    expect(isComplete(decoded)).toBe(true)
    expect(decoded.content.payload).toEqual(payload)
  })

  it("encodes a fragment frame from Frame<Uint8Array>", () => {
    const payload = new Uint8Array([10, 20, 30])
    const frame = fragment(WIRE_VERSION, "1234567890abcdef", 0, 2, 6, payload)
    const encoded = encodeBinaryFrame(frame)

    const decoded = decodeBinaryFrame(encoded)
    expect(isFragment(decoded)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("Binary frame — error handling", () => {
  it("rejects frame shorter than header size", () => {
    const tooShort = new Uint8Array(3)
    expect(() => decodeBinaryFrame(tooShort)).toThrow(FrameDecodeError)
    expect(() => decodeBinaryFrame(tooShort)).toThrow("too short")
  })

  it("rejects unsupported wire version", () => {
    const frame = new Uint8Array(HEADER_SIZE + 4)
    const view = new DataView(frame.buffer)
    view.setUint8(0, 0xff) // bad version
    view.setUint8(1, BinaryFrameType.COMPLETE)
    view.setUint8(2, HASH_ALGO.NONE)
    view.setUint32(3, 4, false)

    expect(() => decodeBinaryFrame(frame)).toThrow(FrameDecodeError)
    expect(() => decodeBinaryFrame(frame)).toThrow("Unsupported wire version")
  })

  it("rejects truncated complete frame", () => {
    const frame = new Uint8Array(HEADER_SIZE + 2)
    const view = new DataView(frame.buffer)
    view.setUint8(0, WIRE_VERSION)
    view.setUint8(1, BinaryFrameType.COMPLETE)
    view.setUint8(2, HASH_ALGO.NONE)
    view.setUint32(3, 100, false) // claims 100 bytes but only 2 available

    expect(() => decodeBinaryFrame(frame)).toThrow(FrameDecodeError)
    expect(() => decodeBinaryFrame(frame)).toThrow("truncated")
  })

  it("rejects truncated fragment frame", () => {
    // Fragment frame needs header + fragment meta + payload
    // Create one that claims payload but is too short for fragment meta
    const frame = new Uint8Array(HEADER_SIZE + 5) // too short for 20-byte fragment meta
    const view = new DataView(frame.buffer)
    view.setUint8(0, WIRE_VERSION)
    view.setUint8(1, BinaryFrameType.FRAGMENT)
    view.setUint8(2, HASH_ALGO.NONE)
    view.setUint32(3, 1, false) // claims 1 byte payload

    expect(() => decodeBinaryFrame(frame)).toThrow(FrameDecodeError)
    expect(() => decodeBinaryFrame(frame)).toThrow("truncated")
  })

  it("rejects unknown frame type", () => {
    const frame = new Uint8Array(HEADER_SIZE + 4)
    const view = new DataView(frame.buffer)
    view.setUint8(0, WIRE_VERSION)
    view.setUint8(1, 0xff) // unknown type
    view.setUint8(2, HASH_ALGO.NONE)
    view.setUint32(3, 4, false)

    expect(() => decodeBinaryFrame(frame)).toThrow(FrameDecodeError)
    expect(() => decodeBinaryFrame(frame)).toThrow("Unknown frame type")
  })

  it("rejects unsupported hash algorithm", () => {
    const frame = new Uint8Array(HEADER_SIZE + 4)
    const view = new DataView(frame.buffer)
    view.setUint8(0, WIRE_VERSION)
    view.setUint8(1, BinaryFrameType.COMPLETE)
    view.setUint8(2, 0xfe) // unknown hash algo
    view.setUint32(3, 4, false)

    expect(() => decodeBinaryFrame(frame)).toThrow(FrameDecodeError)
    expect(() => decodeBinaryFrame(frame)).toThrow("Unsupported hash")
  })

  it("FrameDecodeError has correct code for truncated frame", () => {
    const tooShort = new Uint8Array(2)
    try {
      decodeBinaryFrame(tooShort)
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(FrameDecodeError)
      expect((error as FrameDecodeError).code).toBe("truncated_frame")
    }
  })

  it("FrameDecodeError has correct code for unsupported version", () => {
    const frame = new Uint8Array(HEADER_SIZE)
    const view = new DataView(frame.buffer)
    view.setUint8(0, 99) // wrong version
    view.setUint8(1, BinaryFrameType.COMPLETE)
    view.setUint8(2, HASH_ALGO.NONE)
    view.setUint32(3, 0, false)

    try {
      decodeBinaryFrame(frame)
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(FrameDecodeError)
      expect((error as FrameDecodeError).code).toBe("unsupported_version")
    }
  })

  it("FrameDecodeError has correct code for invalid type", () => {
    const frame = new Uint8Array(HEADER_SIZE + 1)
    const view = new DataView(frame.buffer)
    view.setUint8(0, WIRE_VERSION)
    view.setUint8(1, 0xab) // invalid type
    view.setUint8(2, HASH_ALGO.NONE)
    view.setUint32(3, 1, false)

    try {
      decodeBinaryFrame(frame)
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(FrameDecodeError)
      expect((error as FrameDecodeError).code).toBe("invalid_type")
    }
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Binary frame — edge cases", () => {
  it("normalizes Buffer subclass input", () => {
    const msg: PresentMsg = {
      type: "present",
      docs: [
        {
          docId: "test",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "sequential" as const,
        },
      ],
    }
    const encoded = encodeComplete(cborCodec, msg)

    // Create a copy via ArrayBuffer (simulates Buffer → Uint8Array path)
    const copy = new Uint8Array(encoded.buffer.slice(0))
    const frame = decodeBinaryFrame(copy)

    expect(isComplete(frame)).toBe(true)
    const decoded = cborCodec.decode(frame.content.payload)
    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toEqual(msg)
  })

  it("complete frame with empty payload is valid (header-only)", () => {
    // A complete frame with 0-length payload is structurally valid
    // (though the codec may fail to decode it)
    const frame = complete(WIRE_VERSION, new Uint8Array(0))
    const encoded = encodeBinaryFrame(frame)

    const decoded = decodeBinaryFrame(encoded)
    expect(isComplete(decoded)).toBe(true)
    expect(decoded.content.payload.length).toBe(0)
  })

  it("fragment frame with 1-byte payload", () => {
    const frame = fragment(
      WIRE_VERSION,
      "1234567890abcdef",
      0,
      1,
      1,
      new Uint8Array([0xff]),
    )
    const encoded = encodeBinaryFrame(frame)
    const decoded = decodeBinaryFrame(encoded)

    if (decoded.content.kind === "fragment") {
      expect(decoded.content.payload).toEqual(new Uint8Array([0xff]))
      expect(decoded.content.totalSize).toBe(1)
    }
  })
})
