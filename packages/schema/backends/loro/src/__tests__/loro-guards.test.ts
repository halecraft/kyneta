import { LoroDoc } from "loro-crdt"
import { describe, expect, it } from "vitest"
import { hasKind, isLoroContainer, isLoroDoc } from "../loro-guards.js"

describe("loro-guards", () => {
  describe("hasKind vs isLoroContainer soundness", () => {
    it("hasKind accepts an object with .kind() but no .id", () => {
      const kindOnly = { kind: () => "Map" }
      expect(hasKind(kindOnly)).toBe(true)
    })

    it("isLoroContainer rejects an object with .kind() but no .id", () => {
      const kindOnly = { kind: () => "Map" }
      expect(isLoroContainer(kindOnly)).toBe(false)
    })

    it("isLoroContainer accepts an object with both .kind() and .id", () => {
      const container = { kind: () => "Map", id: "cid:0@0:Map" }
      expect(isLoroContainer(container)).toBe(true)
    })

    it("real Loro container satisfies both guards", () => {
      const doc = new LoroDoc()
      const map = doc.getMap("test")
      expect(hasKind(map)).toBe(true)
      expect(isLoroContainer(map)).toBe(true)
    })
  })

  describe("isLoroDoc", () => {
    it("accepts a real LoroDoc", () => {
      expect(isLoroDoc(new LoroDoc())).toBe(true)
    })

    it("rejects a Loro container (has .kind but not .peerIdStr)", () => {
      const doc = new LoroDoc()
      expect(isLoroDoc(doc.getMap("test"))).toBe(false)
    })

    it("rejects primitives and plain objects", () => {
      expect(isLoroDoc(null)).toBe(false)
      expect(isLoroDoc(undefined)).toBe(false)
      expect(isLoroDoc({})).toBe(false)
      expect(isLoroDoc("string")).toBe(false)
    })
  })
})
