/**
 * State Serialization Tests
 *
 * Tests for serializing and deserializing Loro document state
 * for SSR hydration.
 */

import { createTypedDoc, Shape } from "@loro-extended/change"
import { describe, expect, it } from "vitest"

import {
  base64ToBytes,
  bytesToBase64,
  deserializeState,
  generateStateScript,
  type SerializedState,
  serializeState,
  serializeStateToJSON,
} from "./serialize.js"

// =============================================================================
// Test Schema
// =============================================================================

const testSchema = Shape.doc({
  title: Shape.text(),
  count: Shape.counter(),
  items: Shape.list(Shape.plain.string()),
})

// =============================================================================
// Base64 Encoding Tests
// =============================================================================

describe("bytesToBase64", () => {
  it("should encode bytes to base64", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]) // "Hello"
    const result = bytesToBase64(bytes)
    expect(result).toBe("SGVsbG8=")
  })

  it("should handle empty array", () => {
    const bytes = new Uint8Array([])
    const result = bytesToBase64(bytes)
    expect(result).toBe("")
  })

  it("should handle binary data", () => {
    const bytes = new Uint8Array([0, 255, 128, 64])
    const result = bytesToBase64(bytes)
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })
})

describe("base64ToBytes", () => {
  it("should decode base64 to bytes", () => {
    const result = base64ToBytes("SGVsbG8=")
    expect(result).toEqual(new Uint8Array([72, 101, 108, 108, 111]))
  })

  it("should handle empty string", () => {
    const result = base64ToBytes("")
    expect(result).toEqual(new Uint8Array([]))
  })

  it("should round-trip with bytesToBase64", () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 255, 0, 128])
    const encoded = bytesToBase64(original)
    const decoded = base64ToBytes(encoded)
    expect(decoded).toEqual(original)
  })
})

// =============================================================================
// Serialization Tests
// =============================================================================

describe("serializeState", () => {
  it("should serialize a Loro document", () => {
    const doc = createTypedDoc(testSchema)
    doc.title.insert(0, "Hello")
    doc.count.increment(5)

    const state = serializeState(doc)

    expect(state).toHaveProperty("snapshot")
    expect(state).toHaveProperty("version")
    expect(state).toHaveProperty("timestamp")
    expect(typeof state.snapshot).toBe("string")
    expect(typeof state.version).toBe("string")
    expect(typeof state.timestamp).toBe("number")
  })

  it("should include schemaId when provided", () => {
    const doc = createTypedDoc(testSchema)
    const state = serializeState(doc, { schemaId: "test-schema-v1" })

    expect(state.schemaId).toBe("test-schema-v1")
  })

  it("should have a recent timestamp", () => {
    const before = Date.now()
    const doc = createTypedDoc(testSchema)
    const state = serializeState(doc)
    const after = Date.now()

    expect(state.timestamp).toBeGreaterThanOrEqual(before)
    expect(state.timestamp).toBeLessThanOrEqual(after)
  })

  it("should exclude snapshot when includeSnapshot is false", () => {
    const doc = createTypedDoc(testSchema)
    const state = serializeState(doc, { includeSnapshot: false })

    expect(state.snapshot).toBe("")
  })
})

describe("serializeStateToJSON", () => {
  it("should return valid JSON string", () => {
    const doc = createTypedDoc(testSchema)
    doc.title.insert(0, "Test")

    const json = serializeStateToJSON(doc)

    expect(() => JSON.parse(json)).not.toThrow()
    const parsed = JSON.parse(json)
    expect(parsed).toHaveProperty("snapshot")
    expect(parsed).toHaveProperty("version")
  })
})

