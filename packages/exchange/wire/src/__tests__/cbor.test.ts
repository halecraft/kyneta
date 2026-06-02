// Wire CBOR codec tests — round-trip all WireMessage types through
// encodeWireMessage → decodeWireMessage.
//
// Verifies that every WireMessage variant survives CBOR encode/decode,
// including WireOfferMsg with both "json" and "binary" payload encodings.
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
  decodeWireMessage,
  encodeWireMessage,
  validateDocId,
  validateSchemaHash,
  WireValidationFailure,
} from "../index.js"
import type {
  WireEstablishMsg,
  WireInterestMsg,
  WireMessage,
  WireOfferMsg,
  WirePresentMsg,
} from "../wire-types.js"
import {
  MessageType,
  PayloadEncoding,
  SyncModeWireToMode,
  syncModeToWire,
} from "../wire-types.js"
import {
  departWire,
  dismissWire,
  establishWire,
  interestWire,
  offerWire,
  presentWire,
  vacantWire,
} from "./__helpers__/wire-fixtures.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundTrip(wire: WireMessage): WireMessage {
  const bytes = encodeWireMessage(wire)
  return decodeWireMessage(bytes)
}

// ---------------------------------------------------------------------------
// Lifecycle messages
// ---------------------------------------------------------------------------

describe("CBOR codec — lifecycle messages", () => {
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

  it("round-trips establish with service identity", () => {
    const wire = establishWire({
      peerId: "service-backend",
      name: "Backend Service",
      type: "service",
    })
    const decoded = roundTrip(wire)
    expect(decoded).toEqual(wire)
  })

  it("round-trips depart", () => {
    const wire = departWire()
    const decoded = roundTrip(wire)
    expect(decoded).toEqual(wire)
  })
})

// ---------------------------------------------------------------------------
// Sync messages
// ---------------------------------------------------------------------------

