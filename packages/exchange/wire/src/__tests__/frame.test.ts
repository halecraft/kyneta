// Binary frame encode/decode tests.
//
// Verifies the 6-byte frame header (version + type + Uint32 payload length)
// for both complete and fragment frames, using wire-level message fixtures.
// Batching is orthogonal to framing — not tested here.

import {
  SYNC_AUTHORITATIVE,
  SYNC_COLLABORATIVE,
  SYNC_EPHEMERAL,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import {
  BinaryFrameType,
  FRAGMENT_META_SIZE,
  HEADER_SIZE,
  WIRE_VERSION,
} from "../constants.js"
import {
  decodeBinaryFrame,
  encodeBinaryFrame,
  FrameDecodeError,
} from "../frame.js"
import { complete, fragment, isComplete, isFragment } from "../frame-types.js"
import { decodeWireMessage, encodeWireMessage } from "../index.js"
import type { WireMessage } from "../wire-types.js"
import {
  departWire,
  establishWire,
  interestWire,
  offerWire,
  presentWire,
} from "./__helpers__/wire-fixtures.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the 6-byte frame header fields. */
function readHeader(frame: Uint8Array) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  return {
    version: view.getUint8(0),
    type: view.getUint8(1),
    payloadLength: view.getUint32(2, false),
  }
}

/**
 * Encode a WireMessage into a binary frame:
 * WireMessage → encodeWireMessage → binary frame.
 */
function encodeToFrame(wire: WireMessage): Uint8Array<ArrayBuffer> {
  const payload = encodeWireMessage(wire)
  return encodeBinaryFrame(complete(WIRE_VERSION, payload))
}

/**
 * Decode a binary frame payload back to a WireMessage:
 * binary frame payload → decodeWireMessage → WireMessage.
 */
function decodeFromFrame(payload: Uint8Array): WireMessage {
  return decodeWireMessage(payload)
}

// ---------------------------------------------------------------------------
// Complete frame encode/decode
// ---------------------------------------------------------------------------

describe("Binary frame — complete", () => {
  it("encodes a complete frame with correct 6-byte header", () => {
    const wire = presentWire([
      {
        docId: "doc-1",
        schemaHash: "00test",
        replicaType: ["plain", 1, 0],
        syncProtocol: SYNC_AUTHORITATIVE,
      },
    ])
    const frame = encodeToFrame(wire)

    expect(frame).toBeInstanceOf(Uint8Array)
    expect(frame.length).toBeGreaterThan(HEADER_SIZE)

    const header = readHeader(frame)
    expect(header.version).toBe(WIRE_VERSION)
    expect(header.type).toBe(BinaryFrameType.COMPLETE)
    expect(header.payloadLength).toBe(frame.length - HEADER_SIZE)
  })

  it("round-trips a present message", () => {
    const wire = presentWire([
      {
        docId: "a",
        schemaHash: "00test",
        replicaType: ["plain", 1, 0],
        syncProtocol: SYNC_AUTHORITATIVE,
      },
      {
        docId: "b",
        schemaHash: "00test",
        replicaType: ["yjs", 1, 0],
        syncProtocol: SYNC_COLLABORATIVE,
      },
      {
        docId: "c",
        schemaHash: "00test",
        replicaType: ["loro", 1, 0],
        syncProtocol: SYNC_EPHEMERAL,
      },
    ])
    const encoded = encodeToFrame(wire)
    const frame = decodeBinaryFrame(encoded)

    expect(isComplete(frame)).toBe(true)
    expect(frame.version).toBe(WIRE_VERSION)
    expect(frame.hash).toBeNull()

    const decoded = decodeFromFrame(frame.content.payload)
    expect(decoded).toEqual(wire)
  })

  it("round-trips an interest message", () => {
    const wire = interestWire({
      docId: "doc-xyz",
      version: "42",
      reciprocate: true,
    })
    const encoded = encodeToFrame(wire)
    const frame = decodeBinaryFrame(encoded)
    const decoded = decodeFromFrame(frame.content.payload)

    expect(decoded).toEqual(wire)
  })

  it("round-trips an offer with binary payload", () => {
    const binaryData = new Uint8Array([10, 20, 30, 40, 50])
    const wire = offerWire({
      docId: "doc-1",
      kind: "entirety",
      encoding: "binary",
      data: binaryData,
      version: "7",
    })
    const encoded = encodeToFrame(wire)
    const frame = decodeBinaryFrame(encoded)
    const decoded = decodeFromFrame(frame.content.payload)

    expect(decoded.t).toBe(wire.t)
    if (decoded.t === 0x12) {
      expect(decoded.pe).toBe(wire.pe)
      expect(decoded.d).toBeInstanceOf(Uint8Array)
      expect(decoded.d).toEqual(binaryData)
    }
  })

  it("round-trips an offer with JSON payload", () => {
    const wire = offerWire({
      docId: "doc-2",
      kind: "since",
      encoding: "json",
      data: '{"key":"value"}',
      version: "3",
      reciprocate: false,
    })
    const encoded = encodeToFrame(wire)
    const frame = decodeBinaryFrame(encoded)
    const decoded = decodeFromFrame(frame.content.payload)

    expect(decoded).toEqual(wire)
  })

  it("round-trips establish", () => {
    const wire = establishWire({
      peerId: "peer-1",
      name: "Alice",
      type: "user",
    })
    const encoded = encodeToFrame(wire)
    const frame = decodeBinaryFrame(encoded)
    const decoded = decodeFromFrame(frame.content.payload)

    expect(decoded).toEqual(wire)
  })

  it("round-trips depart", () => {
    const wire = departWire()
    const encoded = encodeToFrame(wire)
    const frame = decodeBinaryFrame(encoded)
    const decoded = decodeFromFrame(frame.content.payload)

    expect(decoded.t).toBe(wire.t)
  })
})

