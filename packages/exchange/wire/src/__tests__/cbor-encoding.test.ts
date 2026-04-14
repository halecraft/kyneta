import { describe, expect, it } from "vitest"
import { type CBORType, decodeCBOR, encodeCBOR } from "../cbor-encoding.js"

function roundTrip(value: CBORType): CBORType {
  return decodeCBOR(encodeCBOR(value))
}

describe("cbor-encoding", () => {
  // -------------------------------------------------------------------------
  // Strings — the critical UTF-8 fix
  // -------------------------------------------------------------------------

  describe("strings", () => {
    it("round-trips ASCII", () => {
      expect(roundTrip("hello")).toBe("hello")
    })

    it("round-trips 2-byte UTF-8 (Latin extended)", () => {
      expect(roundTrip("café")).toBe("café")
    })

    it("round-trips 3-byte UTF-8 (CJK)", () => {
      expect(roundTrip("你好世界")).toBe("你好世界")
    })

    it("round-trips 4-byte UTF-8 (emoji / surrogate pairs)", () => {
      expect(roundTrip("🔥💧🪨💨🌀")).toBe("🔥💧🪨💨🌀")
    })

    it("round-trips mixed JSON string with emoji", () => {
      const s = '{"glyph":"🔥","name":"fire"}'
      expect(roundTrip(s)).toBe(s)
    })

    it("round-trips empty string", () => {
      expect(roundTrip("")).toBe("")
    })
  })

  // -------------------------------------------------------------------------
  // Integers
  // -------------------------------------------------------------------------

  describe("integers", () => {
    it("encodes small unsigned (0–23, single byte)", () => {
      for (const n of [0, 1, 10, 23]) {
        expect(roundTrip(n)).toBe(n)
      }
    })

    it("encodes 1-byte unsigned (24–255)", () => {
      for (const n of [24, 100, 255]) {
        expect(roundTrip(n)).toBe(n)
      }
    })

    it("encodes 2-byte unsigned (256–65535)", () => {
      for (const n of [256, 1000, 65535]) {
        expect(roundTrip(n)).toBe(n)
      }
    })

    it("encodes 4-byte unsigned (65536+)", () => {
      for (const n of [65536, 1_000_000]) {
        expect(roundTrip(n)).toBe(n)
      }
    })

    it("encodes negative integers", () => {
      for (const n of [-1, -24, -100, -1000]) {
        expect(roundTrip(n)).toBe(n)
      }
    })

    it("encodes boundary values correctly", () => {
      for (const n of [23, 24, 255, 256, 65535, 65536]) {
        expect(roundTrip(n)).toBe(n)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Booleans, null, undefined
  // -------------------------------------------------------------------------

  describe("booleans, null, undefined", () => {
    it("round-trips true, false, null, undefined", () => {
      expect(roundTrip(true)).toBe(true)
      expect(roundTrip(false)).toBe(false)
      expect(roundTrip(null)).toBe(null)
      expect(roundTrip(undefined)).toBe(undefined)
    })
  })

  // -------------------------------------------------------------------------
  // Uint8Array (byte strings)
  // -------------------------------------------------------------------------

  describe("byte strings", () => {
    it("round-trips binary data", () => {
      const bytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x42])
      const result = roundTrip(bytes)
      expect(result).toBeInstanceOf(Uint8Array)
      expect(result).toEqual(bytes)
    })

    it("round-trips empty byte string", () => {
      const empty = new Uint8Array(0)
      const result = roundTrip(empty)
      expect(result).toBeInstanceOf(Uint8Array)
      expect((result as Uint8Array).byteLength).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Nested maps and arrays
  // -------------------------------------------------------------------------

  describe("maps and arrays", () => {
    it("round-trips map with string keys", () => {
      const map = new Map<string, CBORType>([
        ["a", 1],
        ["b", "two"],
        ["c", true],
      ])
      expect(roundTrip(map)).toEqual(map)
    })

    it("round-trips map with numeric keys", () => {
      const map = new Map<number, CBORType>([
        [1, "one"],
        [2, "two"],
      ])
      expect(roundTrip(map)).toEqual(map)
    })

    it("round-trips nested map inside map", () => {
      const inner = new Map<string, CBORType>([["x", 42]])
      const outer = new Map<string, CBORType>([
        ["nested", inner],
        ["flat", "value"],
      ])
      expect(roundTrip(outer)).toEqual(outer)
    })

    it("round-trips array of mixed types", () => {
      const arr: CBORType[] = [1, "hello", true, null, new Uint8Array([0xab])]
      expect(roundTrip(arr)).toEqual(arr)
    })

    it("round-trips empty map and empty array", () => {
      expect(roundTrip(new Map())).toEqual(new Map())
      expect(roundTrip([])).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // Floats
  // -------------------------------------------------------------------------

  describe("floats", () => {
    it("round-trips float32-representable values", () => {
      expect(roundTrip(1.5)).toBe(1.5)
      expect(roundTrip(-0.5)).toBe(-0.5)
    })

    it("round-trips float64 values", () => {
      expect(roundTrip(1.1)).toBe(1.1)
      expect(roundTrip(Math.PI)).toBe(Math.PI)
    })

    it("round-trips Infinity and -Infinity", () => {
      expect(roundTrip(Infinity)).toBe(Infinity)
      expect(roundTrip(-Infinity)).toBe(-Infinity)
    })

    it("round-trips NaN", () => {
      expect(roundTrip(NaN)).toBeNaN()
    })
  })

  // -------------------------------------------------------------------------
  // Bigint
  // -------------------------------------------------------------------------

  describe("bigint", () => {
    it("small bigints decode as number (CBOR has no bigint/number distinction)", () => {
      expect(roundTrip(0n)).toBe(0)
      expect(roundTrip(100n)).toBe(100)
    })

    it("bigints beyond MAX_SAFE_INTEGER survive as bigint", () => {
      expect(roundTrip(2n ** 53n)).toBe(2n ** 53n)
    })

    it("negative bigints within safe range decode as number", () => {
      expect(roundTrip(-1n)).toBe(-1)
      expect(roundTrip(-100n)).toBe(-100)
    })
  })

  // -------------------------------------------------------------------------
  // byteOffset-correct decoding (the second bug fix)
  // -------------------------------------------------------------------------

  describe("byteOffset-correct decoding", () => {
    it("decodes from a Uint8Array view with non-zero byteOffset into a shared ArrayBuffer", () => {
      // Encode a map with a string — exercises both string decoding and byte string slicing
      const payload = new Map<string, CBORType>([["key", "café🔥"]])
      const encoded = encodeCBOR(payload)

      // Embed the encoded bytes at an offset within a larger ArrayBuffer,
      // simulating a Node.js pooled Buffer with non-zero byteOffset.
      const padding = 37 // arbitrary non-zero offset
      const shared = new ArrayBuffer(padding + encoded.byteLength + 16)
      const view = new Uint8Array(shared, padding, encoded.byteLength)
      view.set(encoded)

      // view.byteOffset is now 37, view.buffer is the larger shared ArrayBuffer.
      // The old tiny-cbor bug: `new DataView(data.buffer)` without offset would
      // read from position 0 of the shared ArrayBuffer (garbage), not position 37.
      const decoded = decodeCBOR(view)
      expect(decoded).toEqual(payload)
    })
  })

  // -------------------------------------------------------------------------
  // UTF-8 header byte-level verification (regression guard for the primary bug)
  // -------------------------------------------------------------------------

  describe("UTF-8 string header encodes byte length, not JS .length", () => {
    it("CBOR header for emoji string uses UTF-8 byte count, not UTF-16 code unit count", () => {
      // "🔥" is 1 JS char pair (2 UTF-16 code units, .length === 2)
      // but 4 UTF-8 bytes (f0 9f 94 a5).
      // CBOR text string header must say 4, not 2.
      const encoded = encodeCBOR("🔥")

      // CBOR text string: major type 3 (0x60) | length 4 = 0x64
      // Then 4 UTF-8 bytes: f0 9f 94 a5
      // Total: 5 bytes
      expect(encoded.byteLength).toBe(5)
      expect(encoded[0]).toBe(0x64) // major 3, argument 4 (byte length)
      // If someone regressed to data.length, it would be 0x62 (argument 2)

      // Verify it round-trips
      expect(decodeCBOR(encoded)).toBe("🔥")
    })
  })

  describe("error cases", () => {
    it("throws on empty input", () => {
      expect(() => decodeCBOR(new Uint8Array(0))).toThrow()
    })

    it("throws on truncated data", () => {
      const encoded = encodeCBOR("hello world")
      const truncated = encoded.slice(0, 4)
      expect(() => decodeCBOR(truncated)).toThrow()
    })

    it("throws on trailing bytes", () => {
      const encoded = encodeCBOR(42)
      const padded = new Uint8Array(encoded.byteLength + 2)
      padded.set(encoded)
      expect(() => decodeCBOR(padded)).toThrow(/trailing data/)
    })
  })
})