describe("CBOR codec — present", () => {
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

describe("CBOR codec — interest", () => {
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

describe("CBOR codec — offer", () => {
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

    // Uint8Array should survive wire round-trip natively
    expect(decoded.d).toBeInstanceOf(Uint8Array)
    expect(decoded.d).toEqual(binaryData)
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
})

// ---------------------------------------------------------------------------
// Dismiss
// ---------------------------------------------------------------------------

describe("CBOR codec — dismiss", () => {
  it("round-trips dismiss message", () => {
    const wire = dismissWire("doc-to-leave")
    const decoded = roundTrip(wire)
    expect(decoded).toEqual(wire)
  })
})

// ---------------------------------------------------------------------------
// Vacant
// ---------------------------------------------------------------------------

describe("CBOR codec — vacant", () => {
  it("round-trips vacant message and carries the 0x14 discriminator", () => {
    const wire = vacantWire("doc-we-wont-serve")
    const decoded = roundTrip(wire)
    expect(decoded).toEqual(wire)
    expect(decoded.t).toBe(MessageType.Vacant)
    expect(MessageType.Vacant).toBe(0x14)
  })
})

// ---------------------------------------------------------------------------
// Batch encoding (each message independently round-tripped)
// ---------------------------------------------------------------------------

describe("CBOR codec — batch", () => {
  it("round-trips a batch of mixed message types", () => {
    const wires: WireMessage[] = [
      establishWire({ peerId: "p1", name: "Peer One", type: "user" }),
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
      departWire(),
    ]

    const decoded = wires.map(w => roundTrip(w))
    expect(decoded).toHaveLength(6)
    expect(decoded[0]?.t).toBe(MessageType.Establish)
    expect(decoded[1]?.t).toBe(MessageType.Present)
    expect(decoded[2]?.t).toBe(MessageType.Interest)
    expect(decoded[3]?.t).toBe(MessageType.Offer)
    expect(decoded[4]?.t).toBe(MessageType.Dismiss)
    expect(decoded[5]?.t).toBe(MessageType.Depart)

    // Verify deep equality
    expect(decoded[0]).toEqual(wires[0])
    expect(decoded[1]).toEqual(wires[1])
    expect(decoded[2]).toEqual(wires[2])
    expect(decoded[3]).toEqual(wires[3])
    expect(decoded[4]).toEqual(wires[4])
    expect(decoded[5]).toEqual(wires[5])
  })

  it("round-trips an empty batch", () => {
    const decoded = ([] as WireMessage[]).map(w => roundTrip(w))
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

  it("rejects unknown message type discriminator at decode", () => {
    // Craft a valid CBOR payload with an unrecognized type discriminator.
    // This simulates receiving a message from a newer protocol version.
    const wire = { t: 0xff } as unknown as WireMessage
    const encoded = encodeWireMessage(wire)
    expect(() => decodeWireMessage(encoded)).toThrow(WireValidationFailure)
  })

  it("rejects unknown payload kind in offer at decode", () => {
    const wire = {
      t: 0x12, // Offer
      doc: "d1",
      pk: 0x99, // invalid payload kind
      pe: 0x00, // valid encoding
      d: "data",
      v: "1",
    } as unknown as WireMessage
    const encoded = encodeWireMessage(wire)
    expect(() => decodeWireMessage(encoded)).toThrow(WireValidationFailure)
  })

  it("rejects unknown payload encoding in offer at decode", () => {
    const wire = {
      t: 0x12, // Offer
      doc: "d1",
      pk: 0x00, // valid payload kind (entirety)
      pe: 0x99, // invalid encoding
      d: "data",
      v: "1",
    } as unknown as WireMessage
    const encoded = encodeWireMessage(wire)
    expect(() => decodeWireMessage(encoded)).toThrow(WireValidationFailure)
  })
})

// ---------------------------------------------------------------------------
// Multi-byte UTF-8 (the bug that prompted replacing tiny-cbor)
// ---------------------------------------------------------------------------

describe("CBOR codec — multi-byte UTF-8", () => {
  it("round-trips offer with emoji in JSON payload", () => {
    const wire = offerWire({
      docId: "game:hand:player1",
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({ glyph: "🔥", name: "fire", tags: ["💧", "🪨"] }),
      version: "1",
    })
    const decoded = roundTrip(wire)
    expect(decoded).toEqual(wire)
  })

  it("round-trips offer with CJK characters in JSON payload", () => {
    const wire = offerWire({
      docId: "doc-i18n",
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({ title: "日本語テスト", count: 42 }),
      version: "3",
    })
    const decoded = roundTrip(wire)
    expect(decoded).toEqual(wire)
  })

  it("round-trips establish with non-ASCII peer name", () => {
    const wire = establishWire({
      peerId: "peer-jp-1",
      name: "日本語ユーザー",
      type: "user",
    })
    const decoded = roundTrip(wire)
    expect(decoded).toEqual(wire)
  })

  it("round-trips batch containing messages with non-ASCII fields", () => {
    const wires: WireMessage[] = [
      establishWire({ peerId: "p1", name: "André", type: "user" }),
      offerWire({
        docId: "doc-emoji",
        kind: "entirety",
        encoding: "json",
        data: JSON.stringify({ emoji: "🔥💧🪨💨🌀", café: true }),
        version: "1",
      }),
    ]

    const decoded = wires.map(w => roundTrip(w))
    expect(decoded).toHaveLength(2)
    expect(decoded[0]).toEqual(wires[0])
    expect(decoded[1]).toEqual(wires[1])
  })
})

// ---------------------------------------------------------------------------
// SyncMode wire round-trip
// ---------------------------------------------------------------------------

describe("SyncMode wire round-trip", () => {
  it("round-trips all three sync-mode constants through wire encoding", () => {
    for (const mode of [
      SYNC_AUTHORITATIVE,
      SYNC_COLLABORATIVE,
      SYNC_EPHEMERAL,
    ]) {
      const wireValue = syncModeToWire(mode)
      const decoded = SyncModeWireToMode[wireValue]
      expect(decoded).toEqual(mode)
    }
  })
})

// ---------------------------------------------------------------------------
// Identifier length caps
//
// The CBOR codec itself does not enforce identifier length caps — that
// responsibility belongs to the transport alias layer. These tests
// verify the validateDocId / validateSchemaHash validators directly,
// and confirm that CBOR encode/decode faithfully preserves identifiers
// at the boundary length.
// ---------------------------------------------------------------------------

describe("CBOR codec — identifier length caps", () => {
  it("accepts a docId exactly at the UTF-8 byte cap", () => {
    const docId = "a".repeat(DOC_ID_MAX_UTF8_BYTES)
    expect(validateDocId(docId)).toBeNull()
    const wire = interestWire({ docId })
    const decoded = roundTrip(wire) as WireInterestMsg
    expect(decoded.doc).toEqual(docId)
  })

  it("accepts a docId one byte under the cap with a 4-byte UTF-8 codepoint", () => {
    // 🚀 (rocket) is 4 UTF-8 bytes. Build a docId at the boundary:
    // (cap - 4) ASCII bytes + one rocket = exactly cap bytes.
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

  it("rejects a multi-byte UTF-8 docId one byte over the cap", () => {
    // (cap - 4) + 4-byte rocket + 1 ASCII byte = cap + 1
    const docId = `${"a".repeat(DOC_ID_MAX_UTF8_BYTES - 4)}🚀a`
    expect(new TextEncoder().encode(docId).byteLength).toBe(
      DOC_ID_MAX_UTF8_BYTES + 1,
    )
    const error = validateDocId(docId)
    expect(error).not.toBeNull()
    expect(error?.code).toBe("doc-id-too-long")
  })

  it("accepts a schemaHash at the cap and rejects one byte over", () => {
    const okHash = "h".repeat(SCHEMA_HASH_MAX_UTF8_BYTES)
    const overHash = "h".repeat(SCHEMA_HASH_MAX_UTF8_BYTES + 1)

    // Accept: at the cap
    expect(validateSchemaHash(okHash)).toBeNull()
    const wire = presentWire([
      {
        docId: "doc-1",
        schemaHash: okHash,
        replicaType: ["plain", 1, 0] as const,
        syncMode: SYNC_AUTHORITATIVE,
      },
    ])
    const decoded = roundTrip(wire) as WirePresentMsg
    expect(decoded.docs[0]?.sh).toEqual(okHash)

    // Reject: one byte over
    const error = validateSchemaHash(overHash)
    expect(error).not.toBeNull()
    expect(error?.code).toBe("schema-hash-too-long")
  })

  it("rejects an oversize docId on offer and dismiss", () => {
    const big = "a".repeat(DOC_ID_MAX_UTF8_BYTES + 1)
    const offerError = validateDocId(big)
    expect(offerError).not.toBeNull()
    expect(offerError?.code).toBe("doc-id-too-long")

    const dismissError = validateDocId(big)
    expect(dismissError).not.toBeNull()
    expect(dismissError?.code).toBe("doc-id-too-long")
  })
})

// ---------------------------------------------------------------------------
// WireFeatures round-trip
// ---------------------------------------------------------------------------

describe("CBOR codec — WireFeatures negotiation", () => {
  it("round-trips establish with all features advertised", () => {
    const wire = establishWire({
      peerId: "alice",
      type: "user",
      features: { alias: true, streamed: true, datagram: true },
    })
    const decoded = roundTrip(wire) as WireEstablishMsg
    expect(decoded.f).toEqual({ a: true, s: true, d: true })
  })

  it("round-trips establish with only alias advertised", () => {
    const wire = establishWire({
      peerId: "alice",
      type: "user",
      features: { alias: true },
    })
    const decoded = roundTrip(wire) as WireEstablishMsg
    expect(decoded.f).toEqual({ a: true })
  })

  it("round-trips establish with no features (legacy peer)", () => {
    const wire = establishWire({ peerId: "alice", type: "user" })
    const decoded = roundTrip(wire) as WireEstablishMsg
    expect(decoded.f).toBeUndefined()
  })

  it("round-trips establish with explicit-false features", () => {
    const wire = establishWire({
      peerId: "alice",
      type: "user",
      features: { alias: false, streamed: false },
    })
    const decoded = roundTrip(wire) as WireEstablishMsg
    expect(decoded.f).toEqual({ a: false, s: false })
  })

  it("round-trips establish with a non-default protocolVersion (pv)", () => {
    // Exercises the pv emit path even though (1,0) peers omit it.
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
})
