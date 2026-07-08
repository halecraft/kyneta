import { describe, expect, it } from "vitest"
import { json } from "../bind.js"
import { applyTextInstructions } from "../change.js"
import { createDoc } from "../create-doc.js"
import { Schema } from "../schema.js"

// `applyTextInstructions` delegates all cursor math to `textInstructionsToPatches`
// (unit-tested in position.test.ts). These tests exercise only what that suite
// cannot: end-to-end dispatch onto a live TextRef — that each patch calls the
// right ref method and the doc's final text is correct.

const TextDoc = json.bind(Schema.struct({ text: Schema.text() }))

describe("applyTextInstructions", () => {
  it("applies a simple insert to empty text", () => {
    const doc = createDoc(TextDoc)
    applyTextInstructions(doc.text, [{ insert: "Hello" }])
    expect(doc.text()).toBe("Hello")
  })

  it("applies retain + insert (append)", () => {
    const doc = createDoc(TextDoc)
    doc.text.insert(0, "Hello")
    applyTextInstructions(doc.text, [{ retain: 5 }, { insert: " world" }])
    expect(doc.text()).toBe("Hello world")
  })

  it("applies retain + delete (remove trailing char)", () => {
    const doc = createDoc(TextDoc)
    doc.text.insert(0, "Hello world")
    applyTextInstructions(doc.text, [
      { retain: 9 },
      { delete: 1 },
      { retain: 1 },
    ])
    expect(doc.text()).toBe("Hello word")
  })

  it("applies a mid-string substitution (retain·delete·insert·retain)", () => {
    const doc = createDoc(TextDoc)
    doc.text.insert(0, "Hello cruel world")
    applyTextInstructions(doc.text, [
      { retain: 6 },
      { delete: 5 },
      { insert: "beautiful" },
      { retain: 6 },
    ])
    expect(doc.text()).toBe("Hello beautiful world")
  })

  it("applies multiple sequential deltas to one evolving doc", () => {
    const doc = createDoc(TextDoc)
    applyTextInstructions(doc.text, [{ insert: "Hello" }])
    applyTextInstructions(doc.text, [{ retain: 5 }, { insert: " world" }])
    applyTextInstructions(doc.text, [
      { retain: 9 },
      { delete: 1 },
      { retain: 1 },
    ])
    expect(doc.text()).toBe("Hello word")
  })

  it("handles empty instructions (no-op)", () => {
    const doc = createDoc(TextDoc)
    doc.text.insert(0, "Hello")
    applyTextInstructions(doc.text, [])
    expect(doc.text()).toBe("Hello")
  })

  it("handles complete replacement", () => {
    const doc = createDoc(TextDoc)
    doc.text.insert(0, "abc")
    applyTextInstructions(doc.text, [{ delete: 3 }, { insert: "xyz" }])
    expect(doc.text()).toBe("xyz")
  })
})
