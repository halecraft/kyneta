// schema-hash — computeSchemaHash stability and differentiation tests.
//
// computeSchemaHash is a versioning commitment: the hash for a given
// schema must never change across releases. These tests protect against
// accidental changes to the canonical serialization or hash algorithm.

import { computeSchemaHash, Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"

// ===========================================================================
// Helpers
// ===========================================================================

const SimpleDoc = Schema.doc({
  title: Schema.string(),
  count: Schema.number(),
})

// ===========================================================================
// Tests
// ===========================================================================

describe("computeSchemaHash", () => {
  // ── Format ──

  it("produces a 34-character hex string with '00' version prefix", () => {
    const hash = computeSchemaHash(SimpleDoc)
    expect(hash).toHaveLength(34)
    expect(hash.slice(0, 2)).toBe("00")
    expect(/^00[0-9a-f]{32}$/.test(hash)).toBe(true)
  })

  // ── Determinism ──

  it("same schema returns identical hash on repeated calls", () => {
    const h1 = computeSchemaHash(SimpleDoc)
    const h2 = computeSchemaHash(SimpleDoc)
    expect(h1).toBe(h2)
  })

  it("structurally equivalent schemas from independent construction produce same hash", () => {
    const a = Schema.doc({ title: Schema.string(), count: Schema.number() })
    const b = Schema.doc({ title: Schema.string(), count: Schema.number() })
    expect(computeSchemaHash(a)).toBe(computeSchemaHash(b))
  })

  // ── Alphabetical canonicalization ──

  it("field insertion order does not affect hash", () => {
    const forward = Schema.doc({
      alpha: Schema.string(),
      beta: Schema.number(),
      gamma: Schema.boolean(),
    })

    // Construct with reversed insertion order
    const fields: Record<string, any> = {}
    fields.gamma = Schema.boolean()
    fields.beta = Schema.number()
    fields.alpha = Schema.string()
    const reversed = Schema.doc(fields)

    expect(computeSchemaHash(forward)).toBe(computeSchemaHash(reversed))
  })

  // ── Differentiation ──

  it("different field names produce different hashes", () => {
    const a = Schema.doc({ title: Schema.string() })
    const b = Schema.doc({ name: Schema.string() })
    expect(computeSchemaHash(a)).not.toBe(computeSchemaHash(b))
  })

  it("different field types produce different hashes", () => {
    const a = Schema.doc({ value: Schema.string() })
    const b = Schema.doc({ value: Schema.number() })
    expect(computeSchemaHash(a)).not.toBe(computeSchemaHash(b))
  })

  it("additional field produces different hash", () => {
    const v1 = Schema.doc({ title: Schema.string() })
    const v2 = Schema.doc({ title: Schema.string(), count: Schema.number() })
    expect(computeSchemaHash(v1)).not.toBe(computeSchemaHash(v2))
  })

  it("nested structure difference produces different hash", () => {
    const flat = Schema.doc({ data: Schema.string() })
    const nested = Schema.doc({
      data: Schema.struct({ inner: Schema.string() }),
    })
    expect(computeSchemaHash(flat)).not.toBe(computeSchemaHash(nested))
  })

  it("annotation difference produces different hash", () => {
    const plain = Schema.doc({ content: Schema.string() })
    const annotated = Schema.doc({
      content: Schema.annotated("text"),
    })
    expect(computeSchemaHash(plain)).not.toBe(computeSchemaHash(annotated))
  })

  it("list vs record of same item type produce different hashes", () => {
    const withList = Schema.doc({ items: Schema.list(Schema.string()) })
    const withRecord = Schema.doc({ items: Schema.record(Schema.string()) })
    expect(computeSchemaHash(withList)).not.toBe(computeSchemaHash(withRecord))
  })

  // ── Golden value: versioning commitment ──
  // If this test breaks, the canonical serialization or hash algorithm changed.
  // That's a breaking change for stored DocMetadata and in-flight present messages.

  it("golden value: SimpleDoc hash is stable across releases", () => {
    const hash = computeSchemaHash(SimpleDoc)
    expect(hash).toBe("0092bd99c8bf6feeafeabcb5d37cc4e19e")
  })

  // ── Schema kinds coverage ──

  it("handles all structural kinds without throwing", () => {
    const complex = Schema.doc({
      text: Schema.annotated("text"),
      scalar: Schema.string(),
      nested: Schema.struct({
        inner: Schema.number(),
      }),
      list: Schema.list(Schema.boolean()),
      record: Schema.record(Schema.string()),
      optional: Schema.nullable(Schema.string()),
    })

    const hash = computeSchemaHash(complex)
    expect(hash).toHaveLength(34)
    expect(hash.startsWith("00")).toBe(true)
  })
})
