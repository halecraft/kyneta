// Fragment and transport layer tests.
//
// Tests the transport-level fragmentation protocol:
// - fragmentPayload() splits payloads into self-describing fragment frames
// - parseTransportPayload() parses raw bytes to 2-variant TransportPayload
// - wrapCompleteMessage() / wrapFragment() prepend transport prefixes
// - shouldFragment() / calculateFragmentationOverhead() utilities
// - generateFrameId() / bytesToHex() / hexToBytes() helpers

import { describe, expect, it } from "vitest"
import {
  FRAGMENT,
  FRAGMENT_META_SIZE,
  FRAME_ID_SIZE,
  HEADER_SIZE,
  MESSAGE_COMPLETE,
} from "../constants.js"
import {
  bytesToHex,
  calculateFragmentationOverhead,
  FragmentParseError,
  fragmentPayload,
  generateFrameId,
  hexToBytes,
  parseTransportPayload,
  shouldFragment,
  type TransportPayload,
  wrapCompleteMessage,
  wrapFragment,
} from "../fragment.js"
import { decodeBinaryFrame } from "../frame.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a test payload of a given size with predictable content. */
function createTestPayload(size: number): Uint8Array {
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    data[i] = i % 256
  }
  return data
}

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

describe("bytesToHex / hexToBytes", () => {
  it("round-trips bytes through hex", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0xab, 0x12])
    const hex = bytesToHex(bytes)
    expect(hex).toBe("00ffab12")

    const back = hexToBytes(hex, 4)
    expect(back).toEqual(bytes)
  })

  it("pads short hex strings with zeros", () => {
    const bytes = hexToBytes("ab", 4)
    expect(bytes).toEqual(new Uint8Array([0xab, 0x00, 0x00, 0x00]))
  })

  it("truncates long hex strings", () => {
    const bytes = hexToBytes("aabbccddee", 2)
    expect(bytes).toEqual(new Uint8Array([0xaa, 0xbb]))
  })
})

describe("generateFrameId", () => {
  it("returns a hex string of correct length", () => {
    const id = generateFrameId()
    expect(typeof id).toBe("string")
    expect(id.length).toBe(FRAME_ID_SIZE * 2) // 16 hex chars for 8 bytes
  })

  it("generates unique IDs", () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(generateFrameId())
    }
    expect(ids.size).toBe(100)
  })

  it("contains only hex characters", () => {
    const id = generateFrameId()
    expect(id).toMatch(/^[0-9a-f]+$/)
  })
})

// ---------------------------------------------------------------------------
// wrapCompleteMessage / wrapFragment
// ---------------------------------------------------------------------------

describe("wrapCompleteMessage", () => {
  it("prepends MESSAGE_COMPLETE prefix byte", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    const wrapped = wrapCompleteMessage(data)

    expect(wrapped.length).toBe(1 + data.length)
    expect(wrapped[0]).toBe(MESSAGE_COMPLETE)
    expect(wrapped.slice(1)).toEqual(data)
  })

  it("handles empty payload", () => {
    const wrapped = wrapCompleteMessage(new Uint8Array(0))
    expect(wrapped.length).toBe(1)
    expect(wrapped[0]).toBe(MESSAGE_COMPLETE)
  })
})

describe("wrapFragment", () => {
  it("prepends FRAGMENT prefix byte", () => {
    const data = new Uint8Array([10, 20, 30])
    const wrapped = wrapFragment(data)

    expect(wrapped.length).toBe(1 + data.length)
    expect(wrapped[0]).toBe(FRAGMENT)
    expect(wrapped.slice(1)).toEqual(data)
  })
})

// ---------------------------------------------------------------------------
// parseTransportPayload — 2-variant protocol
// ---------------------------------------------------------------------------

