// Text codec tests — round-trip all message types via the alias-aware pipeline.
//
// Verifies that every ChannelMsg variant survives the full pipeline:
//   applyOutboundAliasing → encodeTextWireMessage → decodeTextWireMessage → applyInboundAliasing
//
// Special attention to SubstratePayload handling: binary payloads must be
// base64-encoded transparently, while JSON payloads pass through as-is.
//
// The alias-aware pipeline works with JSON-safe objects via encodeTextWireMessage.

import {
  SYNC_AUTHORITATIVE,
  SYNC_COLLABORATIVE,
  SYNC_EPHEMERAL,
} from "@kyneta/schema"
import type {
  ChannelMsg,
  DepartMsg,
  DismissMsg,
  EstablishMsg,
  InterestMsg,
  OfferMsg,
  PresentMsg,
} from "@kyneta/transport"
import { describe, expect, it } from "vitest"
import {
  applyInboundAliasing,
  applyOutboundAliasing,
  decodeTextWireMessage,
  emptyAliasState,
  encodeTextWireMessage,
} from "../index.js"
import type { WireMessage } from "../wire-types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundTripViaAlias(msg: ChannelMsg): ChannelMsg {
  const state = emptyAliasState()
  const { wire } = applyOutboundAliasing(state, msg)
  const encoded = encodeTextWireMessage(wire)
  const decoded = decodeTextWireMessage(encoded)
  const result = applyInboundAliasing(emptyAliasState(), decoded)
  if (result.error)
    throw new Error(`Alias resolution failed: ${result.error.code}`)
  if (!result.msg) throw new Error("Alias resolution produced no message")
  return result.msg
}

function roundTripBatchViaAlias(msgs: ChannelMsg[]): ChannelMsg[] {
  let outState = emptyAliasState()
  const encodedWires: unknown[] = []
  for (const msg of msgs) {
    const { state, wire } = applyOutboundAliasing(outState, msg)
    outState = state
    encodedWires.push(encodeTextWireMessage(wire))
  }

  let inState = emptyAliasState()
  const decoded: ChannelMsg[] = []
  for (const encoded of encodedWires) {
    const wire = decodeTextWireMessage(encoded)
    const result = applyInboundAliasing(inState, wire)
    if (result.error)
      throw new Error(`Alias resolution failed: ${result.error.code}`)
    if (!result.msg) throw new Error("Alias resolution produced no message")
    inState = result.state
    decoded.push(result.msg)
  }
  return decoded
}

// ---------------------------------------------------------------------------
// Lifecycle messages
// ---------------------------------------------------------------------------

