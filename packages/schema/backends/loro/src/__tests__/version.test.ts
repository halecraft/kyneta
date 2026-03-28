import { describe, expect, it } from "vitest"
import { LoroDoc } from "loro-crdt"
import { LoroVersion } from "../version.js"

// ===========================================================================
// Helpers
// ===========================================================================

/** Create a LoroVersion from a doc that has had some operations applied. */
function versionAfterOps(fn: (doc: LoroDoc) => void): LoroVersion {
  const doc = new LoroDoc()
  fn(doc)
  doc.commit()
  return new LoroVersion(doc.version())
}

/** Create a LoroVersion from an empty doc (no operations). */
function emptyVersion(): LoroVersion {
  return new LoroVersion(new LoroDoc().version())
}

// ===========================================================================
// LoroVersion
// ===========================================================================

describe("LoroVersion", () => {
  // -------------------------------------------------------------------------
  // serialize / parse round-trip
  // -------------------------------------------------------------------------

  describe("serialize / parse", () => {
    it("round-trips an empty version vector", () => {
      const v = emptyVersion()
      const serialized = v.serialize()
      const parsed = LoroVersion.parse(serialized)
      expect(parsed.compare(v)).toBe("equal")
    })

    it("round-trips a version vector with one peer", () => {
      const v = versionAfterOps((doc) => {
        doc.getText("title").insert(0, "Hello")
      })
      const serialized = v.serialize()
      expect(typeof serialized).toBe("string")
      expect(serialized.length).toBeGreaterThan(0)

      const parsed = LoroVersion.parse(serialized)
      expect(parsed.compare(v)).toBe("equal")
      expect(v.compare(parsed)).toBe("equal")
    })

    it("round-trips a version vector with multiple peers", () => {
      const doc1 = new LoroDoc()
      const doc2 = new LoroDoc()

      doc1.getText("title").insert(0, "A")
      doc1.commit()

      doc2.getText("title").insert(0, "B")
      doc2.commit()

      // Sync doc1 ← doc2
      const update = doc2.export({ mode: "update", from: doc1.version() })
      doc1.import(update)

      // doc1 now has ops from both peers
      const v = new LoroVersion(doc1.version())
      const parsed = LoroVersion.parse(v.serialize())
      expect(parsed.compare(v)).toBe("equal")
    })

    it("serialized form is a non-empty string", () => {
      const v = versionAfterOps((doc) => {
        doc.getCounter("count").increment(1)
      })
      const s = v.serialize()
      expect(typeof s).toBe("string")
      expect(s.length).toBeGreaterThan(0)
    })

    it("parse throws on empty string", () => {
      expect(() => LoroVersion.parse("")).toThrow("empty string")
    })

    it("parse throws on invalid base64", () => {
      expect(() => LoroVersion.parse("!!!not-base64!!!")).toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // compare
  // -------------------------------------------------------------------------

  describe("compare", () => {
    it("returns 'equal' for the same version vector", () => {
      const v = versionAfterOps((doc) => {
        doc.getText("t").insert(0, "hi")
      })
      expect(v.compare(v)).toBe("equal")
    })

    it("returns 'equal' for two independently constructed identical VVs", () => {
      const v1 = emptyVersion()
      const v2 = emptyVersion()
      expect(v1.compare(v2)).toBe("equal")
    })

    it("returns 'behind' / 'ahead' for causally ordered versions (single peer)", () => {
      const doc = new LoroDoc()
      doc.getText("title").insert(0, "A")
      doc.commit()
      const v1 = new LoroVersion(doc.version())

      doc.getText("title").insert(1, "B")
      doc.commit()
      const v2 = new LoroVersion(doc.version())

      expect(v1.compare(v2)).toBe("behind")
      expect(v2.compare(v1)).toBe("ahead")
    })

    it("returns 'behind' / 'ahead' across multiple mutations", () => {
      const doc = new LoroDoc()
      doc.getText("t").insert(0, "Hello")
      doc.commit()
      const early = new LoroVersion(doc.version())

      doc.getCounter("c").increment(5)
      doc.commit()
      doc.getList("items").insert(0, "x")
      doc.commit()
      const late = new LoroVersion(doc.version())

      expect(early.compare(late)).toBe("behind")
      expect(late.compare(early)).toBe("ahead")
    })

    it("returns 'concurrent' for divergent versions (two independent peers)", () => {
      const doc1 = new LoroDoc()
      const doc2 = new LoroDoc()

      doc1.getText("title").insert(0, "From peer 1")
      doc1.commit()

      doc2.getText("title").insert(0, "From peer 2")
      doc2.commit()

      const v1 = new LoroVersion(doc1.version())
      const v2 = new LoroVersion(doc2.version())

      expect(v1.compare(v2)).toBe("concurrent")
      expect(v2.compare(v1)).toBe("concurrent")
    })

    it("returns 'behind' after syncing one direction only", () => {
      const doc1 = new LoroDoc()
      const doc2 = new LoroDoc()

      doc1.getText("t").insert(0, "A")
      doc1.commit()
      doc2.getText("t").insert(0, "B")
      doc2.commit()

      // Sync doc1 → doc2 only (doc2 knows about both, doc1 only knows itself)
      const update = doc1.export({ mode: "update", from: doc2.version() })
      doc2.import(update)

      const v1 = new LoroVersion(doc1.version())
      const v2 = new LoroVersion(doc2.version())

      // doc1 is behind (doesn't know about doc2's ops)
      // doc2 is ahead (knows about both)
      expect(v1.compare(v2)).toBe("behind")
      expect(v2.compare(v1)).toBe("ahead")
    })

    it("returns 'equal' after bidirectional sync", () => {
      const doc1 = new LoroDoc()
      const doc2 = new LoroDoc()

      doc1.getText("t").insert(0, "A")
      doc1.commit()
      doc2.getText("t").insert(0, "B")
      doc2.commit()

      // Bidirectional sync
      const u1to2 = doc1.export({ mode: "update", from: doc2.version() })
      const u2to1 = doc2.export({ mode: "update", from: doc1.version() })
      doc2.import(u1to2)
      doc1.import(u2to1)

      const v1 = new LoroVersion(doc1.version())
      const v2 = new LoroVersion(doc2.version())
      expect(v1.compare(v2)).toBe("equal")
    })

    it("throws when comparing with a non-LoroVersion", () => {
      const v = emptyVersion()
      const fake = { serialize: () => "fake", compare: () => "equal" as const }
      expect(() => v.compare(fake)).toThrow(
        "LoroVersion can only be compared with another LoroVersion",
      )
    })
  })

  // -------------------------------------------------------------------------
  // compare after round-trip
  // -------------------------------------------------------------------------

  describe("compare after serialize/parse", () => {
    it("parsed version compares correctly with advanced version", () => {
      const doc = new LoroDoc()
      doc.getText("t").insert(0, "Hello")
      doc.commit()
      const early = new LoroVersion(doc.version())
      const earlySerialized = early.serialize()

      doc.getText("t").insert(5, " World")
      doc.commit()
      const late = new LoroVersion(doc.version())

      const earlyParsed = LoroVersion.parse(earlySerialized)
      expect(earlyParsed.compare(late)).toBe("behind")
      expect(late.compare(earlyParsed)).toBe("ahead")
    })
  })
})