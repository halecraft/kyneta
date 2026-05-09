// Wire pipeline tests — round-trip all message types through the
// alias-aware pipeline.
//
// Verifies that every ChannelMsg variant survives
// applyOutboundAliasing → encodeWireMessage → decodeWireMessage →
// applyInboundAliasing, including OfferMsg with both "json" and
// "binary" SubstratePayload encodings.

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
  decodeWireMessage,
  emptyAliasState,
  encodeWireMessage,
} from "../index.js"
import type { WireMessage } from "../wire-types.js"
import {
  SyncProtocolWireToProtocol,
  syncProtocolToWire,
} from "../wire-types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundTripViaAlias(msg: ChannelMsg): ChannelMsg {
  const state = emptyAliasState()
  const { wire } = applyOutboundAliasing(state, msg)
  const bytes = encodeWireMessage(wire)
  const decoded = decodeWireMessage(bytes)
  const result = applyInboundAliasing(emptyAliasState(), decoded)
  if (result.error)
    throw new Error(`Alias resolution failed: ${result.error.code}`)
  if (!result.msg) throw new Error("Alias resolution produced no message")
  return result.msg
}

// ---------------------------------------------------------------------------
// Lifecycle messages
// ---------------------------------------------------------------------------

describe("CBOR codec — lifecycle messages", () => {
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
    // name should be absent (undefined), not null or empty string
    expect(identity.name).toBeUndefined()
  })

  it("round-trips establish with service identity", () => {
    const msg: EstablishMsg = {
      type: "establish",
      identity: {
        peerId: "service-backend",
        name: "Backend Service",
        type: "service",
      },
    }
    const decoded = roundTripViaAlias(msg)
    expect(decoded).toEqual(msg)
  })

  it("round-trips depart", () => {
    const msg: DepartMsg = {
      type: "depart",
    }
    const decoded = roundTripViaAlias(msg)
    expect(decoded).toEqual(msg)
  })
})

// ---------------------------------------------------------------------------
// Sync messages
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

describe("CBOR codec — interest", () => {
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
    const decoded = roundTripViaAlias(msg)
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
    const decoded = roundTripViaAlias(msg)
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
    const decoded = roundTripViaAlias(msg) as OfferMsg
    expect(decoded.type).toBe("offer")
    expect(decoded.docId).toBe("doc-crdt")
    expect(decoded.payload.encoding).toBe("binary")
    expect(decoded.version).toBe("AQ==:3")
    expect(decoded.reciprocate).toBe(true)

    // Uint8Array should survive wire round-trip natively
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
    const decoded = roundTripViaAlias(msg)
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
        type: "establish",
        identity: { peerId: "p1", name: "Peer One", type: "user" },
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
      {
        type: "depart",
      },
    ]

    const decoded = msgs.map(m => roundTripViaAlias(m))
    expect(decoded).toHaveLength(6)
    expect(decoded[0]?.type).toBe("establish")
    expect(decoded[1]?.type).toBe("present")
    expect(decoded[2]?.type).toBe("interest")
    expect(decoded[3]?.type).toBe("offer")
    expect(decoded[4]?.type).toBe("dismiss")
    expect(decoded[5]?.type).toBe("depart")

    // Verify deep equality
    expect(decoded[0]).toEqual(msgs[0])
    expect(decoded[1]).toEqual(msgs[1])
    expect(decoded[2]).toEqual(msgs[2])
    expect(decoded[3]).toEqual(msgs[3])
    expect(decoded[4]).toEqual(msgs[4])
    expect(decoded[5]).toEqual(msgs[5])
  })

  it("round-trips an empty batch", () => {
    const decoded = ([] as ChannelMsg[]).map(m => roundTripViaAlias(m))
    expect(decoded).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("CBOR codec — error handling", () => {
  it("throws on invalid CBOR data", () => {
    const garbage = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc])
    expect(() => decodeWireMessage(garbage)).toThrow("Failed to decode")
  })

  it("throws on empty input", () => {
    expect(() => decodeWireMessage(new Uint8Array(0))).toThrow()
  })

  it("throws on unknown message type discriminator", () => {
    // Craft a valid CBOR payload with an unrecognized type discriminator.
    // This simulates receiving a message from a newer protocol version.
    const wire = { t: 0xff } as unknown as WireMessage
    const encoded = encodeWireMessage(wire)
    const decoded = decodeWireMessage(encoded)
    expect(() => applyInboundAliasing(emptyAliasState(), decoded)).toThrow(
      "Unknown wire message type: 255",
    )
  })

  it("throws on unknown payload kind in offer message", () => {
    const wire = {
      t: 0x12, // Offer
      doc: "d1",
      pk: 0x99, // invalid payload kind
      pe: 0x00, // valid encoding
      d: "data",
      v: "1",
    } as unknown as WireMessage
    const encoded = encodeWireMessage(wire)
    const decoded = decodeWireMessage(encoded)
    expect(() => applyInboundAliasing(emptyAliasState(), decoded)).toThrow(
      "Unknown wire payload kind: 153",
    )
  })

  it("throws on unknown payload encoding in offer message", () => {
    const wire = {
      t: 0x12, // Offer
      doc: "d1",
      pk: 0x00, // valid payload kind (entirety)
      pe: 0x99, // invalid encoding
      d: "data",
      v: "1",
    } as unknown as WireMessage
    const encoded = encodeWireMessage(wire)
    const decoded = decodeWireMessage(encoded)
    expect(() => applyInboundAliasing(emptyAliasState(), decoded)).toThrow(
      "Unknown wire payload encoding: 153",
    )
  })
})

