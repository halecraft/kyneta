// TimestampVersion — unit tests for LWW version implementation.

import { describe, expect, it } from "vitest"
import { TimestampVersion } from "../substrates/timestamp-version.js"

describe("TimestampVersion", () => {
  describe("serialize / parse round-trip", () => {
    it("round-trips a timestamp", () => {
      const v = new TimestampVersion(1719000000000)
      const serialized = v.serialize()
      expect(serialized).toBe("1719000000000")
      const parsed = TimestampVersion.parse(serialized)
      expect(parsed.timestamp).toBe(1719000000000)
    })

    it("round-trips zero", () => {
      const v = new TimestampVersion(0)
      expect(TimestampVersion.parse(v.serialize()).timestamp).toBe(0)
    })
  })

  describe("parse rejects invalid input", () => {
    it.each([
      ["empty string", "", "empty string"],
      ["non-numeric", "abc", "Invalid"],
      ["negative", "-1", "Invalid"],
      ["Infinity", "Infinity", "Invalid"],
    ])("throws on %s", (_label, input, expectedMsg) => {
      expect(() => TimestampVersion.parse(input)).toThrow(expectedMsg)
    })
  })

  describe("compare", () => {
    it("returns 'behind' when this is older", () => {
      expect(
        new TimestampVersion(1000).compare(new TimestampVersion(2000)),
      ).toBe("behind")
    })

    it("returns 'ahead' when this is newer", () => {
      expect(
        new TimestampVersion(2000).compare(new TimestampVersion(1000)),
      ).toBe("ahead")
    })

    it("returns 'equal' for same timestamp", () => {
      expect(
        new TimestampVersion(1000).compare(new TimestampVersion(1000)),
      ).toBe("equal")
    })

    it("never returns 'concurrent' — timestamps form a total order", () => {
      const results = [
        new TimestampVersion(1).compare(new TimestampVersion(2)),
        new TimestampVersion(2).compare(new TimestampVersion(1)),
        new TimestampVersion(1).compare(new TimestampVersion(1)),
      ]
      expect(results).not.toContain("concurrent")
    })

    it("throws when compared with a non-TimestampVersion", () => {
      const v = new TimestampVersion(1000)
      const fake = { serialize: () => "1000", compare: () => "equal" as const }
      expect(() => v.compare(fake)).toThrow("TimestampVersion")
    })
  })

  describe("TimestampVersion.now()", () => {
    it("creates a version close to Date.now()", () => {
      const before = Date.now()
      const v = TimestampVersion.now()
      const after = Date.now()
      expect(v.timestamp).toBeGreaterThanOrEqual(before)
      expect(v.timestamp).toBeLessThanOrEqual(after)
    })
  })
})