describe("Text codec — lifecycle messages", () => {
  it("round-trips establish with full identity", () => {
    const msg: EstablishMsg = {
      type: "establish",
      identity: {
        peerId: "peer-alice-123",
        name: "Alice",
        type: "user",
      },
    }
    const decoded = roundTripViaAlias(msg)
    expect(decoded).toEqual(msg)
  })

  it("round-trips establish without optional name", () => {
    const msg: EstablishMsg = {
      type: "establish",
      identity: {
        peerId: "bot-42",
        type: "bot",
      },
    }
    const decoded = roundTripViaAlias(msg)
    expect(decoded.type).toBe("establish")
    const identity = (decoded as EstablishMsg).identity
    expect(identity.peerId).toBe("bot-42")
    expect(identity.type).toBe("bot")
    // The alias-aware pipeline preserves undefined fields (no JSON round-trip)
    expect(identity.name).toBeUndefined()
  })

  it("round-trips depart", () => {
    const msg: DepartMsg = {
      type: "depart",
    }
    const decoded = roundTripViaAlias(msg)
    expect(decoded).toEqual(msg)
  })

  it("uses compact integer discriminators (not human-readable type strings)", () => {
    const msg: EstablishMsg = {
      type: "establish",
      identity: { peerId: "p1", type: "user" },
    }
    const { wire } = applyOutboundAliasing(emptyAliasState(), msg)
    const encoded = encodeTextWireMessage(wire) as Record<string, unknown>
    // The alias-aware path uses integer discriminators (e.g. 0x01 for establish)
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
    const msg: PresentMsg = {
      type: "present",
      docs: [
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
        {
          docId: "doc-3",
          schemaHash: "00test",
          replicaType: ["loro", 1, 0] as const,
          syncProtocol: SYNC_EPHEMERAL,
        },
      ],
    }
    const decoded = roundTripViaAlias(msg)
    expect(decoded).toEqual(msg)
  })

  it("round-trips present with empty docIds", () => {
    const msg: PresentMsg = {
      type: "present",
      docs: [],
    }
    const decoded = roundTripViaAlias(msg)
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
    const decoded = roundTripViaAlias(msg)
    expect(decoded).toEqual(msg)
  })

  it("round-trips interest without optional fields", () => {
    const msg: InterestMsg = {
      type: "interest",
      docId: "doc-xyz",
    }
    const decoded = roundTripViaAlias(msg)
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
    const decoded = roundTripViaAlias(msg)
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
    const decoded = roundTripViaAlias(msg)
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

    const { wire } = applyOutboundAliasing(emptyAliasState(), msg)
    const encoded = encodeTextWireMessage(wire) as Record<string, unknown>

    // The data should be the original string, not base64
    expect(encoded.d).toBe(jsonData)
    // Encoding is an integer discriminator in the wire format
    expect(encoded.pe).toBe(0) // PayloadEncoding.Json
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
    const decoded = roundTripViaAlias(msg) as OfferMsg
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

    const { wire } = applyOutboundAliasing(emptyAliasState(), msg)
    const encoded = encodeTextWireMessage(wire) as Record<string, unknown>

    // The data should be wrapped in { __bytes: "..." } for JSON safety
    expect(encoded.pe).toBe(1) // PayloadEncoding.Binary
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
    const decoded = roundTripViaAlias(msg) as OfferMsg
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
    const decoded = roundTripViaAlias(msg) as OfferMsg
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
    const decoded = roundTripViaAlias(msg)
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
        type: "establish",
        identity: { peerId: "p1", name: "Peer One", type: "user" },
      },
      {
        type: "depart",
      },
      {
        type: "present",
        docs: [
          {
            docId: "d1",
            schemaHash: "00test",
            replicaType: ["plain", 1, 0] as const,
            syncProtocol: SYNC_AUTHORITATIVE,
          },
          {
            docId: "d2",
            schemaHash: "00test",
            replicaType: ["yjs", 1, 0] as const,
            syncProtocol: SYNC_COLLABORATIVE,
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

    const decoded = roundTripBatchViaAlias(msgs)
    expect(decoded).toHaveLength(6)
    expect(decoded[0]?.type).toBe("establish")
    expect(decoded[1]?.type).toBe("depart")
    expect(decoded[2]?.type).toBe("present")
    expect(decoded[3]?.type).toBe("interest")
    expect(decoded[4]?.type).toBe("offer")
    expect(decoded[5]?.type).toBe("dismiss")

    // Verify the offer's binary payload survived
    const decodedOffer = decoded[4] as OfferMsg
    expect(decodedOffer.payload.data).toBeInstanceOf(Uint8Array)
    expect(decodedOffer.payload.data).toEqual(new Uint8Array([1, 2, 3]))
  })

  it("round-trips an empty batch", () => {
    const decoded = roundTripBatchViaAlias([])
    expect(decoded).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("Text codec — error handling", () => {
  it("throws on unknown message type", () => {
    const bad = { t: 0xff, data: 123 } as unknown as WireMessage
    expect(() => applyInboundAliasing(emptyAliasState(), bad)).toThrow(
      "Unknown wire message type",
    )
  })

  it("throws on unknown message type in batch", () => {
    const bad = { t: 0xff } as unknown as WireMessage
    expect(() => applyInboundAliasing(emptyAliasState(), bad)).toThrow(
      "Unknown wire message type",
    )
  })

  it("throws on null input", () => {
    expect(() =>
      applyInboundAliasing(emptyAliasState(), null as never),
    ).toThrow()
  })

  it("throws on non-object input", () => {
    expect(() =>
      applyInboundAliasing(emptyAliasState(), "not an object" as never),
    ).toThrow()
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

    const { wire } = applyOutboundAliasing(emptyAliasState(), msg)
    const encoded = encodeTextWireMessage(wire)
    // Simulate going through JSON serialization (as a text frame would)
    const serialized = JSON.stringify(encoded)
    const deserialized = JSON.parse(serialized)
    const decoded = decodeTextWireMessage(deserialized)
    const result = applyInboundAliasing(emptyAliasState(), decoded)
    if (result.error)
      throw new Error(`Alias resolution failed: ${result.error.code}`)
    const offer = result.msg as OfferMsg

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
            syncProtocol: SYNC_AUTHORITATIVE,
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

    let outState = emptyAliasState()
    const encodedWires: unknown[] = []
    for (const msg of msgs) {
      const { state, wire } = applyOutboundAliasing(outState, msg)
      outState = state
      encodedWires.push(encodeTextWireMessage(wire))
    }

    const serialized = JSON.stringify(encodedWires)
    const deserialized = JSON.parse(serialized) as unknown[]

    let inState = emptyAliasState()
    const decoded: ChannelMsg[] = []
    for (const encoded of deserialized) {
      const wire = decodeTextWireMessage(encoded)
      const result = applyInboundAliasing(inState, wire)
      if (result.error)
        throw new Error(`Alias resolution failed: ${result.error.code}`)
      inState = result.state
      if (result.msg) decoded.push(result.msg)
    }

    expect(decoded).toHaveLength(2)
    expect(decoded[0]?.type).toBe("present")
    const offer = decoded[1] as OfferMsg
    expect(offer.payload.data).toEqual(new Uint8Array([10, 20]))
  })
})

// ---------------------------------------------------------------------------
// Identifier length caps (Phase 1)
// ---------------------------------------------------------------------------

import {
  DOC_ID_MAX_UTF8_BYTES,
  SCHEMA_HASH_MAX_UTF8_BYTES,
} from "../constants.js"

describe("Text codec — identifier length caps", () => {
  it("accepts a docId at the UTF-8 byte cap", () => {
    const docId = "a".repeat(DOC_ID_MAX_UTF8_BYTES)
    const msg: InterestMsg = { type: "interest", docId }
    const decoded = roundTripViaAlias(msg) as InterestMsg
    expect(decoded.docId).toEqual(docId)
  })

  it("accepts a docId at the cap built from a 4-byte UTF-8 codepoint", () => {
    const docId = `${"a".repeat(DOC_ID_MAX_UTF8_BYTES - 4)}🚀`
    expect(new TextEncoder().encode(docId).byteLength).toBe(
      DOC_ID_MAX_UTF8_BYTES,
    )
    const msg: InterestMsg = { type: "interest", docId }
    const decoded = roundTripViaAlias(msg) as InterestMsg
    expect(decoded.docId).toEqual(docId)
  })

  it("rejects a docId one byte over the cap", () => {
    const docId = "a".repeat(DOC_ID_MAX_UTF8_BYTES + 1)
    const msg: InterestMsg = { type: "interest", docId }
    const { wire } = applyOutboundAliasing(emptyAliasState(), msg)
    const encoded = encodeTextWireMessage(wire)
    const decoded = decodeTextWireMessage(encoded)
    const result = applyInboundAliasing(emptyAliasState(), decoded)
    expect(result.error).toBeDefined()
    expect(result.error?.code).toBe("doc-id-too-long")
    expect(result.msg).toBeUndefined()
  })

  it("rejects a schemaHash over the cap with a typed error", () => {
    const big = "h".repeat(SCHEMA_HASH_MAX_UTF8_BYTES + 1)
    const msg: PresentMsg = {
      type: "present",
      docs: [
        {
          docId: "doc-1",
          schemaHash: big,
          replicaType: ["plain", 1, 0] as const,
          syncProtocol: SYNC_AUTHORITATIVE,
        },
      ],
    }
    const { wire } = applyOutboundAliasing(emptyAliasState(), msg)
    const encoded = encodeTextWireMessage(wire)
    const decoded = decodeTextWireMessage(encoded)
    const result = applyInboundAliasing(emptyAliasState(), decoded)
    expect(result.error).toBeDefined()
    expect(result.error?.code).toBe("schema-hash-too-long")
    expect(result.msg).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// WireFeatures round-trip (Phase 2)
// ---------------------------------------------------------------------------

describe("Text codec — WireFeatures negotiation", () => {
  it("round-trips establish with all features advertised", () => {
    const msg: EstablishMsg = {
      type: "establish",
      identity: { peerId: "alice", type: "user" },
      features: { alias: true, streamed: true, datagram: true },
    }
    const decoded = roundTripViaAlias(msg) as EstablishMsg
    expect(decoded.features).toEqual({
      alias: true,
      streamed: true,
      datagram: true,
    })
  })

  it("round-trips establish with no features (legacy peer)", () => {
    const msg: EstablishMsg = {
      type: "establish",
      identity: { peerId: "alice", type: "user" },
    }
    const decoded = roundTripViaAlias(msg) as EstablishMsg
    expect(decoded.features).toBeUndefined()
  })

  it("round-trips establish with partial features", () => {
    const msg: EstablishMsg = {
      type: "establish",
      identity: { peerId: "alice", type: "user" },
      features: { alias: true },
    }
    const decoded = roundTripViaAlias(msg) as EstablishMsg
    expect(decoded.features).toEqual({ alias: true })
  })
})