describe("parseTransportPayload", () => {
  it("parses a complete payload (MESSAGE_COMPLETE prefix)", () => {
    const frameData = new Uint8Array(HEADER_SIZE + 10)
    const wrapped = wrapCompleteMessage(frameData)
    const payload = parseTransportPayload(wrapped)

    expect(payload.kind).toBe("complete")
    if (payload.kind === "complete") {
      expect(payload.data).toEqual(frameData)
    }
  })

  it("parses a fragment payload (FRAGMENT prefix)", () => {
    // Create a minimal valid fragment frame (header + metadata + 1 byte)
    const minSize = HEADER_SIZE + FRAGMENT_META_SIZE + 1
    const fragFrame = new Uint8Array(minSize)
    const wrapped = wrapFragment(fragFrame)
    const payload = parseTransportPayload(wrapped)

    expect(payload.kind).toBe("fragment")
    if (payload.kind === "fragment") {
      expect(payload.data).toEqual(fragFrame)
    }
  })

  it("throws on empty input", () => {
    expect(() => parseTransportPayload(new Uint8Array(0))).toThrow(
      FragmentParseError,
    )
  })

  it("throws on unknown prefix byte", () => {
    const data = new Uint8Array([0x99, 0x01, 0x02])
    expect(() => parseTransportPayload(data)).toThrow(FragmentParseError)
    expect(() => parseTransportPayload(data)).toThrow("Unknown")
  })

  it("throws on truncated complete payload", () => {
    // A complete payload needs at least 1 (prefix) + HEADER_SIZE bytes
    const tooShort = new Uint8Array([MESSAGE_COMPLETE, 0x00])
    expect(() => parseTransportPayload(tooShort)).toThrow(FragmentParseError)
    expect(() => parseTransportPayload(tooShort)).toThrow("too short")
  })

  it("throws on truncated fragment payload", () => {
    // A fragment payload needs at least 1 + FRAGMENT_MIN_SIZE bytes
    const tooShort = new Uint8Array([FRAGMENT, 0x00, 0x01, 0x02])
    expect(() => parseTransportPayload(tooShort)).toThrow(FragmentParseError)
    expect(() => parseTransportPayload(tooShort)).toThrow("too short")
  })

  it("only has two valid prefix types", () => {
    // 0x00 and 0x01 are valid; 0x02 (old FRAGMENT_DATA) should now be invalid
    const oldFragData = new Uint8Array([0x02, 0x00, 0x01, 0x02, 0x03])
    expect(() => parseTransportPayload(oldFragData)).toThrow(FragmentParseError)
    expect(() => parseTransportPayload(oldFragData)).toThrow("Unknown")
  })
})

// ---------------------------------------------------------------------------
// fragmentPayload — self-describing fragments
// ---------------------------------------------------------------------------

