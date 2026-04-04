// CBOR codec tests — round-trip all 6 message types.
//
// Verifies that every ChannelMsg variant survives encode → decode
// through the CBOR codec, including OfferMsg with both "json" and
// "binary" SubstratePayload encodings.

import type {
  ChannelMsg,
  DismissMsg,
  EstablishRequestMsg,
  EstablishResponseMsg,
  InterestMsg,
  OfferMsg,
  PresentMsg,
} from "@kyneta/exchange"
import { type CBORType, encodeCBOR } from "@levischuck/tiny-cbor"
import { describe, expect, it } from "vitest"
import { cborCodec } from "../cbor.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundTrip(msg: ChannelMsg): ChannelMsg {
  const encoded = cborCodec.encode(msg)
  expect(encoded).toBeInstanceOf(Uint8Array)
  expect(encoded.length).toBeGreaterThan(0)
  const decoded = cborCodec.decode(encoded)
  expect(decoded).toHaveLength(1)
  return decoded[0]!
}

// ---------------------------------------------------------------------------
// Establishment messages
// ---------------------------------------------------------------------------

describe("CBOR codec — establishment messages", () => {
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
    // name should be absent (undefined), not null or empty string
    expect(identity.name).toBeUndefined()
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
})

// ---------------------------------------------------------------------------
// Exchange messages
// ---------------------------------------------------------------------------

describe("CBOR codec — present", () => {
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

describe("CBOR codec — interest", () => {
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
    expect(interest.version).toBeUndefined()
    expect(interest.reciprocate).toBeUndefined()
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

describe("CBOR codec — offer", () => {
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

    // Uint8Array should survive CBOR round-trip natively
    expect(decoded.payload.data).toBeInstanceOf(Uint8Array)
    expect(decoded.payload.data).toEqual(binaryData)
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
    expect(decoded.reciprocate).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Dismiss
// ---------------------------------------------------------------------------

describe("CBOR codec — dismiss", () => {
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

describe("CBOR codec — batch", () => {
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

    const encoded = cborCodec.encode(msgs)
    expect(encoded).toBeInstanceOf(Uint8Array)

    const decoded = cborCodec.decode(encoded)
    expect(decoded).toHaveLength(5)
    expect(decoded[0]?.type).toBe("establish-request")
    expect(decoded[1]?.type).toBe("present")
    expect(decoded[2]?.type).toBe("interest")
    expect(decoded[3]?.type).toBe("offer")
    expect(decoded[4]?.type).toBe("dismiss")

    // Verify deep equality
    expect(decoded[0]).toEqual(msgs[0])
    expect(decoded[1]).toEqual(msgs[1])
    expect(decoded[2]).toEqual(msgs[2])

    // Offer needs special comparison for Uint8Array
    const decodedOffer = decoded[3] as OfferMsg
    expect(decodedOffer.payload.data).toEqual(new Uint8Array([1, 2, 3]))
  })

  it("round-trips an empty batch", () => {
    const encoded = cborCodec.encode([])
    const decoded = cborCodec.decode(encoded)
    expect(decoded).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("CBOR codec — error handling", () => {
  it("throws on invalid CBOR data", () => {
    const garbage = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc])
    expect(() => cborCodec.decode(garbage)).toThrow("Failed to decode")
  })

  it("throws on empty input", () => {
    expect(() => cborCodec.decode(new Uint8Array(0))).toThrow()
  })

  it("throws on unknown message type discriminator", () => {
    // Craft a valid CBOR payload with an unrecognized type discriminator.
    // This simulates receiving a message from a newer protocol version.
    const wire = new Map<string, CBORType>([["t", 0xff]])
    const encoded = encodeCBOR(wire) as Uint8Array
    expect(() => cborCodec.decode(encoded)).toThrow(
      "Unknown wire message type: 255",
    )
  })

  it("throws on unknown payload kind in offer message", () => {
    const wire = new Map<string, CBORType>([
      ["t", 0x12], // Offer
      ["doc", "d1"],
      ["pk", 0x99], // invalid payload kind
      ["pe", 0x00], // valid encoding
      ["d", "data"],
      ["v", "1"],
    ])
    const encoded = encodeCBOR(wire) as Uint8Array
    expect(() => cborCodec.decode(encoded)).toThrow(
      "Unknown wire payload kind: 153",
    )
  })

  it("throws on unknown payload encoding in offer message", () => {
    const wire = new Map<string, CBORType>([
      ["t", 0x12], // Offer
      ["doc", "d1"],
      ["pk", 0x00], // valid payload kind (entirety)
      ["pe", 0x99], // invalid encoding
      ["d", "data"],
      ["v", "1"],
    ])
    const encoded = encodeCBOR(wire) as Uint8Array
    expect(() => cborCodec.decode(encoded)).toThrow(
      "Unknown wire payload encoding: 153",
    )
  })
})
