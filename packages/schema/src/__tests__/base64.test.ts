import { describe, expect, it } from "vitest"
import { base64ToUint8Array, uint8ArrayToBase64 } from "../base64.js"

describe("base64 round-trip", () => {
  it("round-trips empty Uint8Array", () => {
    const bytes = new Uint8Array([])
    expect(base64ToUint8Array(uint8ArrayToBase64(bytes))).toEqual(bytes)
  })

  it("round-trips single byte", () => {
    const bytes = new Uint8Array([42])
    expect(base64ToUint8Array(uint8ArrayToBase64(bytes))).toEqual(bytes)
  })

  it("round-trips multi-byte array", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 72, 101, 108, 108, 111])
    expect(base64ToUint8Array(uint8ArrayToBase64(bytes))).toEqual(bytes)
  })

  it("produces known base64 for 'Hello'", () => {
    // "Hello" = [72, 101, 108, 108, 111] → "SGVsbG8="
    const bytes = new Uint8Array([72, 101, 108, 108, 111])
    expect(uint8ArrayToBase64(bytes)).toBe("SGVsbG8=")
  })

  it("decodes known base64 string", () => {
    expect(base64ToUint8Array("SGVsbG8=")).toEqual(
      new Uint8Array([72, 101, 108, 108, 111]),
    )
  })
})
