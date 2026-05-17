// reassembler-generic tests — substrate-agnostic fragment reassembler.
//
// Verifies Reassembler<T> with binary substrate: complete pass-through,
// in-order and out-of-order fragment reassembly, dispose, and reset.

import { describe, expect, it } from "vitest"
import { WIRE_VERSION } from "../constants.js"
import { createFrameIdCounter, fragmentGeneric } from "../fragment-generic.js"
import { BINARY_CODEC } from "../frame.js"
import { complete } from "../frame-types.js"
import { Reassembler } from "../reassembler-generic.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a test payload of a given size with predictable content. */
function createTestPayload(size: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    data[i] = i % 256
  }
  return data
}

/**
 * Fragment a payload and return the pieces, throwing if the result is
 * not the expected `"fragments"` kind.
 */
function fragmentOrThrow(
  payload: Uint8Array<ArrayBuffer>,
  threshold: number,
  frameId: number,
): readonly Uint8Array<ArrayBuffer>[] {
  const result = fragmentGeneric(payload, threshold, frameId, BINARY_CODEC)
  if (result.kind !== "fragments") {
    throw new Error(`Expected 'fragments', got '${result.kind}'`)
  }
  return result.pieces
}

// ---------------------------------------------------------------------------
// Complete frame pass-through
// ---------------------------------------------------------------------------

