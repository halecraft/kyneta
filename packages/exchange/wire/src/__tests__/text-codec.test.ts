// Text codec tests — round-trip all 6 message types.
//
// Verifies that every ChannelMsg variant survives encode → decode
// through the textCodec. Special attention to SubstratePayload
// handling: binary payloads must be base64-encoded transparently,
// while JSON payloads pass through as-is.
//
// The text codec works with JSON-safe objects, not bytes.

import type {
  ChannelMsg,
  DismissMsg,
  EstablishRequestMsg,
  EstablishResponseMsg,
  InterestMsg,
  OfferMsg,
  PresentMsg,
} from "@kyneta/exchange"
import { describe, expect, it } from "vitest"
import { textCodec } from "../json.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundTrip(msg: ChannelMsg): ChannelMsg {
  const encoded = textCodec.encode(msg)
  // The encoded value should be a JSON-safe object (not Uint8Array)
  expect(encoded).not.toBeInstanceOf(Uint8Array)
  const decoded = textCodec.decode(encoded)
  expect(decoded).toHaveLength(1)
  return decoded[0]!
}

// ---------------------------------------------------------------------------
// Establishment messages
// ---------------------------------------------------------------------------

describe("Text codec — establishment messages", () => {
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

  it("uses human-readable type strings (not integer discriminators)", () => {
    const msg: EstablishRequestMsg = {
      type: "establish-request",
      identity: { peerId: "p1", type: "user" },
    }
    const encoded = textCodec.encode(msg) as Record<string, unknown>
    expect(encoded.type).toBe("establish-request")
  })
})

// ---------------------------------------------------------------------------
// Exchange messages
// ---------------------------------------------------------------------------

describe("Text codec — present", () => {
  it("round-trips present with multiple docIds", () => {
    const msg: PresentMsg = {
      type: "present",
      docs: [
        {
          docId: "doc-1",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "sequential" as const,
        },
        {
          docId: "doc-2",
          schemaHash: "00test",
          replicaType: ["yjs", 1, 0] as const,
          mergeStrategy: "causal" as const,
        },
        {
          docId: "doc-3",
          schemaHash: "00test",
          replicaType: ["loro", 1, 0] as const,
          mergeStrategy: "lww" as const,
        },
      ],
    }
    const decoded = roundTrip(msg)
    expect(decoded).toEqual(msg)
  })

  it("round-trips present with empty docIds", () => {
    const msg: PresentMsg = {
      type: "present",
      docs: [],
    }
    const decoded = roundTrip(msg)
    expect(decoded).toEqual(msg)
  })
})

