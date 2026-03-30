// JSON codec tests — round-trip all 5 message types.
//
// Verifies that every ChannelMsg variant survives encode → decode
// through the JSON codec. Special attention to SubstratePayload
// handling: binary payloads must be base64-encoded transparently,
// while JSON payloads pass through as-is.

import { describe, expect, it } from "vitest"
import { jsonCodec } from "../json.js"
import type {
  ChannelMsg,
  DiscoverMsg,
  EstablishRequestMsg,
  EstablishResponseMsg,
  InterestMsg,
  OfferMsg,
} from "@kyneta/exchange"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const decoder = new TextDecoder()

function roundTrip(msg: ChannelMsg): ChannelMsg {
  const encoded = jsonCodec.encode(msg)
  expect(encoded).toBeInstanceOf(Uint8Array)
  expect(encoded.length).toBeGreaterThan(0)
  return jsonCodec.decode(encoded)
}

/** Peek at the JSON string on the wire (for inspecting encoding). */
function encodeToString(msg: ChannelMsg): string {
  return decoder.decode(jsonCodec.encode(msg))
}

// ---------------------------------------------------------------------------
// Establishment messages
// ---------------------------------------------------------------------------

describe("JSON codec — establishment messages", () => {
  it("round-trips establish-request with full identity", () => {
    const msg: EstablishRequestMsg = {
      type: "establish-request",
      identity: {
        peerId: "peer-alice-123",
        name: "Alice",
        type: "user",
      },
    }
    const decoded = roundTrip(msg)
    expect(decoded).toEqual(msg)
  })

  it("round-trips establish-request without optional name", () => {
    const msg: EstablishRequestMsg = {
      type: "establish-request",
      identity: {
        peerId: "bot-42",
        type: "bot",
      },
    }
    const decoded = roundTrip(msg)
    expect(decoded.type).toBe("establish-request")
    const identity = (decoded as EstablishRequestMsg).identity
    expect(identity.peerId).toBe("bot-42")
    expect(identity.type).toBe("bot")
    // JSON serialization drops undefined fields entirely
    expect("name" in identity).toBe(false)
  })

  it("round-trips establish-response", () => {
    const msg: EstablishResponseMsg = {
      type: "establish-response",
      identity: {
        peerId: "service-backend",
        name: "Backend Service",
        type: "service",
      },
    }
    const decoded = roundTrip(msg)
    expect(decoded).toEqual(msg)
  })

  it("uses human-readable type strings on the wire", () => {
    const msg: EstablishRequestMsg = {
      type: "establish-request",
      identity: { peerId: "p1", type: "user" },
    }
    const json = encodeToString(msg)
    const parsed = JSON.parse(json)
    // JSON codec uses the original type string, not integer discriminators
    expect(parsed.type).toBe("establish-request")
  })
})

// ---------------------------------------------------------------------------
// Exchange messages
// ---------------------------------------------------------------------------

describe("JSON codec — discover", () => {
  it("round-trips discover with multiple docIds", () => {
    const msg: DiscoverMsg = {
      type: "discover",
      docIds: ["doc-1", "doc-2", "doc-3"],
    }
    const decoded = roundTrip(msg)
    expect(decoded).toEqual(msg)
  })

  it("round-trips discover with empty docIds", () => {
    const msg: DiscoverMsg = {
      type: "discover",
      docIds: [],
    }
    const decoded = roundTrip(msg)
    expect(decoded).toEqual(msg)
  })
})

describe("JSON codec — interest", () => {
  it("round-trips interest with version and reciprocate", () => {
    const msg: InterestMsg = {
      type: "interest",
      docId: "doc-abc",
      version: "42",
      reciprocate: true,
    }
    const decoded = roundTrip(msg)
    expect(decoded).toEqual(msg)
  })

  it("round-trips interest without optional fields", () => {
    const msg: InterestMsg = {
      type: "interest",
      docId: "doc-xyz",
    }
    const decoded = roundTrip(msg)
    expect(decoded.type).toBe("interest")
    const interest = decoded as InterestMsg
    expect(interest.docId).toBe("doc-xyz")
    // JSON serialization drops undefined fields
    expect("version" in interest).toBe(false)
    expect("reciprocate" in interest).toBe(false)
  })

  it("round-trips interest with reciprocate=false", () => {
    const msg: InterestMsg = {
      type: "interest",
      docId: "doc-1",
      version: "7",
      reciprocate: false,
    }
    const decoded = roundTrip(msg)
    expect(decoded).toEqual(msg)
  })
})

