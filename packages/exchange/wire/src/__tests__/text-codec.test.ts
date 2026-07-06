// Text codec tests — round-trip all WireMessage types through
// encodeTextWireMessage → decodeTextWireMessage.
//
// Verifies that every WireMessage variant survives text (JSON) encode/decode,
// including WireOfferMsg with both "json" and "binary" payload encodings.
// Binary payloads are base64-encoded transparently; JSON payloads pass through.
// Alias resolution is transport's concern, tested separately.

import {
  SYNC_AUTHORITATIVE,
  SYNC_COLLABORATIVE,
  SYNC_EPHEMERAL,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import {
  DOC_ID_MAX_UTF8_BYTES,
  SCHEMA_HASH_MAX_UTF8_BYTES,
} from "../constants.js"
import {
  decodeTextWireMessage,
  encodeTextWireMessage,
  validateDocId,
  validateSchemaHash,
  WireValidationFailure,
} from "../index.js"
import type {
  WireEstablishMsg,
  WireInterestMsg,
  WireMessage,
  WireOfferMsg,
} from "../wire-types.js"
import { MessageType, PayloadEncoding } from "../wire-types.js"
import {
  departWire,
  dismissWire,
  establishWire,
  interestWire,
  offerWire,
  presentWire,
} from "./__helpers__/wire-fixtures.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundTrip(wire: WireMessage): WireMessage {
  const text = encodeTextWireMessage(wire)
  return decodeTextWireMessage(text)
}

function roundTripBatch(wires: WireMessage[]): WireMessage[] {
  return wires.map(w => {
    const text = encodeTextWireMessage(w)
    return decodeTextWireMessage(text)
  })
}

// ---------------------------------------------------------------------------
// Lifecycle messages
// ---------------------------------------------------------------------------

describe("Text codec — lifecycle messages", () => {
  it("round-trips establish with full identity", () => {
    const wire = establishWire({
      peerId: "peer-alice-123",
      name: "Alice",
      type: "user",
    })
    const decoded = roundTrip(wire)
    expect(decoded).toEqual(wire)
  })

  it("round-trips establish without optional name", () => {
    const wire = establishWire({ peerId: "bot-42", type: "bot" })
    const decoded = roundTrip(wire)
    expect(decoded.t).toBe(MessageType.Establish)
    const est = decoded as WireEstablishMsg
    expect(est.id).toBe("bot-42")
    expect(est.y).toBe("bot")
    // name should be absent (undefined), not null or empty string
    expect(est.n).toBeUndefined()
  })

  it("round-trips establish with a non-default protocolVersion (pv)", () => {
    const wire = establishWire({
      peerId: "alice",
      type: "user",
      protocolVersion: [2, 0],
    })
    const decoded = roundTrip(wire) as WireEstablishMsg
    expect(decoded.pv).toEqual([2, 0])
  })

  it("round-trips establish without protocolVersion (default peer)", () => {
    const wire = establishWire({ peerId: "alice", type: "user" })
    const decoded = roundTrip(wire) as WireEstablishMsg
    expect(decoded.pv).toBeUndefined()
  })

  it("round-trips depart", () => {
    const wire = departWire()
    const decoded = roundTrip(wire)
    expect(decoded).toEqual(wire)
  })

  it("uses compact integer discriminators (not human-readable type strings)", () => {
    const wire = establishWire({ peerId: "p1", type: "user" })
    const encoded = JSON.parse(encodeTextWireMessage(wire)) as Record<
      string,
      unknown
    >
    // The wire form uses integer discriminators (e.g. 0x01 for establish)
    expect(encoded.t).toBe(0x01)
    expect(encoded.id).toBe("p1")
    expect(encoded.y).toBe("user")
  })
})

// ---------------------------------------------------------------------------
// Sync messages
// ---------------------------------------------------------------------------