describe("Text codec — interest", () => {
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

describe("Text codec — offer", () => {
  it("round-trips offer with JSON payload (snapshot)", () => {
    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-config",
      payload: {
        kind: "entirety",
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
      payload: {
        kind: "entirety",
        encoding: "json",
        data: jsonData,
      },
      version: "1",
    }

    const encoded = textCodec.encode(msg) as Record<string, unknown>
    const payload = encoded.payload as Record<string, unknown>

    // The data should be the original string, not base64
    expect(payload.data).toBe(jsonData)
    expect(payload.encoding).toBe("json")
  })

  it("round-trips offer with binary payload (delta)", () => {
    const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd])
    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-crdt",
      payload: {
        kind: "since",
        encoding: "binary",
        data: binaryData,
      },
      version: "AQ==:3",
      reciprocate: true,
    }
    const decoded = roundTrip(msg) as OfferMsg
    expect(decoded.type).toBe("offer")
    expect(decoded.docId).toBe("doc-crdt")
    expect(decoded.payload.encoding).toBe("binary")
    expect(decoded.version).toBe("AQ==:3")
    expect(decoded.reciprocate).toBe(true)

    // Uint8Array should survive the round-trip via base64
    expect(decoded.payload.data).toBeInstanceOf(Uint8Array)
    expect(decoded.payload.data).toEqual(binaryData)
  })

  it("binary payload data is base64-encoded in the JSON-safe output", () => {
    const binaryData = new Uint8Array([72, 101, 108, 108, 111]) // "Hello" in ASCII
    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-1",
      payload: {
        kind: "entirety",
        encoding: "binary",
        data: binaryData,
      },
      version: "1",
    }

    const encoded = textCodec.encode(msg) as Record<string, unknown>
    const payload = encoded.payload as Record<string, unknown>

    // The data should be base64-encoded
    expect(payload.encoding).toBe("binary")
    expect(typeof payload.data).toBe("string")
    // btoa("Hello") === "SGVsbG8="
    expect(payload.data).toBe("SGVsbG8=")
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
      payload: {
        kind: "entirety",
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
      payload: {
        kind: "entirety",
        encoding: "json",
        data: "{}",
      },
      version: "1",
    }
    const decoded = roundTrip(msg) as OfferMsg
    expect("reciprocate" in decoded).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Dismiss
// ---------------------------------------------------------------------------

describe("Text codec — dismiss", () => {
  it("round-trips dismiss message", () => {
    const msg: DismissMsg = {
      type: "dismiss",
      docId: "doc-to-leave",
    }
    const decoded = roundTrip(msg)
    expect(decoded).toEqual(msg)
  })
})

// ---------------------------------------------------------------------------
// Batch encoding
// ---------------------------------------------------------------------------

describe("Text codec — batch", () => {
  it("round-trips a batch of mixed message types", () => {
    const msgs: ChannelMsg[] = [
      {
        type: "establish-request",
        identity: { peerId: "p1", name: "Peer One", type: "user" },
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
      {
        type: "interest",
        docId: "d1",
        version: "0",
        reciprocate: true,
      },
      {
        type: "offer",
        docId: "d1",
        payload: {
          kind: "since",
          encoding: "binary",
          data: new Uint8Array([1, 2, 3]),
        },
        version: "2",
        reciprocate: false,
      },
      {
        type: "dismiss",
        docId: "d1",
      },
    ]

    const encoded = textCodec.encode(msgs)

    const decoded = textCodec.decode(encoded)
    expect(decoded).toHaveLength(5)
    expect(decoded[0]!.type).toBe("establish-request")
    expect(decoded[1]!.type).toBe("present")
    expect(decoded[2]!.type).toBe("interest")
    expect(decoded[3]!.type).toBe("offer")
    expect(decoded[4]!.type).toBe("dismiss")

    // Verify the offer's binary payload survived
    const decodedOffer = decoded[3] as OfferMsg
    expect(decodedOffer.payload.data).toBeInstanceOf(Uint8Array)
    expect(decodedOffer.payload.data).toEqual(new Uint8Array([1, 2, 3]))
  })

  it("round-trips an empty batch", () => {
    const encoded = textCodec.encode([])
    const decoded = textCodec.decode(encoded)
    expect(decoded).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("Text codec — error handling", () => {
  it("throws on unknown message type", () => {
    const bad = { type: "unknown-type", data: 123 }
    expect(() => textCodec.decode(bad)).toThrow("Unknown JSON message type")
  })

  it("throws on unknown message type in batch", () => {
    const bad = [{ type: "unknown-type" }]
    expect(() => textCodec.decode(bad)).toThrow("Unknown JSON message type")
  })

  it("throws on null input", () => {
    expect(() => textCodec.decode(null)).toThrow()
  })

  it("throws on non-object input", () => {
    expect(() => textCodec.decode("not an object")).toThrow()
  })
})

// ---------------------------------------------------------------------------
// JSON-safe output verification
// ---------------------------------------------------------------------------

describe("Text codec — JSON-safe output", () => {
  it("encode output survives JSON.stringify → JSON.parse round-trip", () => {
    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-1",
      payload: {
        kind: "entirety",
        encoding: "binary",
        data: new Uint8Array([1, 2, 3, 4, 5]),
      },
      version: "1",
    }

    const encoded = textCodec.encode(msg)
    // Simulate going through JSON serialization (as a text frame would)
    const serialized = JSON.stringify(encoded)
    const deserialized = JSON.parse(serialized)
    const decoded = textCodec.decode(deserialized)
    expect(decoded).toHaveLength(1)
    const offer = decoded[0] as OfferMsg

    expect(offer.payload.data).toBeInstanceOf(Uint8Array)
    expect(offer.payload.data).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
  })

  it("encode(batch) output survives JSON.stringify → JSON.parse round-trip", () => {
    const msgs: ChannelMsg[] = [
      {
        type: "present",
        docs: [
          {
            docId: "a",
            schemaHash: "00test",
            replicaType: ["plain", 1, 0] as const,
            mergeStrategy: "sequential" as const,
          },
        ],
      },
      {
        type: "offer",
        docId: "b",
        payload: {
          kind: "since",
          encoding: "binary",
          data: new Uint8Array([10, 20]),
        },
        version: "1",
      },
    ]

    const encoded = textCodec.encode(msgs)
    const serialized = JSON.stringify(encoded)
    const deserialized = JSON.parse(serialized)
    const decoded = textCodec.decode(deserialized)

    expect(decoded).toHaveLength(2)
    expect(decoded[0]!.type).toBe("present")
    const offer = decoded[1] as OfferMsg
    expect(offer.payload.data).toEqual(new Uint8Array([10, 20]))
  })
})
