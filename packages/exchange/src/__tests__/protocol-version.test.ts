// protocol-version — unit tests for the pure compatibility classifier.

import { describe, expect, it } from "vitest"
import { classifyProtocolSkew } from "../protocol-version.js"

const v = (major: number, minor: number) => ({ major, minor })

describe("classifyProtocolSkew", () => {
  it("equal versions are compatible", () => {
    expect(classifyProtocolSkew(v(1, 0), v(1, 0))).toBe("compatible")
  })

  it("same major, differing minor is a minor skew", () => {
    expect(classifyProtocolSkew(v(1, 0), v(1, 2))).toBe("minor-skew")
  })

  it("minor skew is symmetric (either direction)", () => {
    expect(classifyProtocolSkew(v(1, 5), v(1, 0))).toBe("minor-skew")
  })

  it("differing major is a major mismatch", () => {
    expect(classifyProtocolSkew(v(1, 0), v(2, 0))).toBe("major-mismatch")
  })

  it("major mismatch dominates over minor differences", () => {
    expect(classifyProtocolSkew(v(2, 0), v(1, 9))).toBe("major-mismatch")
  })
})
