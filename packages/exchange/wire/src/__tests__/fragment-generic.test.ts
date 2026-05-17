// fragment-generic tests — substrate-agnostic fragmentation.
//
// Verifies fragmentGeneric<T> with both binary (Uint8Array) and text
// (string) substrates, including round-trip reassembly via Reassembler<T>.

import { describe, expect, it } from "vitest"
import {
  createFrameIdCounter,
  FRAGMENT_TOTAL_MAX,
  fragmentGeneric,
  type SubstrateOps,
} from "../fragment-generic.js"
import { BINARY_CODEC } from "../frame.js"
import { Reassembler } from "../reassembler-generic.js"
import { TEXT_CODEC } from "../text-frame.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestPayload(size: number): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    data[i] = i % 256
  }
  return data
}

function createTestString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let result = ""
  for (let i = 0; i < length; i++) {
    result += chars[i % chars.length]
  }
  return result
}

// ---------------------------------------------------------------------------
// Parameterized substrate tests
// ---------------------------------------------------------------------------

interface SubstrateTestCase<T> {
  name: string
  codec: SubstrateOps<T>
  makePayload: (size: number) => T
  makeEmpty: () => T
  assertEqual: (a: T, b: T) => void
}

const binaryCase: SubstrateTestCase<Uint8Array<ArrayBuffer>> = {
  name: "binary",
  codec: BINARY_CODEC,
  makePayload: createTestPayload,
  makeEmpty: () => new Uint8Array(0),
  assertEqual: (a, b) => expect(a).toEqual(b),
}

const textCase: SubstrateTestCase<string> = {
  name: "text",
  codec: TEXT_CODEC,
  makePayload: createTestString,
  makeEmpty: () => "",
  assertEqual: (a, b) => expect(a).toBe(b),
}

function runSubstrateTests<T>(c: SubstrateTestCase<T>) {
  describe(`fragmentGeneric — ${c.name} substrate`, () => {
    it("fragments and reassembles with round-trip fidelity", () => {
      const payload = c.makePayload(200)
      const nextId = createFrameIdCounter()
      const result = fragmentGeneric(payload, 50, nextId(), c.codec)

      if (result.kind !== "fragments") {
        throw new Error(`Expected 'fragments', got '${result.kind}'`)
      }
      expect(result.pieces).toHaveLength(4)

      const reassembler = new Reassembler(c.codec)
      try {
        for (let i = 0; i < result.pieces.length; i++) {
          const piece = result.pieces[i]
          if (piece === undefined)
            throw new Error(`Missing piece at index ${i}`)
          const r = reassembler.receive(piece)

          if (i < result.pieces.length - 1) {
            expect(r.status).toBe("pending")
          } else {
            expect(r.status).toBe("complete")
            if (r.status !== "complete") throw new Error("Expected complete")
            if (r.frame.content.kind !== "complete")
              throw new Error("Expected complete content")
            c.assertEqual(r.frame.content.payload, payload)
          }
        }
      } finally {
        reassembler.dispose()
      }
    })

    it("empty payload returns empty-payload", () => {
      const nextId = createFrameIdCounter()
      const result = fragmentGeneric(c.makeEmpty(), 50, nextId(), c.codec)
      expect(result.kind).toBe("empty-payload")
    })

    it("too many fragments returns too-many-fragments", () => {
      const payload = c.makePayload(FRAGMENT_TOTAL_MAX + 1)
      const nextId = createFrameIdCounter()
      const result = fragmentGeneric(payload, 1, nextId(), c.codec)

      if (result.kind !== "too-many-fragments") {
        throw new Error(`Expected 'too-many-fragments', got '${result.kind}'`)
      }
      expect(result.total).toBe(FRAGMENT_TOTAL_MAX + 1)
      expect(result.max).toBe(FRAGMENT_TOTAL_MAX)
    })

    it("single chunk when payload fits within threshold", () => {
      const payload = c.makePayload(10)
      const nextId = createFrameIdCounter()
      const result = fragmentGeneric(payload, 100, nextId(), c.codec)

      if (result.kind !== "fragments") {
        throw new Error(`Expected 'fragments', got '${result.kind}'`)
      }
      expect(result.pieces).toHaveLength(1)
    })
  })
}

runSubstrateTests(binaryCase)
runSubstrateTests(textCase)
