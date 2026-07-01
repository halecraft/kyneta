// Line utility tests — doc ID helpers and schema creation.

import { json, Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import {
  createLineDocSchema,
  isLineDocId,
  lineDocId,
  parseLineDocId,
  routeLine,
} from "../line.js"

const SimpleSchema = Schema.struct({ value: Schema.number() })

describe("doc ID utilities", () => {
  it("lineDocId builds correct format", () => {
    expect(lineDocId("signaling", "alice", "bob")).toBe(
      "line:signaling:alice→bob",
    )
  })

  it("isLineDocId correctly identifies Line doc IDs", () => {
    expect(isLineDocId("line:signaling:alice→bob" as any)).toBe(true)
    expect(isLineDocId("line:default:a→b" as any)).toBe(true)
    expect(isLineDocId("not-a-line-doc" as any)).toBe(false)
    expect(isLineDocId("line:no-arrow" as any)).toBe(false)
  })

  it("parseLineDocId extracts topic, from, and to", () => {
    expect(parseLineDocId("line:signaling:alice→bob" as any)).toEqual({
      topic: "signaling",
      from: "alice",
      to: "bob",
    })
  })

  it("parseLineDocId returns null for non-Line doc IDs", () => {
    expect(parseLineDocId("game-state" as any)).toBeNull()
    expect(parseLineDocId("line:no-arrow" as any)).toBeNull()
  })

  it("routeLine returns true for endpoint peers", () => {
    const docId = "line:signaling:alice→bob" as any
    expect(routeLine(docId, { peerId: "alice" } as any)).toBe(true)
    expect(routeLine(docId, { peerId: "bob" } as any)).toBe(true)
  })

  it("routeLine returns false for non-endpoint peers", () => {
    expect(
      routeLine(
        "line:signaling:alice→bob" as any,
        { peerId: "charlie" } as any,
      ),
    ).toBe(false)
  })

  it("routeLine returns undefined for non-Line doc IDs", () => {
    expect(routeLine("game-state" as any, { peerId: "alice" } as any)).toBe(
      undefined,
    )
  })
})

describe("createLineDocSchema", () => {
  it("produces a bindable doc schema", () => {
    const bound = json.bind(createLineDocSchema(SimpleSchema))
    expect(typeof bound.schemaHash).toBe("string")
  })
})
