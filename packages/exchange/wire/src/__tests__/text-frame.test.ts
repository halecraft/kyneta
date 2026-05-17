// Text frame encode/decode tests.
//
// Verifies the text wire format: 2-char prefix ("Vx" where V=version,
// x=type/hash via case), JSON array envelope, fragment fields,
// and convenience encode/decode functions.
//
// Wire fixtures construct WireMessage values directly, bypassing the
// alias layer (which lives in @kyneta/transport).

import { SYNC_AUTHORITATIVE, SYNC_COLLABORATIVE } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { complete, fragment, isComplete, isFragment } from "../frame-types.js"
import { decodeTextWireMessage, encodeTextWireMessage } from "../index.js"
import {
  decodeTextFrame,
  encodeTextFrame,
  TEXT_WIRE_VERSION,
  TextFrameDecodeError,
} from "../text-frame.js"
import type { WireMessage } from "../wire-types.js"
import { offerWire, presentWire } from "./__helpers__/wire-fixtures.js"

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function encodeToFrame(wire: WireMessage): string {
  const payload = encodeTextWireMessage(wire)
  return encodeTextFrame(complete(TEXT_WIRE_VERSION, payload))
}

// ---------------------------------------------------------------------------
// Prefix correctness
// ---------------------------------------------------------------------------

describe("Text frame — prefix", () => {
  it("complete frame has prefix '1c'", () => {
    const frame = complete(TEXT_WIRE_VERSION, '{"type":"present","docs":[]}')
    const wire = encodeTextFrame(frame)
    const arr = JSON.parse(wire)
    expect(arr[0]).toBe("1c")
  })

  it("fragment frame has prefix '1f'", () => {
    const frame = fragment(TEXT_WIRE_VERSION, 0xaabb, 0, 3, 100, "chunk")
    const wire = encodeTextFrame(frame)
    const arr = JSON.parse(wire)
    expect(arr[0]).toBe("1f")
  })
})

// ---------------------------------------------------------------------------
// Complete frame round-trip
// ---------------------------------------------------------------------------

describe("Text frame — complete round-trip", () => {
  it("round-trips a complete frame with a JSON object payload", () => {
    const payload = JSON.stringify({
      type: "present",
      docs: [
        {
          docId: "doc-1",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0] as const,
          syncProtocol: SYNC_AUTHORITATIVE,
        },
      ],
    })
    const frame = complete(TEXT_WIRE_VERSION, payload)
    const wire = encodeTextFrame(frame)
    const decoded = decodeTextFrame(wire)

    expect(isComplete(decoded)).toBe(true)
    expect(decoded.version).toBe(TEXT_WIRE_VERSION)
    expect(decoded.hash).toBeNull()
    expect(decoded.content.payload).toBe(payload)
  })

  it("round-trips a complete frame with a JSON array payload (batch)", () => {
    const payload = JSON.stringify([
      {
        type: "present",
        docs: [
          {
            docId: "a",
            schemaHash: "00test",
            replicaType: ["plain", 1, 0] as const,
            syncProtocol: SYNC_AUTHORITATIVE,
          },
        ],
      },
      { type: "interest", docId: "b" },
    ])
    const frame = complete(TEXT_WIRE_VERSION, payload)
    const wire = encodeTextFrame(frame)
    const decoded = decodeTextFrame(wire)

    expect(isComplete(decoded)).toBe(true)
    expect(decoded.content.payload).toBe(payload)
  })

  it("output is valid JSON", () => {
    const payload = JSON.stringify({
      type: "present",
      docs: [
        {
          docId: "x",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0] as const,
          syncProtocol: SYNC_AUTHORITATIVE,
        },
      ],
    })
    const frame = complete(TEXT_WIRE_VERSION, payload)
    const wire = encodeTextFrame(frame)

    expect(() => JSON.parse(wire)).not.toThrow()
    const arr = JSON.parse(wire)
    expect(Array.isArray(arr)).toBe(true)
  })

  it("payload is embedded as a native JSON value (not a string within a string)", () => {
    const payload = JSON.stringify({
      type: "present",
      docs: [
        {
          docId: "x",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0] as const,
          syncProtocol: SYNC_AUTHORITATIVE,
        },
      ],
    })
    const frame = complete(TEXT_WIRE_VERSION, payload)
    const wire = encodeTextFrame(frame)
    const arr = JSON.parse(wire)

    // arr[1] should be the parsed object, not a string
    expect(typeof arr[1]).toBe("object")
    expect(arr[1].type).toBe("present")
  })
})

// ---------------------------------------------------------------------------
// Fragment frame round-trip
// ---------------------------------------------------------------------------

describe("Text frame — fragment round-trip", () => {
  it("round-trips a fragment frame", () => {
    const frameId = 0xa1b2
    const frame = fragment(
      TEXT_WIRE_VERSION,
      frameId,
      2,
      5,
      1000,
      "json-chunk-data",
    )
    const wire = encodeTextFrame(frame)
    const decoded = decodeTextFrame(wire)

    expect(isFragment(decoded)).toBe(true)
    expect(decoded.version).toBe(TEXT_WIRE_VERSION)
    expect(decoded.hash).toBeNull()

    if (decoded.content.kind === "fragment") {
      expect(decoded.content.frameId).toBe(frameId)
      expect(decoded.content.index).toBe(2)
      expect(decoded.content.total).toBe(5)
      expect(decoded.content.totalSize).toBe(1000)
      expect(decoded.content.payload).toBe("json-chunk-data")
    }
  })

  it("fragment fields are correct types", () => {
    const frame = fragment(TEXT_WIRE_VERSION, 123, 1, 4, 200, "data")
    const wire = encodeTextFrame(frame)
    const arr = JSON.parse(wire)

    // ["1f", frameId, index, total, totalSize, chunk]
    expect(typeof arr[0]).toBe("string") // prefix
    expect(typeof arr[1]).toBe("number") // frameId
    expect(typeof arr[2]).toBe("number") // index
    expect(typeof arr[3]).toBe("number") // total
    expect(typeof arr[4]).toBe("number") // totalSize
    expect(typeof arr[5]).toBe("string") // chunk
  })
})