describe("JSON codec — offer", () => {
  it("round-trips offer with JSON payload (snapshot)", () => {
    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-config",
      offerType: "snapshot",
      payload: {
        encoding: "json",
        data: JSON.stringify({ title: "Hello", count: 42 }),
      },
      version: "5",
    }
    const decoded = roundTrip(msg)
    expect(decoded).toEqual(msg)
  })

  it("JSON payload data passes through without base64 encoding", () => {
    const jsonData = JSON.stringify({ key: "value" })
    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-1",
      offerType: "snapshot",
      payload: {
        encoding: "json",
        data: jsonData,
      },
      version: "1",
    }

    // Inspect the wire format
    const wireJson = encodeToString(msg)
    const parsed = JSON.parse(wireJson)

    // The data should be the original string, not base64
    expect(parsed.payload.data).toBe(jsonData)
    expect(parsed.payload.encoding).toBe("json")
  })

  it("round-trips offer with binary payload (delta)", () => {
    const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd])
    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-crdt",
      offerType: "delta",
      payload: {
        encoding: "binary",
        data: binaryData,
      },
      version: "AQ==:3",
      reciprocate: true,
    }
    const decoded = roundTrip(msg) as OfferMsg
    expect(decoded.type).toBe("offer")
    expect(decoded.docId).toBe("doc-crdt")
    expect(decoded.offerType).toBe("delta")
    expect(decoded.payload.encoding).toBe("binary")
    expect(decoded.version).toBe("AQ==:3")
    expect(decoded.reciprocate).toBe(true)

    // Uint8Array should survive the JSON round-trip via base64
    expect(decoded.payload.data).toBeInstanceOf(Uint8Array)
    expect(decoded.payload.data).toEqual(binaryData)
  })

  it("binary payload data is base64-encoded on the wire", () => {
    const binaryData = new Uint8Array([72, 101, 108, 108, 111]) // "Hello" in ASCII
    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-1",
      offerType: "snapshot",
      payload: {
        encoding: "binary",
        data: binaryData,
      },
      version: "1",
    }

    // Inspect the wire format
    const wireJson = encodeToString(msg)
    const parsed = JSON.parse(wireJson)

    // The data should be base64-encoded
    expect(parsed.payload.encoding).toBe("binary")
    expect(typeof parsed.payload.data).toBe("string")
    // btoa("Hello") === "SGVsbG8="
    expect(parsed.payload.data).toBe("SGVsbG8=")
  })

  it("round-trips offer with large binary payload", () => {
    // Simulate a realistic Loro snapshot (~10KB)
    const largeData = new Uint8Array(10240)
    for (let i = 0; i < largeData.length; i++) {
      largeData[i] = i % 256
    }

    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-large",
      offerType: "snapshot",
      payload: {
        encoding: "binary",
        data: largeData,
      },
      version: "100",
    }
    const decoded = roundTrip(msg) as OfferMsg
    expect(decoded.payload.data).toBeInstanceOf(Uint8Array)
    expect(decoded.payload.data).toEqual(largeData)
  })

  it("round-trips offer without optional reciprocate", () => {
    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-1",
      offerType: "snapshot",
      payload: {
        encoding: "json",
        data: "{}",
      },
      version: "1",
    }
    const decoded = roundTrip(msg) as OfferMsg
    // JSON serialization drops undefined fields
    expect("reciprocate" in decoded).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Batch encoding
// ---------------------------------------------------------------------------

describe("JSON codec — batch", () => {
  it("round-trips a batch of mixed message types", () => {
    const msgs: ChannelMsg[] = [
      {
        type: "establish-request",
        identity: { peerId: "p1", name: "Peer One", type: "user" },
      },
      {
        type: "discover",
        docIds: ["d1", "d2"],
      },
      {
        type: "interest",
        docId: "d1",
        version: "0",
        reciprocate: true,
      },
      {
        type: "offer",
        docId: "d1",
        offerType: "delta",
        payload: {
          encoding: "binary",
          data: new Uint8Array([1, 2, 3]),
        },
        version: "2",
        reciprocate: false,
      },
    ]

    const encoded = jsonCodec.encodeBatch(msgs)
    expect(encoded).toBeInstanceOf(Uint8Array)

    const decoded = jsonCodec.decodeBatch(encoded)
    expect(decoded).toHaveLength(4)
    expect(decoded[0]!.type).toBe("establish-request")
    expect(decoded[1]!.type).toBe("discover")
    expect(decoded[2]!.type).toBe("interest")
    expect(decoded[3]!.type).toBe("offer")

    // Verify the offer's binary payload survived
    const decodedOffer = decoded[3] as OfferMsg
    expect(decodedOffer.payload.data).toBeInstanceOf(Uint8Array)
    expect(decodedOffer.payload.data).toEqual(new Uint8Array([1, 2, 3]))
  })

  it("round-trips an empty batch", () => {
    const encoded = jsonCodec.encodeBatch([])
    const decoded = jsonCodec.decodeBatch(encoded)
    expect(decoded).toEqual([])
  })

  it("batch wire format is a JSON array", () => {
    const msgs: ChannelMsg[] = [
      { type: "discover", docIds: ["d1"] },
      { type: "discover", docIds: ["d2"] },
    ]
    const wireJson = decoder.decode(jsonCodec.encodeBatch(msgs))
    const parsed = JSON.parse(wireJson)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("JSON codec — error handling", () => {
  it("throws on invalid JSON data", () => {
    const garbage = new TextEncoder().encode("not valid json {{{")
    expect(() => jsonCodec.decode(garbage)).toThrow("Failed to decode JSON")
  })

  it("throws on unknown message type", () => {
    const bad = new TextEncoder().encode(
      JSON.stringify({ type: "unknown-type", data: 123 }),
    )
    expect(() => jsonCodec.decode(bad)).toThrow("Unknown JSON message type")
  })

  it("throws on empty input", () => {
    expect(() => jsonCodec.decode(new Uint8Array(0))).toThrow()
  })
})