import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { YjsVersion } from "../version.js"

// ===========================================================================
// Helpers
// ===========================================================================

/** Create a YjsVersion from a doc that has had some operations applied. */
function versionAfterOps(fn: (doc: Y.Doc) => void): YjsVersion {
  const doc = new Y.Doc()
  fn(doc)
  return new YjsVersion(Y.encodeStateVector(doc))
}

/** Create a YjsVersion from an empty doc (no operations). */
function emptyVersion(): YjsVersion {
  return new YjsVersion(Y.encodeStateVector(new Y.Doc()))
}

// ===========================================================================
// YjsVersion
// ===========================================================================

describe("YjsVersion", () => {
  // -------------------------------------------------------------------------
  // serialize / parse round-trip
  // -------------------------------------------------------------------------

  describe("serialize / parse", () => {
    it("round-trips an empty version vector", () => {
      const v = emptyVersion()
      const serialized = v.serialize()
      const parsed = YjsVersion.parse(serialized)
      expect(parsed.compare(v)).toBe("equal")
    })

    it("round-trips a version vector with one peer", () => {
      const v = versionAfterOps((doc) => {
        doc.getMap("root").set("title", "Hello")
      })
      const serialized = v.serialize()
      expect(typeof serialized).toBe("string")
      expect(serialized.length).toBeGreaterThan(0)

      const parsed = YjsVersion.parse(serialized)
      expect(parsed.compare(v)).toBe("equal")
      expect(v.compare(parsed)).toBe("equal")
    })

    it("round-trips a version vector with multiple peers", () => {
      const doc1 = new Y.Doc()
      const doc2 = new Y.Doc()

      doc1.getMap("root").set("title", "A")
      doc2.getMap("root").set("title", "B")

      // Sync doc1 ← doc2
      const update = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1))
      Y.applyUpdate(doc1, update)

      // doc1 now has ops from both peers
      const v = new YjsVersion(Y.encodeStateVector(doc1))
      const parsed = YjsVersion.parse(v.serialize())
      expect(parsed.compare(v)).toBe("equal")
    })

    it("serialized form is a non-empty string", () => {
      const v = versionAfterOps((doc) => {
        doc.getMap("root").set("count", 42)
      })
      const s = v.serialize()
      expect(typeof s).toBe("string")
      expect(s.length).toBeGreaterThan(0)
    })

    it("parse throws on empty string", () => {
      expect(() => YjsVersion.parse("")).toThrow("empty string")
    })

    it("parse throws on invalid base64", () => {
      expect(() => YjsVersion.parse("!!!not-base64!!!")).toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // compare
  // -------------------------------------------------------------------------

  describe("compare", () => {
    it("returns 'equal' for the same version vector", () => {
      const v = versionAfterOps((doc) => {
        doc.getMap("root").set("t", "hi")
      })
      expect(v.compare(v)).toBe("equal")
    })

    it("returns 'equal' for two independently constructed identical VVs", () => {
      const v1 = emptyVersion()
      const v2 = emptyVersion()
      expect(v1.compare(v2)).toBe("equal")
    })

    it("returns 'behind' / 'ahead' for causally ordered versions (single peer)", () => {
      const doc = new Y.Doc()
      const root = doc.getMap("root")
      root.set("title", "A")
      const v1 = new YjsVersion(Y.encodeStateVector(doc))

      root.set("title", "AB")
      const v2 = new YjsVersion(Y.encodeStateVector(doc))

      expect(v1.compare(v2)).toBe("behind")
      expect(v2.compare(v1)).toBe("ahead")
    })

    it("returns 'behind' / 'ahead' across multiple mutations", () => {
      const doc = new Y.Doc()
      const root = doc.getMap("root")
      root.set("t", "Hello")
      const early = new YjsVersion(Y.encodeStateVector(doc))

      root.set("c", 5)
      const items = new Y.Array()
      items.insert(0, ["x"])
      root.set("items", items)
      const late = new YjsVersion(Y.encodeStateVector(doc))

      expect(early.compare(late)).toBe("behind")
      expect(late.compare(early)).toBe("ahead")
    })

    it("returns 'concurrent' for divergent versions (two independent peers)", () => {
      const doc1 = new Y.Doc()
      const doc2 = new Y.Doc()

      doc1.getMap("root").set("title", "From peer 1")
      doc2.getMap("root").set("title", "From peer 2")

      const v1 = new YjsVersion(Y.encodeStateVector(doc1))
      const v2 = new YjsVersion(Y.encodeStateVector(doc2))

      expect(v1.compare(v2)).toBe("concurrent")
      expect(v2.compare(v1)).toBe("concurrent")
    })

    it("returns 'behind' after syncing one direction only", () => {
      const doc1 = new Y.Doc()
      const doc2 = new Y.Doc()

      doc1.getMap("root").set("t", "A")
      doc2.getMap("root").set("t", "B")

      // Sync doc1 → doc2 only (doc2 knows about both, doc1 only knows itself)
      const update = Y.encodeStateAsUpdate(
        doc1,
        Y.encodeStateVector(doc2),
      )
      Y.applyUpdate(doc2, update)

      const v1 = new YjsVersion(Y.encodeStateVector(doc1))
      const v2 = new YjsVersion(Y.encodeStateVector(doc2))

      // doc1 is behind (doesn't know about doc2's ops)
      // doc2 is ahead (knows about both)
      expect(v1.compare(v2)).toBe("behind")
      expect(v2.compare(v1)).toBe("ahead")
    })

    it("returns 'equal' after bidirectional sync", () => {
      const doc1 = new Y.Doc()
      const doc2 = new Y.Doc()

      doc1.getMap("root").set("t", "A")
      doc2.getMap("root").set("t", "B")

      // Bidirectional sync
      const u1to2 = Y.encodeStateAsUpdate(
        doc1,
        Y.encodeStateVector(doc2),
      )
      const u2to1 = Y.encodeStateAsUpdate(
        doc2,
        Y.encodeStateVector(doc1),
      )
      Y.applyUpdate(doc2, u1to2)
      Y.applyUpdate(doc1, u2to1)

      const v1 = new YjsVersion(Y.encodeStateVector(doc1))
      const v2 = new YjsVersion(Y.encodeStateVector(doc2))
      expect(v1.compare(v2)).toBe("equal")
    })

    it("throws when comparing with a non-YjsVersion", () => {
      const v = emptyVersion()
      const fake = {
        serialize: () => "fake",
        compare: () => "equal" as const,
      }
      expect(() => v.compare(fake)).toThrow(
        "YjsVersion can only be compared with another YjsVersion",
      )
    })
  })

  // -------------------------------------------------------------------------
  // compare after round-trip
  // -------------------------------------------------------------------------

  describe("compare after serialize/parse", () => {
    it("parsed version compares correctly with advanced version", () => {
      const doc = new Y.Doc()
      const root = doc.getMap("root")

      root.set("t", "Hello")
      const early = new YjsVersion(Y.encodeStateVector(doc))
      const earlySerialized = early.serialize()

      root.set("t", "Hello World")
      const late = new YjsVersion(Y.encodeStateVector(doc))

      const earlyParsed = YjsVersion.parse(earlySerialized)
      expect(earlyParsed.compare(late)).toBe("behind")
      expect(late.compare(earlyParsed)).toBe("ahead")
    })
  })
})