describe("Text codec — present", () => {
  it("round-trips present with multiple docIds", () => {
    const wire = presentWire([
      {
        docId: "doc-1",
        schemaHash: "00test",
        replicaType: ["plain", 1, 0] as const,
        syncMode: SYNC_AUTHORITATIVE,
      },
      {
        docId: "doc-2",
        schemaHash: "00test",
        replicaType: ["yjs", 1, 0] as const,
        syncMode: SYNC_COLLABORATIVE,
      },
      {
        docId: "doc-3",
        schemaHash: "00test",
        replicaType: ["loro", 1, 0] as const,
        syncMode: SYNC_EPHEMERAL,
      },
    ])
    const decoded = roundTrip(wire)
    expect(decoded).toEqual(wire)
  })

  it("round-trips present with empty docIds", () => {
    const wire = presentWire([])
    const decoded = roundTrip(wire)
    expect(decoded).toEqual(wire)
  })
})

describe("Text codec — interest", () => {
  it("round-trips interest with version and reciprocate", () => {
    const wire = interestWire({
      docId: "doc-abc",
      version: "42",
      reciprocate: true,
    })
    const decoded = roundTrip(wire)
    expect(decoded).toEqual(wire)
  })

  it("round-trips interest without optional fields", () => {
    const wire = interestWire({ docId: "doc-xyz" })
    const decoded = roundTrip(wire)
    expect(decoded.t).toBe(MessageType.Interest)
    const interest = decoded as WireInterestMsg
    expect(interest.doc).toBe("doc-xyz")
    expect(interest.v).toBeUndefined()
    expect(interest.r).toBeUndefined()
  })

  it("round-trips interest with reciprocate=false", () => {
    const wire = interestWire({
      docId: "doc-1",
      version: "7",
      reciprocate: false,
    })
    const decoded = roundTrip(wire)
    expect(decoded).toEqual(wire)
  })
})

