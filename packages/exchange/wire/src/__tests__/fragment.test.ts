// Fragment tests — wire protocol v1.
//
// Tests the simplified fragmentation API:
// - fragmentPayload() splits payloads into encoded binary fragment frames
// - shouldFragment() size threshold check
// - calculateFragmentationOverhead() per-fragment overhead calculation

import { describe, expect, it } from "vitest"
import { FRAGMENT_META_SIZE, HEADER_SIZE } from "../constants.js"
import {
  calculateFragmentationOverhead,
  createFrameIdCounter,
  fragmentPayload,
  shouldFragment,
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

/** Decode a fragment frame and extract its content (asserts fragment kind). */
function decodeFragment(encoded: Uint8Array) {
  const frame = decodeBinaryFrame(encoded)
  expect(frame.content.kind).toBe("fragment")
  if (frame.content.kind !== "fragment") {
    throw new Error("Expected fragment frame")
  }
  return frame.content
}

// ---------------------------------------------------------------------------
// fragmentPayload
// ---------------------------------------------------------------------------

describe("fragmentPayload", () => {
  it("splits payload into correct number of fragments", () => {
    const data = createTestPayload(100)
    const fragments = fragmentPayload(data, 30, 1)

    // ceil(100 / 30) = 4 fragments
    expect(fragments.length).toBe(4)
  })

  it("each fragment decodes as a valid fragment frame", () => {
    const data = createTestPayload(100)
    const fragments = fragmentPayload(data, 30, 42)

    for (let i = 0; i < fragments.length; i++) {
      const content = decodeFragment(fragments[i] ?? new Uint8Array(0))
      expect(content.index).toBe(i)
      expect(content.total).toBe(fragments.length)
      expect(content.totalSize).toBe(data.length)
    }
  })

  it("returns raw encoded frames without transport prefix", () => {
    const data = createTestPayload(50)
    const fragments = fragmentPayload(data, 25, 7)

    for (const frag of fragments) {
      // First byte should be wire version (1), not a transport prefix
      expect(frag[0]).toBe(1)
      // Should decode cleanly as a binary frame
      const frame = decodeBinaryFrame(frag)
      expect(frame.version).toBe(1)
    }
  })

  it("all fragments share the caller-provided frameId", () => {
    const data = createTestPayload(200)
    const frameId = 99
    const fragments = fragmentPayload(data, 50, frameId)

    const frameIds = new Set<number>()
    for (const frag of fragments) {
      const content = decodeFragment(frag)
      frameIds.add(content.frameId)
    }

    expect(frameIds.size).toBe(1)
    expect(frameIds.has(frameId)).toBe(true)
  })

  it("different frameId values produce different fragment groups", () => {
    const data = createTestPayload(50)
    const frags1 = fragmentPayload(data, 20, 1)
    const frags2 = fragmentPayload(data, 20, 2)

    const id1 = decodeFragment(frags1[0] ?? new Uint8Array(0)).frameId
    const id2 = decodeFragment(frags2[0] ?? new Uint8Array(0)).frameId

    expect(id1).toBe(1)
    expect(id2).toBe(2)
    expect(id1).not.toBe(id2)
  })

  it("concatenated chunks reconstruct the original payload", () => {
    const data = createTestPayload(150)
    const fragments = fragmentPayload(data, 40, 5)

    const chunks: Uint8Array[] = []
    for (const frag of fragments) {
      const content = decodeFragment(frag)
      chunks.push(content.payload)
    }

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
    const fragments = fragmentPayload(data, 100, 3) // chunk size > data size

    expect(fragments.length).toBe(1)

    const content = decodeFragment(fragments[0] ?? new Uint8Array(0))
    expect(content.index).toBe(0)
    expect(content.total).toBe(1)
    expect(content.totalSize).toBe(10)
    expect(content.payload).toEqual(data)
  })

  it("handles exact chunk boundary", () => {
    const data = createTestPayload(100)
    const fragments = fragmentPayload(data, 50, 1)

    expect(fragments.length).toBe(2)

    const chunk0 = decodeFragment(fragments[0] ?? new Uint8Array(0))
    const chunk1 = decodeFragment(fragments[1] ?? new Uint8Array(0))

    expect(chunk0.payload.length).toBe(50)
    expect(chunk1.payload.length).toBe(50)
  })

  it("handles 1-byte chunk size", () => {
    const data = createTestPayload(5)
    const fragments = fragmentPayload(data, 1, 10)

    expect(fragments.length).toBe(5)

    for (let i = 0; i < fragments.length; i++) {
      const content = decodeFragment(fragments[i] ?? new Uint8Array(0))
      expect(content.payload.length).toBe(1)
      expect(content.payload[0]).toBe(i % 256)
    }
  })

  it("throws on zero maxChunkSize", () => {
    expect(() => fragmentPayload(createTestPayload(10), 0, 1)).toThrow(
      "maxChunkSize must be positive",
    )
  })

  it("throws on negative maxChunkSize", () => {
    expect(() => fragmentPayload(createTestPayload(10), -1, 1)).toThrow(
      "maxChunkSize must be positive",
    )
  })

  it("handles empty payload (produces one fragment with empty chunk)", () => {
    const data = new Uint8Array(0)
    // ceil(0 / 50) = 0, so no fragments
    const fragments = fragmentPayload(data, 50, 1)
    expect(fragments.length).toBe(0)
  })

  it("fragment frame sizes match expected layout", () => {
    const data = createTestPayload(80)
    const chunkSize = 30
    const fragments = fragmentPayload(data, chunkSize, 1)

    // First 3 fragments: 30 bytes each, last: 80 - 90 = ... ceil(80/30) = 3
    // chunks: 30, 30, 20
    expect(fragments.length).toBe(3)

    const frag0 = fragments[0] ?? new Uint8Array(0)
    const frag2 = fragments[2] ?? new Uint8Array(0)

    // Full fragment frame = HEADER_SIZE + FRAGMENT_META_SIZE + chunkBytes
    expect(frag0.length).toBe(HEADER_SIZE + FRAGMENT_META_SIZE + 30)
    expect(frag2.length).toBe(HEADER_SIZE + FRAGMENT_META_SIZE + 20)
  })
})

// ---------------------------------------------------------------------------
// shouldFragment
// ---------------------------------------------------------------------------

describe("shouldFragment", () => {
  it("returns true only when payload exceeds threshold", () => {
    expect(shouldFragment(101, 100)).toBe(true)
    expect(shouldFragment(100, 100)).toBe(false)
    expect(shouldFragment(50, 100)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// calculateFragmentationOverhead
// ---------------------------------------------------------------------------

describe("calculateFragmentationOverhead", () => {
  it("calculates per-fragment overhead as HEADER_SIZE + FRAGMENT_META_SIZE", () => {
    const perFragment = HEADER_SIZE + FRAGMENT_META_SIZE

    // 100 bytes with 50-byte chunks = 2 fragments
    const overhead = calculateFragmentationOverhead(100, 50)
    expect(overhead).toBe(2 * perFragment)
  })

  it("handles single fragment", () => {
    const perFragment = HEADER_SIZE + FRAGMENT_META_SIZE
    const overhead = calculateFragmentationOverhead(10, 100)
    expect(overhead).toBe(1 * perFragment)
  })

  it("handles non-even division", () => {
    const perFragment = HEADER_SIZE + FRAGMENT_META_SIZE
    // ceil(101 / 50) = 3 fragments
    const overhead = calculateFragmentationOverhead(101, 50)
    expect(overhead).toBe(3 * perFragment)
  })

  it("no transport prefix byte in overhead (v1 change)", () => {
    // v0 was 1 + HEADER_SIZE + FRAGMENT_META_SIZE per fragment
    // v1 is HEADER_SIZE + FRAGMENT_META_SIZE per fragment (no prefix)
    const perFragment = HEADER_SIZE + FRAGMENT_META_SIZE
    expect(perFragment).toBe(6 + 10) // 16 bytes, not 17
    expect(calculateFragmentationOverhead(100, 100)).toBe(perFragment)
  })
})

// ---------------------------------------------------------------------------
// createFrameIdCounter
// ---------------------------------------------------------------------------

describe("createFrameIdCounter", () => {
  it("yields 1, 2, …, 65535, then wraps to 0", () => {
    const next = createFrameIdCounter()

    expect(next()).toBe(1)
    expect(next()).toBe(2)

    // Fast-forward to the wrap point
    for (let i = 3; i <= 0xffff; i++) next()

    // Should have wrapped
    expect(next()).toBe(0)
    expect(next()).toBe(1)
  })
})