// ---------------------------------------------------------------------------
// Batch via complete frame (batching is codec-level)
// ---------------------------------------------------------------------------

describe("Binary frame — batch (via complete frame)", () => {
  it("encodes a batch as individual complete frames", () => {
    const wires: WireMessage[] = [
      presentWire([
        {
          docId: "d1",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0],
          syncProtocol: SYNC_AUTHORITATIVE,
        },
      ]),
      interestWire({ docId: "d1", version: "0" }),
    ]

    const frames = wires.map(w => encodeToFrame(w))

    // Each frame should have a valid complete header
    for (const frame of frames) {
      const header = readHeader(frame)
      expect(header.version).toBe(WIRE_VERSION)
      expect(header.type).toBe(BinaryFrameType.COMPLETE)
    }
  })

  it("round-trips a batch of mixed messages", () => {
    const wires: WireMessage[] = [
      establishWire({ peerId: "p1", name: "One", type: "user" }),
      presentWire([
        {
          docId: "d1",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0],
          syncProtocol: SYNC_AUTHORITATIVE,
        },
        {
          docId: "d2",
          schemaHash: "00test",
          replicaType: ["yjs", 1, 0],
          syncProtocol: SYNC_COLLABORATIVE,
        },
      ]),
      interestWire({ docId: "d1", version: "5", reciprocate: true }),
      offerWire({
        docId: "d1",
        kind: "since",
        encoding: "binary",
        data: new Uint8Array([1, 2, 3]),
        version: "6",
        reciprocate: false,
      }),
    ]

    const frames = wires.map(w => encodeToFrame(w))

    // Decode each frame and verify
    const decoded = frames.map(frame => {
      const decodedFrame = decodeBinaryFrame(frame)
      expect(isComplete(decodedFrame)).toBe(true)
      return decodeFromFrame(decodedFrame.content.payload)
    })

    expect(decoded).toHaveLength(4)
    expect(decoded[0]?.t).toBe(0x01) // Establish
    expect(decoded[1]?.t).toBe(0x10) // Present
    expect(decoded[2]?.t).toBe(0x11) // Interest
    expect(decoded[3]?.t).toBe(0x12) // Offer

    const offer = decoded[3]
    if (offer && offer.t === 0x12) {
      expect(offer.d).toEqual(new Uint8Array([1, 2, 3]))
    }
  })

  it("round-trips an empty batch (no frames produced)", () => {
    // An empty batch produces no frames — this is valid and expected.
    const wires: WireMessage[] = []
    const frames = wires.map(w => encodeToFrame(w))
    expect(frames).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Fragment frame encode/decode
// ---------------------------------------------------------------------------

describe("Binary frame — fragment", () => {
  it("encodes a fragment frame with correct header", () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc])
    const frame = fragment(WIRE_VERSION, 0xabcd, 2, 5, 1000, payload)
    const encoded = encodeBinaryFrame(frame)

    const header = readHeader(encoded)
    expect(header.version).toBe(WIRE_VERSION)
    expect(header.type).toBe(BinaryFrameType.FRAGMENT)
    expect(header.payloadLength).toBe(payload.length)
  })

  it("fragment frame size = header + fragment meta + payload", () => {
    const payload = new Uint8Array(42)
    const frame = fragment(WIRE_VERSION, 0xabcd, 0, 3, 126, payload)
    const encoded = encodeBinaryFrame(frame)

    expect(encoded.length).toBe(
      HEADER_SIZE + FRAGMENT_META_SIZE + payload.length,
    )
  })

  it("round-trips a fragment frame", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const frameId = 0xa1b2
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
    const frameId = 0
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
      0xffff,
      0xfffe,
      0xffff,
      0xffffffff,
      new Uint8Array([1]),
    )
    const encoded = encodeBinaryFrame(frame)
    const decoded = decodeBinaryFrame(encoded)

    if (decoded.content.kind === "fragment") {
      expect(decoded.content.index).toBe(0xfffe)
      expect(decoded.content.total).toBe(0xffff)
      expect(decoded.content.totalSize).toBe(0xffffffff)
    }
  })
})