describe("Text codec — offer", () => {
  it("round-trips offer with JSON payload (snapshot)", () => {
    const wire = offerWire({
      docId: "doc-config",
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({ title: "Hello", count: 42 }),
      version: "5",
    })
    const decoded = roundTrip(wire)
    expect(decoded).toEqual(wire)
  })

  it("JSON payload data passes through without base64 encoding", () => {
    const jsonData = JSON.stringify({ key: "value" })
    const wire = offerWire({
      docId: "doc-1",
      kind: "entirety",
      encoding: "json",
      data: jsonData,
      version: "1",
    })
    const encoded = JSON.parse(encodeTextWireMessage(wire)) as Record<
      string,
      unknown
    >

    // The data should be the original string, not base64
    expect(encoded.d).toBe(jsonData)
    // Encoding is an integer discriminator in the wire format
    expect(encoded.pe).toBe(PayloadEncoding.Json)
  })

  it("round-trips offer with binary payload (delta)", () => {
    const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd])
    const wire = offerWire({
      docId: "doc-crdt",
      kind: "since",
      encoding: "binary",
      data: binaryData,
      version: "AQ==:3",
      reciprocate: true,
    })
    const decoded = roundTrip(wire) as WireOfferMsg
    expect(decoded.t).toBe(MessageType.Offer)
    expect(decoded.doc).toBe("doc-crdt")
    expect(decoded.pe).toBe(PayloadEncoding.Binary)
    expect(decoded.v).toBe("AQ==:3")
    expect(decoded.r).toBe(true)

    // Uint8Array should survive the round-trip via base64
    expect(decoded.d).toBeInstanceOf(Uint8Array)
    expect(decoded.d).toEqual(binaryData)
  })

  it("binary payload data is base64-encoded in the JSON-safe output", () => {
    const binaryData = new Uint8Array([72, 101, 108, 108, 111]) // "Hello" in ASCII
    const wire = offerWire({
      docId: "doc-1",
      kind: "entirety",
      encoding: "binary",
      data: binaryData,
      version: "1",
    })
    const encoded = JSON.parse(encodeTextWireMessage(wire)) as Record<
      string,
      unknown
    >

    // The data should be wrapped in { __bytes: "..." } for JSON safety
    expect(encoded.pe).toBe(PayloadEncoding.Binary)
    const d = encoded.d as Record<string, unknown>
    expect(typeof d.__bytes).toBe("string")
    // btoa("Hello") === "SGVsbG8="
    expect(d.__bytes).toBe("SGVsbG8=")
  })

  it("round-trips offer with large binary payload", () => {
    // Simulate a realistic Loro snapshot (~10KB)
    const largeData = new Uint8Array(10240)
    for (let i = 0; i < largeData.length; i++) {
      largeData[i] = i % 256
    }

    const wire = offerWire({
      docId: "doc-large",
      kind: "entirety",
      encoding: "binary",
      data: largeData,
      version: "100",
    })
    const decoded = roundTrip(wire) as WireOfferMsg
    expect(decoded.d).toBeInstanceOf(Uint8Array)
    expect(decoded.d).toEqual(largeData)
  })

  it("round-trips offer without optional reciprocate", () => {
    const wire = offerWire({
      docId: "doc-1",
      kind: "entirety",
      encoding: "json",
      data: "{}",
      version: "1",
    })
    const decoded = roundTrip(wire) as WireOfferMsg
    expect(decoded.r).toBeUndefined()
  })

  it("round-trips offer with epoch set", () => {
    const wire = offerWire({
      docId: "doc-epoch",
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({ title: "Hello" }),
      version: "abc123:5",
      epoch: "abc123",
    })
    const decoded = roundTrip(wire) as WireOfferMsg
    expect(decoded.ep).toBe("abc123")
  })

  it("round-trips offer without optional epoch (legacy payload)", () => {
    const wire = offerWire({
      docId: "doc-legacy",
      kind: "entirety",
      encoding: "json",
      data: "{}",
      version: "1",
    })
    const decoded = roundTrip(wire) as WireOfferMsg
    expect(decoded.ep).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Dismiss
// ---------------------------------------------------------------------------

describe("Text codec — dismiss", () => {
  it("round-trips dismiss message", () => {
    const wire = dismissWire("doc-to-leave")
    const decoded = roundTrip(wire)
    expect(decoded).toEqual(wire)
  })
})

// ---------------------------------------------------------------------------
// Batch encoding (each message independently round-tripped)
// ---------------------------------------------------------------------------

describe("Text codec — batch", () => {
  it("round-trips a batch of mixed message types", () => {
    const wires: WireMessage[] = [
      establishWire({ peerId: "p1", name: "Peer One", type: "user" }),
      departWire(),
      presentWire([
        {
          docId: "d1",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0] as const,
          syncMode: SYNC_AUTHORITATIVE,
        },
        {
          docId: "d2",
          schemaHash: "00test",
          replicaType: ["yjs", 1, 0] as const,
          syncMode: SYNC_COLLABORATIVE,
        },
      ]),
      interestWire({ docId: "d1", version: "0", reciprocate: true }),
      offerWire({
        docId: "d1",
        kind: "since",
        encoding: "binary",
        data: new Uint8Array([1, 2, 3]),
        version: "2",
        reciprocate: false,
      }),
      dismissWire("d1"),
    ]

    const decoded = roundTripBatch(wires)
    expect(decoded).toHaveLength(6)
    expect(decoded[0]?.t).toBe(MessageType.Establish)
    expect(decoded[1]?.t).toBe(MessageType.Depart)
    expect(decoded[2]?.t).toBe(MessageType.Present)
    expect(decoded[3]?.t).toBe(MessageType.Interest)
    expect(decoded[4]?.t).toBe(MessageType.Offer)
    expect(decoded[5]?.t).toBe(MessageType.Dismiss)

    // Verify deep equality (binary offers use base64 round-trip)
    expect(decoded[0]).toEqual(wires[0])
    expect(decoded[1]).toEqual(wires[1])
    expect(decoded[2]).toEqual(wires[2])
    expect(decoded[3]).toEqual(wires[3])
    expect(decoded[4]).toEqual(wires[4])
    expect(decoded[5]).toEqual(wires[5])
  })

  it("round-trips an empty batch", () => {
    const decoded = roundTripBatch([])
    expect(decoded).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("Text codec — error handling", () => {
  it("throws on unknown message type", () => {
    const bad = JSON.stringify({ t: 0xff, data: 123 })
    expect(() => decodeTextWireMessage(bad)).toThrow(WireValidationFailure)
  })

  it("throws on unknown message type in batch", () => {
    const bad = JSON.stringify({ t: 0xff })
    expect(() => decodeTextWireMessage(bad)).toThrow(WireValidationFailure)
  })

  it("throws on null input", () => {
    expect(() => decodeTextWireMessage("null")).toThrow()
  })

  it("throws on non-object input", () => {
    expect(() => decodeTextWireMessage('"not an object"')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// JSON-safe output verification
// ---------------------------------------------------------------------------

describe("Text codec — JSON-safe output", () => {
  it("encode output survives JSON.stringify → JSON.parse round-trip", () => {
    const wire = offerWire({
      docId: "doc-1",
      kind: "entirety",
      encoding: "binary",
      data: new Uint8Array([1, 2, 3, 4, 5]),
      version: "1",
    })

    const encoded = encodeTextWireMessage(wire)
    // encodeTextWireMessage returns a string — a round-trip through
    // JSON serialization is simply: the string IS the serialized form.
    const decoded = decodeTextWireMessage(encoded)
    const offer = decoded as WireOfferMsg

    expect(offer.d).toBeInstanceOf(Uint8Array)
    expect(offer.d).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
  })

  it("encode(batch) output survives JSON.stringify → JSON.parse round-trip", () => {
    const wires: WireMessage[] = [
      presentWire([
        {
          docId: "a",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0] as const,
          syncMode: SYNC_AUTHORITATIVE,
        },
      ]),
      offerWire({
        docId: "b",
        kind: "since",
        encoding: "binary",
        data: new Uint8Array([10, 20]),
        version: "1",
      }),
    ]

    const decoded = roundTripBatch(wires)
    expect(decoded).toHaveLength(2)
    expect(decoded[0]?.t).toBe(MessageType.Present)
    const offer = decoded[1] as WireOfferMsg
    expect(offer.d).toEqual(new Uint8Array([10, 20]))
  })
})

// ---------------------------------------------------------------------------
// Identifier length caps
// ---------------------------------------------------------------------------

describe("Text codec — identifier length caps", () => {
  it("accepts a docId at the UTF-8 byte cap", () => {
    const docId = "a".repeat(DOC_ID_MAX_UTF8_BYTES)
    expect(validateDocId(docId)).toBeNull()
    const wire = interestWire({ docId })
    const decoded = roundTrip(wire) as WireInterestMsg
    expect(decoded.doc).toEqual(docId)
  })

  it("accepts a docId at the cap built from a 4-byte UTF-8 codepoint", () => {
    const docId = `${"a".repeat(DOC_ID_MAX_UTF8_BYTES - 4)}🚀`
    expect(new TextEncoder().encode(docId).byteLength).toBe(
      DOC_ID_MAX_UTF8_BYTES,
    )
    expect(validateDocId(docId)).toBeNull()
    const wire = interestWire({ docId })
    const decoded = roundTrip(wire) as WireInterestMsg
    expect(decoded.doc).toEqual(docId)
  })

  it("rejects a docId one byte over the cap with a typed error", () => {
    const docId = "a".repeat(DOC_ID_MAX_UTF8_BYTES + 1)
    const error = validateDocId(docId)
    expect(error).not.toBeNull()
    expect(error?.code).toBe("doc-id-too-long")
  })

  it("rejects a schemaHash over the cap with a typed error", () => {
    const big = "h".repeat(SCHEMA_HASH_MAX_UTF8_BYTES + 1)
    const error = validateSchemaHash(big)
    expect(error).not.toBeNull()
    expect(error?.code).toBe("schema-hash-too-long")
  })
})

// ---------------------------------------------------------------------------
// WireFeatures round-trip
// ---------------------------------------------------------------------------

describe("Text codec — WireFeatures negotiation", () => {
  it("round-trips establish with all features advertised", () => {
    const wire = establishWire({
      peerId: "alice",
      type: "user",
      features: { alias: true, streamed: true, datagram: true },
    })
    const decoded = roundTrip(wire) as WireEstablishMsg
    expect(decoded.f).toEqual({ a: true, s: true, d: true })
  })

  it("round-trips establish with no features (legacy peer)", () => {
    const wire = establishWire({ peerId: "alice", type: "user" })
    const decoded = roundTrip(wire) as WireEstablishMsg
    expect(decoded.f).toBeUndefined()
  })

  it("round-trips establish with partial features", () => {
    const wire = establishWire({
      peerId: "alice",
      type: "user",
      features: { alias: true },
    })
    const decoded = roundTrip(wire) as WireEstablishMsg
    expect(decoded.f).toEqual({ a: true })
  })
})