// ---------------------------------------------------------------------------
// Multi-byte UTF-8 (the bug that prompted replacing tiny-cbor)
// ---------------------------------------------------------------------------

describe("CBOR codec — multi-byte UTF-8", () => {
  it("round-trips offer with emoji in JSON payload", () => {
    const msg: OfferMsg = {
      type: "offer",
      docId: "game:hand:player1",
      payload: {
        kind: "entirety",
        encoding: "json",
        data: JSON.stringify({ glyph: "🔥", name: "fire", tags: ["💧", "🪨"] }),
      },
      version: "1",
    }
    const decoded = roundTripViaAlias(msg)
    expect(decoded).toEqual(msg)
  })

  it("round-trips offer with CJK characters in JSON payload", () => {
    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-i18n",
      payload: {
        kind: "entirety",
        encoding: "json",
        data: JSON.stringify({ title: "日本語テスト", count: 42 }),
      },
      version: "3",
    }
    const decoded = roundTripViaAlias(msg)
    expect(decoded).toEqual(msg)
  })

  it("round-trips establish with non-ASCII peer name", () => {
    const msg: EstablishMsg = {
      type: "establish",
      identity: {
        peerId: "peer-jp-1",
        name: "日本語ユーザー",
        type: "user",
      },
    }
    const decoded = roundTripViaAlias(msg)
    expect(decoded).toEqual(msg)
  })

  it("round-trips batch containing messages with non-ASCII fields", () => {
    const msgs: ChannelMsg[] = [
      {
        type: "establish",
        identity: { peerId: "p1", name: "André", type: "user" },
      },
      {
        type: "offer",
        docId: "doc-emoji",
        payload: {
          kind: "entirety",
          encoding: "json",
          data: JSON.stringify({ emoji: "🔥💧🪨💨🌀", café: true }),
        },
        version: "1",
      },
    ]

    const decoded = msgs.map(m => roundTripViaAlias(m))
    expect(decoded).toHaveLength(2)
    expect(decoded[0]).toEqual(msgs[0])
    expect(decoded[1]).toEqual(msgs[1])
  })
})

// ---------------------------------------------------------------------------
// SyncProtocol wire round-trip
// ---------------------------------------------------------------------------

describe("SyncProtocol wire round-trip", () => {
  it("round-trips all three protocol constants through wire encoding", () => {
    for (const protocol of [
      SYNC_AUTHORITATIVE,
      SYNC_COLLABORATIVE,
      SYNC_EPHEMERAL,
    ]) {
      const wireValue = syncProtocolToWire(protocol)
      const decoded = SyncProtocolWireToProtocol[wireValue]
      expect(decoded).toEqual(protocol)
    }
  })
})

// ---------------------------------------------------------------------------
// Identifier length caps (Phase 1)
// ---------------------------------------------------------------------------

import {
  DOC_ID_MAX_UTF8_BYTES,
  SCHEMA_HASH_MAX_UTF8_BYTES,
} from "../constants.js"