describe("Reassembler — complete frame pass-through", () => {
  it("returns the frame immediately for a complete message", () => {
    const payload = createTestPayload(42)
    const frame = complete(WIRE_VERSION, payload)
    const encoded = BINARY_CODEC.encodeFrame(frame)

    const reassembler = new Reassembler(BINARY_CODEC)
    try {
      const result = reassembler.receive(encoded)

      expect(result.status).toBe("complete")
      if (result.status !== "complete") {
        throw new Error("Expected complete result")
      }
      expect(result.frame.content.kind).toBe("complete")
      if (result.frame.content.kind !== "complete") {
        throw new Error("Expected complete content kind")
      }
      expect(result.frame.content.payload).toEqual(payload)
      expect(result.frame.version).toBe(WIRE_VERSION)
    } finally {
      reassembler.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// In-order fragment reassembly
// ---------------------------------------------------------------------------

describe("Reassembler — in-order fragment reassembly", () => {
  it("collects fragments in order and returns complete on the last one", () => {
    const payload = createTestPayload(150)
    const nextId = createFrameIdCounter()
    const pieces = fragmentOrThrow(payload, 50, nextId())

    // ceil(150 / 50) = 3 fragments
    expect(pieces).toHaveLength(3)

    const reassembler = new Reassembler(BINARY_CODEC)
    try {
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i]
        if (piece === undefined) {
          throw new Error(`Missing piece at index ${i}`)
        }
        const result = reassembler.receive(piece)

        if (i < pieces.length - 1) {
          expect(result.status).toBe("pending")
        } else {
          expect(result.status).toBe("complete")
          if (result.status !== "complete") {
            throw new Error("Expected complete result on last fragment")
          }
          expect(result.frame.content.kind).toBe("complete")
          if (result.frame.content.kind !== "complete") {
            throw new Error("Expected complete content kind")
          }
          expect(result.frame.content.payload).toEqual(payload)
        }
      }
    } finally {
      reassembler.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Out-of-order fragment reassembly
// ---------------------------------------------------------------------------

describe("Reassembler — out-of-order fragments", () => {
  it("reassembles fragments delivered as [2, 0, 1]", () => {
    const payload = createTestPayload(150)
    const nextId = createFrameIdCounter()
    const pieces = fragmentOrThrow(payload, 50, nextId())

    // ceil(150 / 50) = 3 fragments
    expect(pieces).toHaveLength(3)

    const piece0 = pieces[0]
    const piece1 = pieces[1]
    const piece2 = pieces[2]
    if (piece0 === undefined || piece1 === undefined || piece2 === undefined) {
      throw new Error("Expected 3 pieces")
    }

    // Deliver in order [2, 0, 1]
    const shuffled = [piece2, piece0, piece1]

    const reassembler = new Reassembler(BINARY_CODEC)
    try {
      let finalResult: ReturnType<typeof reassembler.receive> | undefined

      for (let i = 0; i < shuffled.length; i++) {
        const piece = shuffled[i]
        if (piece === undefined) {
          throw new Error(`Missing shuffled piece at index ${i}`)
        }
        const result = reassembler.receive(piece)

        if (result.status === "complete") {
          finalResult = result
        } else {
          expect(result.status).toBe("pending")
        }
      }

      if (finalResult === undefined) {
        throw new Error("Expected a complete result after all fragments")
      }
      expect(finalResult.status).toBe("complete")
      if (finalResult.status !== "complete") {
        throw new Error("Expected complete result")
      }
      expect(finalResult.frame.content.kind).toBe("complete")
      if (finalResult.frame.content.kind !== "complete") {
        throw new Error("Expected complete content kind")
      }
      expect(finalResult.frame.content.payload).toEqual(payload)
    } finally {
      reassembler.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Interleaved fragment reassembly
// ---------------------------------------------------------------------------

describe("Reassembler — interleaved fragments", () => {
  it("reassembles interleaved fragments from two concurrent messages", () => {
    const payload1 = createTestPayload(150) // 3 fragments at threshold 50
    const payload2 = createTestPayload(100) // 2 fragments at threshold 50

    const counter = createFrameIdCounter()
    const id1 = counter() // 1
    const id2 = counter() // 2

    const frags1 = fragmentOrThrow(payload1, 50, id1)
    const frags2 = fragmentOrThrow(payload2, 50, id2)

    expect(frags1).toHaveLength(3)
    expect(frags2).toHaveLength(2)

    const f1_0 = frags1[0]
    const f1_1 = frags1[1]
    const f1_2 = frags1[2]
    const f2_0 = frags2[0]
    const f2_1 = frags2[1]
    if (
      f1_0 === undefined ||
      f1_1 === undefined ||
      f1_2 === undefined ||
      f2_0 === undefined ||
      f2_1 === undefined
    ) {
      throw new Error("Expected all fragment pieces to be defined")
    }

    const reassembler = new Reassembler(BINARY_CODEC)
    try {
      // Interleave: msg1[0], msg2[0], msg1[1], msg2[1], msg1[2]
      expect(reassembler.receive(f1_0).status).toBe("pending")
      expect(reassembler.pendingFrameCount).toBe(1)

      expect(reassembler.receive(f2_0).status).toBe("pending")
      expect(reassembler.pendingFrameCount).toBe(2)

      expect(reassembler.receive(f1_1).status).toBe("pending")
      expect(reassembler.pendingFrameCount).toBe(2)

      // msg2 completes (2 of 2 fragments received)
      const result2 = reassembler.receive(f2_1)
      expect(result2.status).toBe("complete")
      expect(reassembler.pendingFrameCount).toBe(1)

      // msg1 completes (3 of 3 fragments received)
      const result1 = reassembler.receive(f1_2)
      expect(result1.status).toBe("complete")
      expect(reassembler.pendingFrameCount).toBe(0)

      // Verify reassembled payloads match the originals
      if (result2.status !== "complete") {
        throw new Error("Expected complete result for msg2")
      }
      if (result1.status !== "complete") {
        throw new Error("Expected complete result for msg1")
      }

      expect(result1.frame.content.kind).toBe("complete")
      expect(result2.frame.content.kind).toBe("complete")

      if (result1.frame.content.kind !== "complete") {
        throw new Error("Expected complete content kind for msg1")
      }
      if (result2.frame.content.kind !== "complete") {
        throw new Error("Expected complete content kind for msg2")
      }

      expect(result1.frame.content.payload).toEqual(payload1)
      expect(result2.frame.content.payload).toEqual(payload2)
    } finally {
      reassembler.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

describe("Reassembler — dispose", () => {
  it("is idempotent and returns error after disposal", () => {
    const reassembler = new Reassembler(BINARY_CODEC)

    // First dispose — no error
    reassembler.dispose()

    // Second dispose — still no error
    reassembler.dispose()

    // After dispose, receive returns error
    const payload = createTestPayload(10)
    const frame = complete(WIRE_VERSION, payload)
    const encoded = BINARY_CODEC.encodeFrame(frame)

    const result = reassembler.receive(encoded)
    expect(result.status).toBe("error")
    if (result.status !== "error") {
      throw new Error("Expected error after dispose")
    }
    expect(result.error.type).toBe("parse_error")
  })
})

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("Reassembler — reset", () => {
  it("clears pending state so fragments restart from scratch", () => {
    const payload = createTestPayload(150)
    const nextId = createFrameIdCounter()
    const pieces = fragmentOrThrow(payload, 50, nextId())

    expect(pieces).toHaveLength(3)

    const reassembler = new Reassembler(BINARY_CODEC)
    try {
      // Feed first piece — should be pending
      const firstPiece = pieces[0]
      if (firstPiece === undefined) {
        throw new Error("Missing first piece")
      }
      const r1 = reassembler.receive(firstPiece)
      expect(r1.status).toBe("pending")
      expect(reassembler.pendingFrameCount).toBe(1)

      // Reset clears state
      reassembler.reset()
      expect(reassembler.pendingFrameCount).toBe(0)

      // Feed first piece again — should restart (pending again, not error)
      const r2 = reassembler.receive(firstPiece)
      expect(r2.status).toBe("pending")
      expect(reassembler.pendingFrameCount).toBe(1)
    } finally {
      reassembler.dispose()
    }
  })
})
