// Text frame encode/decode tests.
//
// Verifies the text wire format: 2-char prefix ("Vx" where V=version,
// x=type/hash via case), JSON array envelope, fragment fields,
// fragmentTextPayload splitting, and end-to-end with TextReassembler.

import type { ChannelMsg, OfferMsg, PresentMsg } from "@kyneta/transport"
import { describe, expect, it } from "vitest"
import { complete, fragment, isComplete, isFragment } from "../frame-types.js"
import { textCodec } from "../json.js"
import {
  decodeTextFrame,
  encodeTextComplete,
  encodeTextCompleteBatch,
  encodeTextFrame,
  fragmentTextPayload,
  TEXT_WIRE_VERSION,
  TextFrameDecodeError,
} from "../text-frame.js"
import { TextReassembler } from "../text-reassembler.js"

// ---------------------------------------------------------------------------
// Prefix correctness
// ---------------------------------------------------------------------------

describe("Text frame — prefix", () => {
  it("complete frame with no hash has prefix '0c'", () => {
    const frame = complete(TEXT_WIRE_VERSION, '{"type":"present","docs":[]}')
    const wire = encodeTextFrame(frame)
    const arr = JSON.parse(wire)
    expect(arr[0]).toBe("0c")
  })

  it("complete frame with hash has prefix '0C'", () => {
    const frame = complete(
      TEXT_WIRE_VERSION,
      '{"type":"present","docs":[]}',
      "abcdef1234567890",
    )
    const wire = encodeTextFrame(frame)
    const arr = JSON.parse(wire)
    expect(arr[0]).toBe("0C")
  })

  it("fragment frame with no hash has prefix '0f'", () => {
    const frame = fragment(TEXT_WIRE_VERSION, "aabbccdd", 0, 3, 100, "chunk")
    const wire = encodeTextFrame(frame)
    const arr = JSON.parse(wire)
    expect(arr[0]).toBe("0f")
  })

  it("fragment frame with hash has prefix '0F'", () => {
    const frame = fragment(
      TEXT_WIRE_VERSION,
      "aabbccdd",
      0,
      3,
      100,
      "chunk",
      "deadbeef",
    )
    const wire = encodeTextFrame(frame)
    const arr = JSON.parse(wire)
    expect(arr[0]).toBe("0F")
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
          mergeStrategy: "authoritative" as const,
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
            mergeStrategy: "authoritative" as const,
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

  it("round-trips a complete frame with hash", () => {
    const payload = JSON.stringify({ type: "present", docs: [] })
    const hash = "abc123def456"
    const frame = complete(TEXT_WIRE_VERSION, payload, hash)
    const wire = encodeTextFrame(frame)
    const decoded = decodeTextFrame(wire)

    expect(decoded.hash).toBe(hash)
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
          mergeStrategy: "authoritative" as const,
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
          mergeStrategy: "authoritative" as const,
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
    const frameId = "a1b2c3d4"
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

  it("round-trips a fragment frame with hash", () => {
    const hash = "sha256hexdigest"
    const frame = fragment(TEXT_WIRE_VERSION, "fid", 0, 3, 100, "chunk", hash)
    const wire = encodeTextFrame(frame)
    const decoded = decodeTextFrame(wire)

    expect(decoded.hash).toBe(hash)
    if (decoded.content.kind === "fragment") {
      expect(decoded.content.frameId).toBe("fid")
      expect(decoded.content.index).toBe(0)
      expect(decoded.content.total).toBe(3)
      expect(decoded.content.totalSize).toBe(100)
      expect(decoded.content.payload).toBe("chunk")
    }
  })

  it("fragment fields are correct types", () => {
    const frame = fragment(TEXT_WIRE_VERSION, "abc", 1, 4, 200, "data")
    const wire = encodeTextFrame(frame)
    const arr = JSON.parse(wire)

    // ["0f", frameId, index, total, totalSize, chunk]
    expect(typeof arr[0]).toBe("string") // prefix
    expect(typeof arr[1]).toBe("string") // frameId
    expect(typeof arr[2]).toBe("number") // index
    expect(typeof arr[3]).toBe("number") // total
    expect(typeof arr[4]).toBe("number") // totalSize
    expect(typeof arr[5]).toBe("string") // chunk
  })
})

// ---------------------------------------------------------------------------
// fragmentTextPayload
// ---------------------------------------------------------------------------

describe("fragmentTextPayload", () => {
  it("splits a payload into correct number of fragments", () => {
    const payload = "abcdefghij" // 10 chars
    const fragments = fragmentTextPayload(payload, 3)

    // ceil(10/3) = 4 fragments
    expect(fragments.length).toBe(4)
  })

  it("each fragment is valid JSON", () => {
    const payload =
      '{"type":"present","docs":[{"docId":"a"},{"docId":"b"},{"docId":"c"},{"docId":"d"},{"docId":"e"},{"docId":"f"}]}'
    const fragments = fragmentTextPayload(payload, 10)

    for (const frag of fragments) {
      expect(() => JSON.parse(frag)).not.toThrow()
    }
  })

  it("all fragments share the same frameId", () => {
    const payload = "abcdefghijklmnopqrstuvwxyz" // 26 chars
    const fragments = fragmentTextPayload(payload, 5)

    const frameIds = new Set<string>()
    for (const frag of fragments) {
      const frame = decodeTextFrame(frag)
      if (frame.content.kind === "fragment") {
        frameIds.add(frame.content.frameId)
      }
    }

    expect(frameIds.size).toBe(1)
  })

  it("fragments have correct index, total, and totalSize", () => {
    const payload = "0123456789" // 10 chars
    const fragments = fragmentTextPayload(payload, 3)
    // 4 fragments: "012", "345", "678", "9"

    for (let i = 0; i < fragments.length; i++) {
      const frag = fragments.at(i)
      if (!frag) throw new Error(`Missing fragment at index ${i}`)
      const frame = decodeTextFrame(frag)
      expect(frame.content.kind).toBe("fragment")
      if (frame.content.kind === "fragment") {
        expect(frame.content.index).toBe(i)
        expect(frame.content.total).toBe(4)
        expect(frame.content.totalSize).toBe(10)
      }
    }
  })

  it("concatenated chunks reconstruct the original payload", () => {
    const payload =
      '{"type":"offer","docId":"doc-1","payload":{"encoding":"json","data":"hello"},"version":"1"}'
    const fragments = fragmentTextPayload(payload, 20)

    const chunks: string[] = []
    for (const frag of fragments) {
      const frame = decodeTextFrame(frag)
      if (frame.content.kind === "fragment") {
        chunks[frame.content.index] = frame.content.payload
      }
    }

    const reassembled = chunks.join("")
    expect(reassembled).toBe(payload)
  })

  it("handles single-chunk fragmentation (payload smaller than maxChunkSize)", () => {
    const payload = "tiny"
    const fragments = fragmentTextPayload(payload, 100)

    expect(fragments.length).toBe(1)

    const first = fragments.at(0)
    if (!first) throw new Error("Expected at least one fragment")
    const frame = decodeTextFrame(first)
    if (frame.content.kind === "fragment") {
      expect(frame.content.index).toBe(0)
      expect(frame.content.total).toBe(1)
      expect(frame.content.totalSize).toBe(4)
      expect(frame.content.payload).toBe("tiny")
    }
  })

  it("handles exact chunk boundary", () => {
    const payload = "abcdef" // 6 chars, chunkSize 3 → exactly 2 chunks
    const fragments = fragmentTextPayload(payload, 3)

    expect(fragments.length).toBe(2)

    const chunks: string[] = []
    for (const frag of fragments) {
      const frame = decodeTextFrame(frag)
      if (frame.content.kind === "fragment") {
        chunks[frame.content.index] = frame.content.payload
      }
    }

    expect(chunks[0]).toBe("abc")
    expect(chunks[1]).toBe("def")
  })

  it("throws on zero maxChunkSize", () => {
    expect(() => fragmentTextPayload("abc", 0)).toThrow(
      "maxChunkSize must be positive",
    )
  })

  it("throws on negative maxChunkSize", () => {
    expect(() => fragmentTextPayload("abc", -1)).toThrow(
      "maxChunkSize must be positive",
    )
  })

  it("different calls produce different frameIds", () => {
    const fragments1 = fragmentTextPayload("hello", 2)
    const fragments2 = fragmentTextPayload("hello", 2)

    const getFrameId = (wire: string) => {
      const frame = decodeTextFrame(wire)
      return frame.content.kind === "fragment" ? frame.content.frameId : ""
    }

    const f1first = fragments1.at(0)
    if (!f1first)
      throw new Error("Expected at least one fragment in fragments1")
    const f2first = fragments2.at(0)
    if (!f2first)
      throw new Error("Expected at least one fragment in fragments2")
    expect(getFrameId(f1first)).not.toBe(getFrameId(f2first))
  })
})

// ---------------------------------------------------------------------------
// Convenience functions
// ---------------------------------------------------------------------------

describe("Text frame — convenience functions", () => {
  it("encodeTextComplete encodes a single message", () => {
    const msg: PresentMsg = {
      type: "present",
      docs: [
        {
          docId: "doc-1",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "authoritative" as const,
        },
        {
          docId: "doc-2",
          schemaHash: "00test",
          replicaType: ["yjs", 1, 0] as const,
          mergeStrategy: "collaborative" as const,
        },
      ],
    }
    const wire = encodeTextComplete(textCodec, msg)

    const frame = decodeTextFrame(wire)
    expect(isComplete(frame)).toBe(true)

    const decoded = textCodec.decode(JSON.parse(frame.content.payload))
    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toEqual(msg)
  })

  it("encodeTextCompleteBatch encodes a batch", () => {
    const msgs: ChannelMsg[] = [
      {
        type: "present",
        docs: [
          {
            docId: "a",
            schemaHash: "00test",
            replicaType: ["plain", 1, 0] as const,
            mergeStrategy: "authoritative" as const,
          },
        ],
      },
      { type: "interest", docId: "b", version: "1" },
    ]
    const wire = encodeTextCompleteBatch(textCodec, msgs)

    const frame = decodeTextFrame(wire)
    expect(isComplete(frame)).toBe(true)

    const decoded = textCodec.decode(JSON.parse(frame.content.payload))
    expect(decoded).toHaveLength(2)
    expect(decoded[0]?.type).toBe("present")
    expect(decoded[1]?.type).toBe("interest")
  })

  it("encodeTextComplete handles offer with binary payload", () => {
    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-1",
      payload: {
        kind: "entirety",
        encoding: "binary",
        data: new Uint8Array([1, 2, 3]),
      },
      version: "1",
    }
    const wire = encodeTextComplete(textCodec, msg)
    const frame = decodeTextFrame(wire)
    const decoded = textCodec.decode(JSON.parse(frame.content.payload))
    expect(decoded).toHaveLength(1)
    const offer = decoded[0] as OfferMsg

    expect(offer.payload.encoding).toBe("binary")
    expect(offer.payload.data).toBeInstanceOf(Uint8Array)
    expect(offer.payload.data).toEqual(new Uint8Array([1, 2, 3]))
  })
})

// ---------------------------------------------------------------------------
// End-to-end: fragment → TextReassembler → decode
// ---------------------------------------------------------------------------

describe("Text frame — end-to-end with TextReassembler", () => {
  it("single message: encode → fragment → reassemble → decode", () => {
    const msg: OfferMsg = {
      type: "offer",
      docId: "doc-large",
      payload: {
        kind: "entirety",
        encoding: "json",
        data: JSON.stringify({
          items: Array.from({ length: 100 }, (_, i) => `item-${i}`),
        }),
      },
      version: "42",
    }

    // Encode to complete frame payload
    const payload = JSON.stringify(textCodec.encode(msg))

    // Fragment into small chunks
    const fragments = fragmentTextPayload(payload, 50)
    expect(fragments.length).toBeGreaterThan(1)

    // Feed to reassembler
    const reassembler = new TextReassembler({ timeoutMs: 5000 })
    const firstFrag = fragments.at(0)
    if (!firstFrag) throw new Error("Expected at least one fragment")
    let result = reassembler.receive(firstFrag)

    for (let i = 1; i < fragments.length; i++) {
      const frag = fragments.at(i)
      if (!frag) throw new Error(`Missing fragment at index ${i}`)
      result = reassembler.receive(frag)
    }

    expect(result.status).toBe("complete")
    if (result.status === "complete") {
      expect(isComplete(result.frame)).toBe(true)
      const decoded = textCodec.decode(JSON.parse(result.frame.content.payload))
      expect(decoded).toHaveLength(1)
      const offer = decoded[0] as OfferMsg
      expect(offer.type).toBe("offer")
      expect(offer.docId).toBe("doc-large")
      expect(offer.version).toBe("42")
    }

    reassembler.dispose()
  })

  it("batch: encode → fragment → reassemble → decode", () => {
    const msgs: ChannelMsg[] = [
      {
        type: "present",
        docs: [
          {
            docId: "a",
            schemaHash: "00test",
            replicaType: ["plain", 1, 0] as const,
            mergeStrategy: "authoritative" as const,
          },
          {
            docId: "b",
            schemaHash: "00test",
            replicaType: ["yjs", 1, 0] as const,
            mergeStrategy: "collaborative" as const,
          },
          {
            docId: "c",
            schemaHash: "00test",
            replicaType: ["loro", 1, 0] as const,
            mergeStrategy: "ephemeral" as const,
          },
        ],
      },
      {
        type: "offer",
        docId: "d",
        payload: {
          kind: "since",
          encoding: "binary",
          data: new Uint8Array([10, 20, 30]),
        },
        version: "1",
        reciprocate: true,
      },
    ]

    const payload = JSON.stringify(textCodec.encode(msgs))
    const fragments = fragmentTextPayload(payload, 30)
    expect(fragments.length).toBeGreaterThan(1)

    const reassembler = new TextReassembler({ timeoutMs: 5000 })
    const firstFrag = fragments.at(0)
    if (!firstFrag) throw new Error("Expected at least one fragment")
    let result = reassembler.receive(firstFrag)

    for (let i = 1; i < fragments.length; i++) {
      const frag = fragments.at(i)
      if (!frag) throw new Error(`Missing fragment at index ${i}`)
      result = reassembler.receive(frag)
    }

    expect(result.status).toBe("complete")
    if (result.status === "complete") {
      const decoded = textCodec.decode(JSON.parse(result.frame.content.payload))
      expect(decoded).toHaveLength(2)
      expect(decoded[0]?.type).toBe("present")
      const offer = decoded[1] as OfferMsg
      expect(offer.payload.data).toEqual(new Uint8Array([10, 20, 30]))
    }

    reassembler.dispose()
  })

  it("out-of-order fragment delivery reassembles correctly", () => {
    const payload = "ABCDEFGHIJKLMNOPQRSTUVWXYZ" // 26 chars
    const fragments = fragmentTextPayload(payload, 5) // 6 fragments
    expect(fragments.length).toBe(6)

    // Shuffle: deliver in reverse order
    const shuffled = [...fragments].reverse()

    const reassembler = new TextReassembler({ timeoutMs: 5000 })
    const firstShuffled = shuffled.at(0)
    if (!firstShuffled)
      throw new Error("Expected at least one shuffled fragment")
    let finalResult = reassembler.receive(firstShuffled)

    for (let i = 1; i < shuffled.length; i++) {
      const frag = shuffled.at(i)
      if (!frag) throw new Error(`Missing shuffled fragment at index ${i}`)
      const result = reassembler.receive(frag)
      if (result.status === "complete") {
        finalResult = result
      }
    }

    expect(finalResult.status).toBe("complete")
    if (finalResult.status === "complete") {
      expect(finalResult.frame.content.payload).toBe(payload)
    }

    reassembler.dispose()
  })

  it("complete frames pass through reassembler without collection", () => {
    const msg: PresentMsg = {
      type: "present",
      docs: [
        {
          docId: "x",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "authoritative" as const,
        },
      ],
    }
    const wire = encodeTextComplete(textCodec, msg)

    const reassembler = new TextReassembler({ timeoutMs: 5000 })
    const result = reassembler.receive(wire)

    expect(result.status).toBe("complete")
    if (result.status === "complete") {
      expect(isComplete(result.frame)).toBe(true)
      const decoded = textCodec.decode(JSON.parse(result.frame.content.payload))
      expect(decoded).toHaveLength(1)
      expect(decoded[0]).toEqual(msg)
    }

    reassembler.dispose()
  })

  it("interleaved fragment streams from two sources", () => {
    const payload1 = "AAAAABBBBBCCCCC" // 15 chars
    const payload2 = "1111122222" // 10 chars

    const frags1 = fragmentTextPayload(payload1, 5) // 3 fragments
    const frags2 = fragmentTextPayload(payload2, 5) // 2 fragments

    const reassembler = new TextReassembler({ timeoutMs: 5000 })

    // Interleave: f1[0], f2[0], f1[1], f2[1], f1[2]
    const f1_0 = frags1.at(0)
    if (!f1_0) throw new Error("Missing frags1[0]")
    const f2_0 = frags2.at(0)
    if (!f2_0) throw new Error("Missing frags2[0]")
    const f1_1 = frags1.at(1)
    if (!f1_1) throw new Error("Missing frags1[1]")
    const f2_1 = frags2.at(1)
    if (!f2_1) throw new Error("Missing frags2[1]")
    const f1_2 = frags1.at(2)
    if (!f1_2) throw new Error("Missing frags1[2]")

    reassembler.receive(f1_0)
    reassembler.receive(f2_0)
    reassembler.receive(f1_1)

    const r2 = reassembler.receive(f2_1)
    expect(r2.status).toBe("complete")
    if (r2.status === "complete") {
      expect(r2.frame.content.payload).toBe(payload2)
    }

    const r1 = reassembler.receive(f1_2)
    expect(r1.status).toBe("complete")
    if (r1.status === "complete") {
      expect(r1.frame.content.payload).toBe(payload1)
    }

    reassembler.dispose()
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
    expect(() => decodeTextFrame('["0c"]')).toThrow(TextFrameDecodeError)
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
    expect(() => decodeTextFrame('["0z", 123]')).toThrow(TextFrameDecodeError)
    expect(() => decodeTextFrame('["0z", 123]')).toThrow("Unknown type")
  })

  it("throws on unsupported version", () => {
    expect(() => decodeTextFrame('["9c", 123]')).toThrow(TextFrameDecodeError)
    expect(() => decodeTextFrame('["9c", 123]')).toThrow(
      "Unsupported text wire version",
    )
  })

  it("throws on truncated complete frame with hash", () => {
    // "0C" expects hash + payload = 3 elements total
    expect(() => decodeTextFrame('["0C", "hash"]')).toThrow(
      TextFrameDecodeError,
    )
    expect(() => decodeTextFrame('["0C", "hash"]')).toThrow("at least 3")
  })

  it("throws on truncated fragment frame", () => {
    // "0f" expects frameId, index, total, totalSize, chunk = 6 elements
    expect(() => decodeTextFrame('["0f", "id", 0, 3]')).toThrow(
      TextFrameDecodeError,
    )
    expect(() => decodeTextFrame('["0f", "id", 0, 3]')).toThrow("at least 6")
  })

  it("throws on truncated fragment frame with hash", () => {
    // "0F" expects hash, frameId, index, total, totalSize, chunk = 7 elements
    expect(() => decodeTextFrame('["0F", "hash", "id", 0, 3]')).toThrow(
      TextFrameDecodeError,
    )
    expect(() => decodeTextFrame('["0F", "hash", "id", 0, 3]')).toThrow(
      "at least 7",
    )
  })

  it("throws on non-string frameId in fragment", () => {
    expect(() => decodeTextFrame('["0f", 123, 0, 3, 100, "chunk"]')).toThrow(
      TextFrameDecodeError,
    )
    expect(() => decodeTextFrame('["0f", 123, 0, 3, 100, "chunk"]')).toThrow(
      "frameId must be a string",
    )
  })

  it("throws on non-number index in fragment", () => {
    expect(() =>
      decodeTextFrame('["0f", "id", "zero", 3, 100, "chunk"]'),
    ).toThrow(TextFrameDecodeError)
    expect(() =>
      decodeTextFrame('["0f", "id", "zero", 3, 100, "chunk"]'),
    ).toThrow("must be numbers")
  })

  it("throws on non-string chunk in fragment", () => {
    expect(() => decodeTextFrame('["0f", "id", 0, 3, 100, 42]')).toThrow(
      TextFrameDecodeError,
    )
    expect(() => decodeTextFrame('["0f", "id", 0, 3, 100, 42]')).toThrow(
      "chunk must be a string",
    )
  })
})