// ---------------------------------------------------------------------------
// encodeBinaryFrame — generic
// ---------------------------------------------------------------------------

describe("Binary frame — encodeBinaryFrame generic", () => {
  it("encodes a complete frame from Frame<Uint8Array>", () => {
    const wire = presentWire([
      {
        docId: "x",
        schemaHash: "00test",
        replicaType: ["plain", 1, 0],
        syncProtocol: SYNC_AUTHORITATIVE,
      },
    ])
    const payload = encodeWireMessage(wire)
    const frame = complete(WIRE_VERSION, payload)
    const encoded = encodeBinaryFrame(frame)

    const decoded = decodeBinaryFrame(encoded)
    expect(isComplete(decoded)).toBe(true)
    expect(decoded.content.payload).toEqual(payload)
  })

  it("encodes a fragment frame from Frame<Uint8Array>", () => {
    const payload = new Uint8Array([10, 20, 30])
    const frame = fragment(WIRE_VERSION, 0x1234, 0, 2, 6, payload)
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
    try {
      decodeBinaryFrame(tooShort)
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(FrameDecodeError)
      expect((error as FrameDecodeError).code).toBe("truncated_frame")
      expect((error as FrameDecodeError).message).toContain("too short")
    }
  })

  it("rejects unsupported wire version", () => {
    const frame = new Uint8Array(HEADER_SIZE + 4)
    const view = new DataView(frame.buffer)
    view.setUint8(0, 0xff) // bad version
    view.setUint8(1, BinaryFrameType.COMPLETE)
    view.setUint32(2, 4, false)

    try {
      decodeBinaryFrame(frame)
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(FrameDecodeError)
      expect((error as FrameDecodeError).code).toBe("unsupported_version")
      expect((error as FrameDecodeError).message).toContain(
        "Unsupported wire version",
      )
    }
  })

  it("rejects truncated complete frame", () => {
    const frame = new Uint8Array(HEADER_SIZE + 2)
    const view = new DataView(frame.buffer)
    view.setUint8(0, WIRE_VERSION)
    view.setUint8(1, BinaryFrameType.COMPLETE)
    view.setUint32(2, 100, false) // claims 100 bytes but only 2 available

    expect(() => decodeBinaryFrame(frame)).toThrow(FrameDecodeError)
    expect(() => decodeBinaryFrame(frame)).toThrow("truncated")
  })

  it("rejects truncated fragment frame", () => {
    // Fragment frame needs header + fragment meta + payload
    // Create one that claims payload but is too short for fragment meta
    const frame = new Uint8Array(HEADER_SIZE + 5) // too short for 10-byte fragment meta
    const view = new DataView(frame.buffer)
    view.setUint8(0, WIRE_VERSION)
    view.setUint8(1, BinaryFrameType.FRAGMENT)
    view.setUint32(2, 1, false) // claims 1 byte payload

    expect(() => decodeBinaryFrame(frame)).toThrow(FrameDecodeError)
    expect(() => decodeBinaryFrame(frame)).toThrow("truncated")
  })

  it("rejects unknown frame type", () => {
    const frame = new Uint8Array(HEADER_SIZE + 4)
    const view = new DataView(frame.buffer)
    view.setUint8(0, WIRE_VERSION)
    view.setUint8(1, 0xff) // unknown type
    view.setUint32(2, 4, false)

    try {
      decodeBinaryFrame(frame)
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(FrameDecodeError)
      expect((error as FrameDecodeError).code).toBe("invalid_type")
      expect((error as FrameDecodeError).message).toContain(
        "Unknown frame type",
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("Binary frame — edge cases", () => {
  it("normalizes Buffer subclass input", () => {
    const wire = presentWire([
      {
        docId: "test",
        schemaHash: "00test",
        replicaType: ["plain", 1, 0],
        syncProtocol: SYNC_AUTHORITATIVE,
      },
    ])
    const encoded = encodeToFrame(wire)

    // Create a copy via ArrayBuffer (simulates Buffer → Uint8Array path)
    const copy = new Uint8Array(encoded.buffer.slice(0))
    const frame = decodeBinaryFrame(copy)

    expect(isComplete(frame)).toBe(true)
    const decoded = decodeFromFrame(frame.content.payload)
    expect(decoded).toEqual(wire)
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
      0x1234,
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