describe("fragmentPayload", () => {
  it("splits payload into correct number of fragments", () => {
    const data = createTestPayload(100)
    const fragments = fragmentPayload(data, 30)

    // 100 bytes / 30 per chunk = ceil(100/30) = 4 fragments
    expect(fragments.length).toBe(4)
  })

  it("each fragment has FRAGMENT transport prefix", () => {
    const data = createTestPayload(100)
    const fragments = fragmentPayload(data, 50)

    for (const frag of fragments) {
      expect(frag[0]).toBe(FRAGMENT)
    }
  })

  it("each fragment decodes as a valid fragment frame", () => {
    const data = createTestPayload(100)
    const fragments = fragmentPayload(data, 30)

    for (let i = 0; i < fragments.length; i++) {
      // Strip transport prefix
      const frameData = fragments[i]!.slice(1)
      const frame = decodeBinaryFrame(frameData)

      expect(frame.content.kind).toBe("fragment")
      if (frame.content.kind === "fragment") {
        expect(frame.content.index).toBe(i)
        expect(frame.content.total).toBe(fragments.length)
        expect(frame.content.totalSize).toBe(data.length)
      }
    }
  })

  it("all fragments share the same frameId", () => {
    const data = createTestPayload(200)
    const fragments = fragmentPayload(data, 50)

    const frameIds = new Set<string>()
    for (const frag of fragments) {
      const frameData = frag.slice(1)
      const frame = decodeBinaryFrame(frameData)
      if (frame.content.kind === "fragment") {
        frameIds.add(frame.content.frameId)
      }
    }

    expect(frameIds.size).toBe(1)
  })

  it("concatenated chunks reconstruct the original payload", () => {
    const data = createTestPayload(150)
    const fragments = fragmentPayload(data, 40)

    const chunks: Uint8Array[] = []
    for (const frag of fragments) {
      const frameData = frag.slice(1)
      const frame = decodeBinaryFrame(frameData)
      if (frame.content.kind === "fragment") {
        chunks.push(frame.content.payload)
      }
    }

    // Concatenate chunks in order
    let totalLen = 0
    for (const c of chunks) totalLen += c.length
    const reassembled = new Uint8Array(totalLen)
    let offset = 0
    for (const c of chunks) {
      reassembled.set(c, offset)
      offset += c.length
    }

    expect(reassembled).toEqual(data)
  })

  it("handles single-chunk fragmentation", () => {
    const data = createTestPayload(10)
    const fragments = fragmentPayload(data, 100) // chunk size > data size

    expect(fragments.length).toBe(1)

    const frameData = fragments[0]!.slice(1)
    const frame = decodeBinaryFrame(frameData)
    if (frame.content.kind === "fragment") {
      expect(frame.content.index).toBe(0)
      expect(frame.content.total).toBe(1)
      expect(frame.content.totalSize).toBe(10)
      expect(frame.content.payload).toEqual(data)
    }
  })

  it("handles exact chunk boundary", () => {
    const data = createTestPayload(100)
    const fragments = fragmentPayload(data, 50) // exactly 2 chunks

    expect(fragments.length).toBe(2)

    const chunks: Uint8Array[] = []
    for (const frag of fragments) {
      const frameData = frag.slice(1)
      const frame = decodeBinaryFrame(frameData)
      if (frame.content.kind === "fragment") {
        chunks.push(frame.content.payload)
      }
    }

    expect(chunks[0]!.length).toBe(50)
    expect(chunks[1]!.length).toBe(50)
  })

  it("throws on zero maxChunkSize", () => {
    expect(() => fragmentPayload(createTestPayload(10), 0)).toThrow(
      "maxChunkSize must be positive",
    )
  })

  it("throws on negative maxChunkSize", () => {
    expect(() => fragmentPayload(createTestPayload(10), -1)).toThrow(
      "maxChunkSize must be positive",
    )
  })

  it("different calls produce different frameIds", () => {
    const data = createTestPayload(50)
    const frags1 = fragmentPayload(data, 20)
    const frags2 = fragmentPayload(data, 20)

    const getFrameId = (frag: Uint8Array) => {
      const frame = decodeBinaryFrame(frag.slice(1))
      return frame.content.kind === "fragment" ? frame.content.frameId : ""
    }

    expect(getFrameId(frags1[0]!)).not.toBe(getFrameId(frags2[0]!))
  })
})

// ---------------------------------------------------------------------------
// shouldFragment
// ---------------------------------------------------------------------------

describe("shouldFragment", () => {
  it("returns true when payload exceeds threshold", () => {
    expect(shouldFragment(101, 100)).toBe(true)
  })

  it("returns false when payload equals threshold", () => {
    expect(shouldFragment(100, 100)).toBe(false)
  })

  it("returns false when payload is under threshold", () => {
    expect(shouldFragment(50, 100)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// calculateFragmentationOverhead
// ---------------------------------------------------------------------------

describe("calculateFragmentationOverhead", () => {
  it("calculates per-fragment overhead correctly", () => {
    // Each fragment: 1 (transport prefix) + 7 (header) + 20 (metadata) = 28 bytes
    const perFragment = 1 + HEADER_SIZE + FRAGMENT_META_SIZE
    expect(perFragment).toBe(28)

    // 100 bytes with 50-byte chunks = 2 fragments
    const overhead = calculateFragmentationOverhead(100, 50)
    expect(overhead).toBe(2 * perFragment)
  })

  it("handles single fragment", () => {
    const perFragment = 1 + HEADER_SIZE + FRAGMENT_META_SIZE
    const overhead = calculateFragmentationOverhead(10, 100)
    expect(overhead).toBe(1 * perFragment)
  })

  it("handles non-even division", () => {
    const perFragment = 1 + HEADER_SIZE + FRAGMENT_META_SIZE
    // 101 bytes with 50-byte chunks = ceil(101/50) = 3 fragments
    const overhead = calculateFragmentationOverhead(101, 50)
    expect(overhead).toBe(3 * perFragment)
  })
})
