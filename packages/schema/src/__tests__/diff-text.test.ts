// diffText — the single contiguous edit between two strings.
import { describe, expect, it } from "vitest"
import { diffText, textChange } from "../change.js"

describe("diffText", () => {
  it("insert at beginning", () => {
    expect(diffText("abc", "Xabc", 1)).toEqual(textChange([{ insert: "X" }]))
  })

  it("insert in middle", () => {
    expect(diffText("abc", "aXbc", 2)).toEqual(
      textChange([{ retain: 1 }, { insert: "X" }]),
    )
  })

  it("insert at end", () => {
    expect(diffText("abc", "abcX", 4)).toEqual(
      textChange([{ retain: 3 }, { insert: "X" }]),
    )
  })

  it("delete at beginning", () => {
    expect(diffText("abc", "bc", 0)).toEqual(textChange([{ delete: 1 }]))
  })

  it("delete in middle", () => {
    expect(diffText("abc", "ac", 1)).toEqual(
      textChange([{ retain: 1 }, { delete: 1 }]),
    )
  })

  it("delete at end", () => {
    expect(diffText("abc", "ab", 2)).toEqual(
      textChange([{ retain: 2 }, { delete: 1 }]),
    )
  })

  it("replace", () => {
    expect(diffText("abc", "aXYc", 3)).toEqual(
      textChange([{ retain: 1 }, { delete: 1 }, { insert: "XY" }]),
    )
  })

  it("no-op (identical strings)", () => {
    expect(diffText("abc", "abc", 2)).toEqual(textChange([]))
  })

  it("empty to non-empty", () => {
    expect(diffText("", "hello", 5)).toEqual(textChange([{ insert: "hello" }]))
  })

  it("non-empty to empty", () => {
    expect(diffText("hello", "", 0)).toEqual(textChange([{ delete: 5 }]))
  })

  it("multi-char insert", () => {
    expect(diffText("ab", "aXYZb", 4)).toEqual(
      textChange([{ retain: 1 }, { insert: "XYZ" }]),
    )
  })

  it("cursor hint disambiguation within identical characters", () => {
    // "aaa" → "aaaa" with cursor at 2 means the insert happened at position 2
    const result = diffText("aaa", "aaaa", 2)
    expect(result).toEqual(textChange([{ retain: 2 }, { insert: "a" }]))
  })

  it("handles repeated character runs with cursor hint at different positions", () => {
    // Typing 'b' into "bbb" — the diff is ambiguous (insert could be at 0,1,2,3).
    // Cursor at 1 → insert at position 1
    expect(diffText("bbb", "bbbb", 1)).toEqual(
      textChange([{ retain: 1 }, { insert: "b" }]),
    )
    // Cursor at 3 → insert at position 3
    expect(diffText("bbb", "bbbb", 3)).toEqual(
      textChange([{ retain: 3 }, { insert: "b" }]),
    )
    // Cursor at 0 → insert at position 0
    expect(diffText("bbb", "bbbb", 0)).toEqual(textChange([{ insert: "b" }]))
  })

  it("handles deletion within repeated characters with cursor hint", () => {
    // Deleting one 'a' from "aaaa" — ambiguous which was deleted.
    // Cursor at 2 → delete at position 2
    expect(diffText("aaaa", "aaa", 2)).toEqual(
      textChange([{ retain: 2 }, { delete: 1 }]),
    )
  })
})

describe("diffText without a cursor hint", () => {
  it("places an ambiguous insert as far right as the strings allow", () => {
    expect(diffText("aaa", "aaaa")).toEqual(
      textChange([{ retain: 3 }, { insert: "a" }]),
    )
  })

  it("places an ambiguous delete as far right as the strings allow", () => {
    expect(diffText("aaaa", "aaa")).toEqual(
      textChange([{ retain: 3 }, { delete: 1 }]),
    )
  })

  it("finds an unambiguous edit wherever it is", () => {
    expect(diffText("hello world", "hello brave world")).toEqual(
      textChange([{ retain: 6 }, { insert: "brave " }]),
    )
    expect(diffText("abcdef", "abXf")).toEqual(
      textChange([{ retain: 2 }, { delete: 3 }, { insert: "X" }]),
    )
  })

  it("equal strings produce no instructions", () => {
    expect(diffText("same", "same")).toEqual(textChange([]))
  })
})