// ---------------------------------------------------------------------------
// Convenience functions
// ---------------------------------------------------------------------------

describe("Text frame — convenience functions", () => {
  it("encodeToFrame encodes a present message", () => {
    const wireMsg = presentWire([
      {
        docId: "doc-1",
        schemaHash: "00test",
        replicaType: ["plain", 1, 0] as const,
        syncProtocol: SYNC_AUTHORITATIVE,
      },
      {
        docId: "doc-2",
        schemaHash: "00test",
        replicaType: ["yjs", 1, 0] as const,
        syncProtocol: SYNC_COLLABORATIVE,
      },
    ])
    const encoded = encodeToFrame(wireMsg)

    const frame = decodeTextFrame(encoded)
    expect(isComplete(frame)).toBe(true)

    const decoded = decodeTextWireMessage(frame.content.payload)
    expect(decoded).toEqual(wireMsg)
  })

  it("encodeToFrame handles offer with binary payload", () => {
    const wireMsg = offerWire({
      docId: "doc-1",
      kind: "entirety",
      encoding: "binary",
      data: new Uint8Array([1, 2, 3]),
      version: "1",
    })
    const encoded = encodeToFrame(wireMsg)
    const frame = decodeTextFrame(encoded)

    const decoded = decodeTextWireMessage(frame.content.payload)
    expect(decoded).toEqual(wireMsg)
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("Text frame — error handling", () => {
  it("throws on non-JSON input", () => {
    expect(() => decodeTextFrame("not json")).toThrow(TextFrameDecodeError)
  })

  it("throws on non-array JSON", () => {
    expect(() => decodeTextFrame('{"not": "array"}')).toThrow(
      TextFrameDecodeError,
    )
  })

  it("throws on array too short", () => {
    expect(() => decodeTextFrame('["1c"]')).toThrow(TextFrameDecodeError)
  })

  it("throws on invalid prefix — wrong length", () => {
    expect(() => decodeTextFrame('["abc", 123]')).toThrow(TextFrameDecodeError)
    expect(() => decodeTextFrame('["abc", 123]')).toThrow("2-character prefix")
  })

  it("throws on invalid prefix — non-numeric version", () => {
    expect(() => decodeTextFrame('["xc", 123]')).toThrow(TextFrameDecodeError)
    expect(() => decodeTextFrame('["xc", 123]')).toThrow("Invalid version")
  })

  it("throws on invalid prefix — unknown type character", () => {
    expect(() => decodeTextFrame('["1z", 123]')).toThrow(TextFrameDecodeError)
    expect(() => decodeTextFrame('["1z", 123]')).toThrow("Unknown type")
  })

  it("throws on unsupported version", () => {
    expect(() => decodeTextFrame('["9c", 123]')).toThrow(TextFrameDecodeError)
    expect(() => decodeTextFrame('["9c", 123]')).toThrow(
      "Unsupported text wire version",
    )
  })

  it("throws on truncated fragment frame", () => {
    // "1f" expects frameId, index, total, totalSize, chunk = 6 elements
    expect(() => decodeTextFrame('["1f", 1, 0, 3]')).toThrow(
      TextFrameDecodeError,
    )
    expect(() => decodeTextFrame('["1f", 1, 0, 3]')).toThrow("at least 6")
  })

  it("throws on non-number frameId in fragment", () => {
    expect(() =>
      decodeTextFrame('["1f", "not_a_number", 0, 3, 100, "chunk"]'),
    ).toThrow(TextFrameDecodeError)
    expect(() =>
      decodeTextFrame('["1f", "not_a_number", 0, 3, 100, "chunk"]'),
    ).toThrow("frameId must be a number")
  })

  it("throws on non-number index in fragment", () => {
    expect(() => decodeTextFrame('["1f", 1, "zero", 3, 100, "chunk"]')).toThrow(
      TextFrameDecodeError,
    )
    expect(() => decodeTextFrame('["1f", 1, "zero", 3, 100, "chunk"]')).toThrow(
      "must be numbers",
    )
  })

  it("throws on non-string chunk in fragment", () => {
    expect(() => decodeTextFrame('["1f", 1, 0, 3, 100, 42]')).toThrow(
      TextFrameDecodeError,
    )
    expect(() => decodeTextFrame('["1f", 1, 0, 3, 100, 42]')).toThrow(
      "chunk must be a string",
    )
  })

  it("rejects v0 hash prefix variants 'C' and 'F'", () => {
    expect(() =>
      decodeTextFrame('["1C", "deadbeef", {"type": "present"}]'),
    ).toThrow(TextFrameDecodeError)
    expect(() =>
      decodeTextFrame('["1F", "deadbeef", 1, 0, 3, 100, "chunk"]'),
    ).toThrow(TextFrameDecodeError)
  })
})