describe("CBOR codec — identifier length caps", () => {
  it("accepts a docId exactly at the UTF-8 byte cap", () => {
    const docId = "a".repeat(DOC_ID_MAX_UTF8_BYTES)
    const msg: InterestMsg = { type: "interest", docId }
    const decoded = roundTripViaAlias(msg) as InterestMsg
    expect(decoded.docId).toEqual(docId)
  })

  it("accepts a docId one byte under the cap with a 4-byte UTF-8 codepoint", () => {
    // 🚀 (rocket) is 4 UTF-8 bytes. Build a docId at the boundary:
    // (cap - 4) ASCII bytes + one rocket = exactly cap bytes.
    const docId = `${"a".repeat(DOC_ID_MAX_UTF8_BYTES - 4)}🚀`
    expect(new TextEncoder().encode(docId).byteLength).toBe(
      DOC_ID_MAX_UTF8_BYTES,
    )
    const msg: InterestMsg = { type: "interest", docId }
    const decoded = roundTripViaAlias(msg) as InterestMsg
    expect(decoded.docId).toEqual(docId)
  })

  it("rejects a docId one byte over the cap with a typed error", () => {
    const docId = "a".repeat(DOC_ID_MAX_UTF8_BYTES + 1)
    const msg: InterestMsg = { type: "interest", docId }
    expect(() => roundTripViaAlias(msg)).toThrow("doc-id-too-long")
  })

  it("rejects a multi-byte UTF-8 docId one byte over the cap", () => {
    // (cap - 4) + 4-byte rocket + 1 ASCII byte = cap + 1
    const docId = `${"a".repeat(DOC_ID_MAX_UTF8_BYTES - 4)}🚀a`
    expect(new TextEncoder().encode(docId).byteLength).toBe(
      DOC_ID_MAX_UTF8_BYTES + 1,
    )
    const msg: InterestMsg = { type: "interest", docId }
    expect(() => roundTripViaAlias(msg)).toThrow("doc-id-too-long")
  })

  it("accepts a schemaHash at the cap and rejects one byte over", () => {
    const okHash = "h".repeat(SCHEMA_HASH_MAX_UTF8_BYTES)
    const overHash = "h".repeat(SCHEMA_HASH_MAX_UTF8_BYTES + 1)
    const okMsg: PresentMsg = {
      type: "present",
      docs: [
        {
          docId: "doc-1",
          schemaHash: okHash,
          replicaType: ["plain", 1, 0] as const,
          syncProtocol: SYNC_AUTHORITATIVE,
        },
      ],
    }
    const overMsg: PresentMsg = {
      type: "present",
      docs: [
        {
          docId: "doc-1",
          schemaHash: overHash,
          replicaType: ["plain", 1, 0] as const,
          syncProtocol: SYNC_AUTHORITATIVE,
        },
      ],
    }
    const decoded = roundTripViaAlias(okMsg) as PresentMsg
    expect(decoded.docs[0]?.schemaHash).toEqual(okHash)

    expect(() => roundTripViaAlias(overMsg)).toThrow("schema-hash-too-long")
  })

  it("rejects an oversize docId on offer and dismiss", () => {
    const big = "a".repeat(DOC_ID_MAX_UTF8_BYTES + 1)
    const offerMsg: OfferMsg = {
      type: "offer",
      docId: big,
      payload: { kind: "entirety", encoding: "json", data: "{}" },
      version: "v",
    }
    const dismissMsg: DismissMsg = { type: "dismiss", docId: big }
    expect(() => roundTripViaAlias(offerMsg)).toThrow("doc-id-too-long")
    expect(() => roundTripViaAlias(dismissMsg)).toThrow("doc-id-too-long")
  })
})

// ---------------------------------------------------------------------------
// WireFeatures round-trip (Phase 2)
// ---------------------------------------------------------------------------

describe("CBOR codec — WireFeatures negotiation", () => {
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

  it("round-trips establish with only alias advertised", () => {
    const msg: EstablishMsg = {
      type: "establish",
      identity: { peerId: "alice", type: "user" },
      features: { alias: true },
    }
    const decoded = roundTripViaAlias(msg) as EstablishMsg
    expect(decoded.features).toEqual({ alias: true })
  })

  it("round-trips establish with no features (legacy peer)", () => {
    const msg: EstablishMsg = {
      type: "establish",
      identity: { peerId: "alice", type: "user" },
    }
    const decoded = roundTripViaAlias(msg) as EstablishMsg
    expect(decoded.features).toBeUndefined()
  })

  it("round-trips establish with explicit-false features", () => {
    const msg: EstablishMsg = {
      type: "establish",
      identity: { peerId: "alice", type: "user" },
      features: { alias: false, streamed: false },
    }
    const decoded = roundTripViaAlias(msg) as EstablishMsg
    expect(decoded.features).toEqual({ alias: false, streamed: false })
  })
})