describe("generateStateScript", () => {
  it("should generate a script tag with inline JS", () => {
    const doc = createTypedDoc(testSchema)
    const script = generateStateScript(doc)

    expect(script).toMatch(/^<script>window\.__KINETIC_STATE__ = /)
    expect(script).toMatch(/<\/script>$/)
  })

  it("should use custom variable name", () => {
    const doc = createTypedDoc(testSchema)
    const script = generateStateScript(doc, { varName: "__MY_STATE__" })

    expect(script).toContain("window.__MY_STATE__ = ")
  })

  it("should generate JSON script tag when asJson is true", () => {
    const doc = createTypedDoc(testSchema)
    const script = generateStateScript(doc, { asJson: true })

    expect(script).toMatch(
      /^<script id="kinetic-state" type="application\/json">/,
    )
    expect(script).toMatch(/<\/script>$/)
    expect(script).not.toContain("window.")
  })

  it("should use custom script ID", () => {
    const doc = createTypedDoc(testSchema)
    const script = generateStateScript(doc, {
      asJson: true,
      scriptId: "my-state",
    })

    expect(script).toContain('id="my-state"')
  })
})

// =============================================================================
// Deserialization Tests
// =============================================================================

describe("deserializeState", () => {
  it("should restore document state from serialized data", () => {
    // Create and populate source document
    const sourceDoc = createTypedDoc(testSchema)
    sourceDoc.title.insert(0, "Hello World")
    sourceDoc.count.increment(42)
    sourceDoc.items.push("item1")
    sourceDoc.items.push("item2")

    // Serialize
    const state = serializeState(sourceDoc)

    // Create target document and deserialize
    const targetDoc = createTypedDoc(testSchema)
    deserializeState(targetDoc, state)

    // Verify state was restored
    expect(targetDoc.title.toString()).toBe("Hello World")
    expect(targetDoc.count.get()).toBe(42)
    expect(targetDoc.items.toArray()).toEqual(["item1", "item2"])
  })

  it("should throw on schema mismatch when expectedSchemaId is provided", () => {
    const doc = createTypedDoc(testSchema)
    const state: SerializedState = {
      snapshot: "",
      version: "{}",
      timestamp: Date.now(),
      schemaId: "wrong-schema",
    }

    expect(() => {
      deserializeState(doc, state, { expectedSchemaId: "correct-schema" })
    }).toThrow(/Schema mismatch/)
  })

  it("should not throw when schemaId matches", () => {
    const sourceDoc = createTypedDoc(testSchema)
    const state = serializeState(sourceDoc, { schemaId: "test-v1" })

    const targetDoc = createTypedDoc(testSchema)

    expect(() => {
      deserializeState(targetDoc, state, { expectedSchemaId: "test-v1" })
    }).not.toThrow()
  })

  it("should handle empty snapshot gracefully", () => {
    const doc = createTypedDoc(testSchema)
    const state: SerializedState = {
      snapshot: "",
      version: "{}",
      timestamp: Date.now(),
    }

    expect(() => {
      deserializeState(doc, state)
    }).not.toThrow()
  })
})

// =============================================================================
// Round-Trip Tests
// =============================================================================

describe("round-trip serialization", () => {
  it("should preserve text content through round-trip", () => {
    const original = createTypedDoc(testSchema)
    original.title.insert(0, "Test Title")

    const state = serializeState(original)
    const restored = createTypedDoc(testSchema)
    deserializeState(restored, state)

    expect(restored.title.toString()).toBe("Test Title")
  })

  it("should preserve counter value through round-trip", () => {
    const original = createTypedDoc(testSchema)
    original.count.increment(100)

    const state = serializeState(original)
    const restored = createTypedDoc(testSchema)
    deserializeState(restored, state)

    expect(restored.count.get()).toBe(100)
  })

  it("should preserve list content through round-trip", () => {
    const original = createTypedDoc(testSchema)
    original.items.push("a")
    original.items.push("b")
    original.items.push("c")

    const state = serializeState(original)
    const restored = createTypedDoc(testSchema)
    deserializeState(restored, state)

    expect(restored.items.toArray()).toEqual(["a", "b", "c"])
  })

  it("should preserve complex state through round-trip", () => {
    const original = createTypedDoc(testSchema)
    original.title.insert(0, "My List")
    original.count.increment(3)
    original.items.push("First")
    original.items.push("Second")
    original.items.push("Third")

    const state = serializeState(original)
    const restored = createTypedDoc(testSchema)
    deserializeState(restored, state)

    expect(restored.title.toString()).toBe("My List")
    expect(restored.count.get()).toBe(3)
    expect(restored.items.toArray()).toEqual(["First", "Second", "Third"])
  })
})
