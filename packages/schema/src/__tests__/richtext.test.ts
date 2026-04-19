import { describe, it, expect } from "vitest"
import {
  Schema,
  richTextChange,
  isRichTextChange,
  foldInstructions,
  transformIndex,
  stepRichText,
  normalizeSpans,
  Zero,
  KIND,
} from "../index.js"
import type { Instruction } from "../index.js"

// ---------------------------------------------------------------------------
// Types and constructors
// ---------------------------------------------------------------------------

describe("richTextChange", () => {
  it("constructor and type guard", () => {
    const rc = richTextChange([{ insert: "hello" }])
    expect(rc.type).toBe("richtext")
    expect(rc.instructions).toEqual([{ insert: "hello" }])
    expect(isRichTextChange(rc)).toBe(true)
    expect(isRichTextChange({ type: "text", instructions: [] })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Instruction algebra: format ≡ retain positionally
// ---------------------------------------------------------------------------

describe("format ≡ retain in position algebra", () => {
  it("transformIndex gives identical results for retain(N) and format(N)", () => {
    const retain: Instruction[] = [{ retain: 5 }]
    const format: Instruction[] = [{ format: 5 }]
    for (let i = 0; i <= 6; i++) {
      expect(transformIndex(i, "right", format)).toBe(
        transformIndex(i, "right", retain),
      )
    }
  })

  it("format advances both source and target cursors", () => {
    const cursors: number[] = []
    foldInstructions(
      [{ format: 3 }, { insert: "x" }] as Instruction[],
      undefined,
      {
        onRetain: (acc, _n, source, target) => {
          cursors.push(source, target)
          return acc
        },
        onInsert: (acc, _n, source, target) => {
          cursors.push(source, target)
          return acc
        },
        onDelete: (acc) => acc,
      },
    )
    // format(3): source=0,target=0 → advance to 3
    // insert("x"): source=3,target=3
    expect(cursors).toEqual([0, 0, 3, 3])
  })
})

// ---------------------------------------------------------------------------
// Schema grammar
// ---------------------------------------------------------------------------

describe("Schema.richText", () => {
  it("produces richtext kind with mark config", () => {
    const s = Schema.richText({ bold: { expand: "after" }, link: { expand: "none" } })
    expect(s[KIND]).toBe("richtext")
    expect(s.marks.bold.expand).toBe("after")
    expect(s.marks.link.expand).toBe("none")
  })

  it("structural zero is an empty delta (not empty string)", () => {
    const s = Schema.richText({ bold: { expand: "after" } })
    const zero = Zero.structural(s)
    expect(zero).toEqual([])
    expect(Array.isArray(zero)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// stepRichText — the core algorithm
// ---------------------------------------------------------------------------

describe("stepRichText", () => {
  // --- Basic operations ---

  it("insert into empty delta", () => {
    expect(
      stepRichText([], richTextChange([{ insert: "Hello" }])),
    ).toEqual([{ text: "Hello" }])
  })

  it("insert with marks at the beginning", () => {
    expect(
      stepRichText(
        [{ text: "World" }],
        richTextChange([{ insert: "Hello ", marks: { bold: true } }]),
      ),
    ).toEqual([
      { text: "Hello ", marks: { bold: true } },
      { text: "World" },
    ])
  })

  it("delete spanning multiple spans", () => {
    expect(
      stepRichText(
        [{ text: "AB" }, { text: "CD" }, { text: "EF" }],
        richTextChange([{ delete: 4 }]),
      ),
    ).toEqual([{ text: "EF" }])
  })

  it("retain + insert mid-content (typing into the middle of a span)", () => {
    expect(
      stepRichText(
        [{ text: "AE" }],
        richTextChange([{ retain: 1 }, { insert: "BCD" }]),
      ),
    ).toEqual([{ text: "ABCDE" }])
  })

  it("delete then insert (replace)", () => {
    expect(
      stepRichText(
        [{ text: "Hello World" }],
        richTextChange([{ delete: 5 }, { insert: "Hi" }]),
      ),
    ).toEqual([{ text: "Hi World" }])
  })

  // --- Format: the richtext-specific instruction ---

  it("format splits a span and applies marks", () => {
    expect(
      stepRichText(
        [{ text: "Hello" }],
        richTextChange([{ format: 3, marks: { bold: true } }]),
      ),
    ).toEqual([
      { text: "Hel", marks: { bold: true } },
      { text: "lo" },
    ])
  })

  it("format across multiple spans merges marks into each", () => {
    // Formats chars 0-3 bold across a two-span input
    expect(
      stepRichText(
        [
          { text: "AB", marks: { italic: true } },
          { text: "CD" },
        ],
        richTextChange([{ format: 3, marks: { bold: true } }]),
      ),
    ).toEqual([
      { text: "AB", marks: { italic: true, bold: true } },
      { text: "C", marks: { bold: true } },
      { text: "D" },
    ])
  })

  it("format with null removes a mark", () => {
    expect(
      stepRichText(
        [{ text: "Hello", marks: { bold: true, italic: true } }],
        richTextChange([{ format: 5, marks: { bold: null } }]),
      ),
    ).toEqual([{ text: "Hello", marks: { italic: true } }])
  })

  it("format removing the last mark produces a plain span (no marks key)", () => {
    const result = stepRichText(
      [{ text: "Hello", marks: { bold: true } }],
      richTextChange([{ format: 5, marks: { bold: null } }]),
    )
    expect(result).toEqual([{ text: "Hello" }])
    // Verify the marks key is truly absent, not just empty
    expect(result[0]).not.toHaveProperty("marks")
  })

  // --- Implicit trailing retain ---

  it("instructions shorter than content preserve the tail", () => {
    expect(
      stepRichText(
        [{ text: "Hello World" }],
        richTextChange([{ format: 5, marks: { bold: true } }]),
      ),
    ).toEqual([
      { text: "Hello", marks: { bold: true } },
      { text: " World" },
    ])
  })

  // --- Normalization under step ---

  it("retain across same-mark spans normalizes to one span", () => {
    expect(
      stepRichText(
        [
          { text: "AB", marks: { bold: true } },
          { text: "CD", marks: { bold: true } },
        ],
        richTextChange([{ retain: 4 }]),
      ),
    ).toEqual([{ text: "ABCD", marks: { bold: true } }])
  })
})

// ---------------------------------------------------------------------------
// normalizeSpans
// ---------------------------------------------------------------------------

describe("normalizeSpans", () => {
  it("merges adjacent spans with identical marks", () => {
    expect(
      normalizeSpans([
        { text: "A", marks: { bold: true } },
        { text: "B", marks: { bold: true } },
      ]),
    ).toEqual([{ text: "AB", marks: { bold: true } }])
  })

  it("drops empty spans", () => {
    expect(
      normalizeSpans([{ text: "" }, { text: "A" }, { text: "" }]),
    ).toEqual([{ text: "A" }])
  })

  it("preserves spans with different marks", () => {
    const input = [
      { text: "A", marks: { bold: true } },
      { text: "B", marks: { italic: true } },
    ]
    expect(normalizeSpans(input)).toEqual(input)
  })

  it("treats undefined marks, empty marks object, and absent marks as equivalent", () => {
    // These should all merge — none has effective marks
    const result = normalizeSpans([
      { text: "A" },
      { text: "B", marks: {} },
      { text: "C", marks: undefined as any },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]!.text).toBe("ABC")
  })
})