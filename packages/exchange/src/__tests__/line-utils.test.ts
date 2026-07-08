// Line utility tests — doc ID helpers and schema creation.

import { batch, json, Schema, version } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { Exchange } from "../exchange.js"
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

  it("the envelope's ack field is named ackLineage, not ackIncarnation", () => {
    const exchange = new Exchange({ id: "test" })
    const bound = json.bind(createLineDocSchema(SimpleSchema))
    const doc = exchange.get("envelope-shape-check" as any, bound)
    // Structural presence of the renamed field, and absence of the old
    // one — confirms the field rename is present in the schema shape.
    expect(typeof (doc as any).ackLineage).toBe("function")
    expect((doc as any).ackIncarnation).toBeUndefined()
    expect((doc as any).ackLineage()).toBe("")
  })

  it("Line's substrate-agnostic lineage access: version(doc).lineage is typed with no 'as any' cast", () => {
    // This is a type-level assertion enforced by the compiler at build
    // time (Line.ts contains zero `as any` casts for lineage access — see
    // `pnpm verify`'s type-check stage). At runtime, confirm the typed
    // `Version.lineage` property Line relies on is reachable directly off
    // `version(doc)` without any cast, for any substrate-backed doc.
    const exchange = new Exchange({ id: "test" })
    const bound = json.bind(createLineDocSchema(SimpleSchema))
    const doc = exchange.get("lineage-access-check" as any, bound)
    batch(doc, (d: any) => d.nextSeq.set(1))
    const lineage: string = version(doc).lineage
    expect(typeof lineage).toBe("string")
  })
})
