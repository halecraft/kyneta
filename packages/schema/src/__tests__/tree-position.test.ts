// tree-position.test.ts — Tree-position algebra tests.
//
// The round-trip property is the primary invariant:
//   flatten(resolve(pos)) === pos  for all pos in [0, contentSize]
//
// Individual nodeSize/resolve/flatten tests exist only where they
// protect against specific regressions or document non-obvious
// counting rules. The round-trip tests cover the general case.

import { describe, expect, it } from "vitest"
import { RawPath } from "../path.js"
import { plainReader } from "../reader.js"
import { KIND, Schema } from "../schema.js"
import {
  contentSize,
  flattenTreePosition,
  isLeaf,
  nodeSize,
  resolveTreePosition,
} from "../tree-position.js"

// ===========================================================================
// Helpers
// ===========================================================================

function setup(state: unknown) {
  return {
    reader: plainReader(state as Record<string, unknown>),
    root: RawPath.empty,
  }
}

/** Assert the round-trip property for every valid position in [0, cs]. */
function assertRoundTrip(
  schema: Parameters<typeof resolveTreePosition>[1],
  state: unknown,
) {
  const { reader } = setup(state)
  const cs = contentSize(reader, schema, RawPath.empty)
  for (let pos = 0; pos <= cs; pos++) {
    const resolved = resolveTreePosition(reader, schema, pos)
    expect(resolved, `resolve(${pos}) should not be null`).not.toBeNull()
    const flat = flattenTreePosition(
      reader,
      schema,
      resolved!.path,
      resolved!.offset,
    )
    expect(flat, `round-trip failed at pos ${pos}`).toBe(pos)
  }
  // One past the end is out of bounds
  expect(resolveTreePosition(reader, schema, cs + 1)).toBeNull()
  return cs
}

// ===========================================================================
// isLeaf — only the classification boundary matters
// ===========================================================================

describe("isLeaf", () => {
  it("text, scalar, counter are leaves; composites are not", () => {
    expect(isLeaf(Schema.text())).toBe(true)
    expect(isLeaf(Schema.string())).toBe(true)
    expect(isLeaf(Schema.counter())).toBe(true)

    expect(isLeaf(Schema.struct({ x: Schema.string() }))).toBe(false)
    expect(isLeaf(Schema.list(Schema.string()))).toBe(false)
    expect(isLeaf(Schema.record(Schema.string()))).toBe(false)
    expect(isLeaf(Schema.movableList(Schema.string()))).toBe(false)
  })
})

// ===========================================================================
// nodeSize — PM counting convention
// ===========================================================================

describe("nodeSize", () => {
  it("text: character count", () => {
    const { reader, root } = setup("Hello")
    expect(nodeSize(reader, Schema.text(), root)).toBe(5)
  })

  it("empty text: 0", () => {
    const { reader, root } = setup("")
    expect(nodeSize(reader, Schema.text(), root)).toBe(0)
  })

  it("scalar and counter: always 1 regardless of value", () => {
    const s1 = setup("anything")
    expect(nodeSize(s1.reader, Schema.string(), s1.root)).toBe(1)
    const s2 = setup(42)
    expect(nodeSize(s2.reader, Schema.number(), s2.root)).toBe(1)
    const s3 = setup(10)
    expect(nodeSize(s3.reader, Schema.counter(), s3.root)).toBe(1)
  })

  it("product: 2 + sum of field sizes", () => {
    const schema = Schema.struct({ a: Schema.text(), b: Schema.number() })
    const { reader, root } = setup({ a: "Hi", b: 42 })
    // 2 (open/close) + 2 ("Hi") + 1 (scalar) = 5
    expect(nodeSize(reader, schema, root)).toBe(5)
  })

  it("sequence: 2 + sum of item sizes", () => {
    const schema = Schema.list(Schema.struct({ name: Schema.text() }))
    const { reader, root } = setup([{ name: "Alice" }, { name: "Bob" }])
    // 2 + (2+5) + (2+3) = 14
    expect(nodeSize(reader, schema, root)).toBe(14)
  })

  it("empty sequence: 2 (open/close only)", () => {
    const schema = Schema.list(Schema.struct({ name: Schema.text() }))
    const { reader, root } = setup([])
    expect(nodeSize(reader, schema, root)).toBe(2)
  })

  it("map: keys sorted lexicographically for counting", () => {
    const schema = Schema.record(Schema.text())
    const { reader, root } = setup({ beta: "XX", alpha: "Y" })
    // 2 + 1 ("Y" for alpha) + 2 ("XX" for beta) = 5
    expect(nodeSize(reader, schema, root)).toBe(5)
  })

  it("nullable sum: dispatches to active variant", () => {
    const schema = Schema.struct({
      x: Schema.string(),
      y: Schema.number(),
    }).nullable()
    // null → scalar("null") → 1
    const s1 = setup(null)
    expect(nodeSize(s1.reader, schema, s1.root)).toBe(1)
    // non-null → struct: 2 + 1 + 1 = 4
    const s2 = setup({ x: "hi", y: 5 })
    expect(nodeSize(s2.reader, schema, s2.root)).toBe(4)
  })

  it("discriminated sum: dispatches to correct variant", () => {
    const schema = Schema.discriminatedUnion("type", [
      Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
      Schema.struct({
        type: Schema.string("image"),
        url: Schema.string(),
        width: Schema.number(),
      }),
    ])
    // "image" variant: 2 + 3 fields = 5
    const { reader, root } = setup({
      type: "image",
      url: "http://...",
      width: 100,
    })
    expect(nodeSize(reader, schema, root)).toBe(5)
  })

  it("set and tree throw", () => {
    const s1 = setup([])
    expect(() =>
      nodeSize(s1.reader, Schema.set(Schema.string()), s1.root),
    ).toThrow(/set.*not supported/)
    const s2 = setup({})
    expect(() =>
      nodeSize(
        s2.reader,
        Schema.tree(Schema.struct({ label: Schema.string() })),
        s2.root,
      ),
    ).toThrow(/tree.*not supported/)
  })
})

// ===========================================================================
// contentSize
// ===========================================================================

describe("contentSize", () => {
  it("leaf: equals nodeSize; composite: nodeSize minus 2", () => {
    const { reader: r1, root } = setup("ABC")
    expect(contentSize(r1, Schema.text(), root)).toBe(3)

    const schema = Schema.struct({ title: Schema.text() })
    const { reader: r2 } = setup({ title: "Hello" })
    // nodeSize=7, contentSize=5
    expect(contentSize(r2, schema, RawPath.empty)).toBe(
      nodeSize(r2, schema, RawPath.empty) - 2,
    )
  })
})

// ===========================================================================
// resolveTreePosition — targeted regression tests
// ===========================================================================

describe("resolveTreePosition", () => {
  it("resolves text character offsets including end-of-text", () => {
    const schema = Schema.struct({ title: Schema.text() })
    const { reader } = setup({ title: "Hi" })

    const r0 = resolveTreePosition(reader, schema, 0)
    expect(r0!.path.length).toBe(0) // root, before first child
    expect(r0!.offset).toBe(0)

    const r1 = resolveTreePosition(reader, schema, 1)
    expect(r1!.path.format()).toBe("title")
    expect(r1!.offset).toBe(1)
    expect(r1!.schema[KIND]).toBe("text")

    // End-of-text is a valid position (offset = charCount)
    const r2 = resolveTreePosition(reader, schema, 2)
    expect(r2!.path.format()).toBe("title")
    expect(r2!.offset).toBe(2)
  })

  it("out of bounds returns null", () => {
    const schema = Schema.struct({ x: Schema.text() })
    const { reader } = setup({ x: "abc" })
    expect(resolveTreePosition(reader, schema, -1)).toBeNull()
    expect(resolveTreePosition(reader, schema, -100)).toBeNull()
    const cs = contentSize(reader, schema, RawPath.empty)
    expect(resolveTreePosition(reader, schema, cs + 1)).toBeNull()
  })

  it("position 0 is valid even for empty content", () => {
    const schema = Schema.struct({ a: Schema.text() })
    const { reader } = setup({ a: "" })
    expect(resolveTreePosition(reader, schema, 0)).not.toBeNull()
  })

  // --- Regression: composite boundary bug ---
  //
  // The original code used `remaining <= childSize` for all node types.
  // For composites, remaining === childSize means the position is at
  // the node's *closing* boundary, which belongs to the parent — not
  // inside the child. The fix: composites use strict `<`.
  //
  // This test would FAIL against the pre-fix code because it would
  // recurse into item[0] with remaining = nodeSize - 1, landing past
  // the item's content and returning a wrong (path, offset).

  it("position at composite closing boundary resolves at parent", () => {
    const schema = Schema.list(Schema.struct({ t: Schema.text() }))
    // item[0] struct: nodeSize = 2 + 3 = 5
    const { reader } = setup([{ t: "abc" }])

    // pos 5 = exactly item[0].nodeSize → closing boundary of item[0]
    // Should resolve at the list level, offset=1 (after item[0])
    const r = resolveTreePosition(reader, schema, 5)
    expect(r).not.toBeNull()
    expect(r!.path.length).toBe(0) // at the list root
    expect(r!.offset).toBe(1) // after the single item
  })

  // --- Regression: scalar between composites ---
  //
  // Non-text leaves (nodeSize=1) must be *consumed and skipped*, not
  // entered. The original code had `if (isLeaf) return { parent, childIndex }`
  // inside the `remaining <= childSize` check, which returned the position
  // *before* the scalar instead of *after* it.

  it("scalar between two text fields is consumed, not entered", () => {
    const schema = Schema.struct({
      a: Schema.text(),
      b: Schema.number(),
      c: Schema.text(),
    })
    const { reader } = setup({ a: "XY", b: 42, c: "Z" })
    // contentSize = 2 + 1 + 1 = 4
    //   pos 0: root offset 0
    //   pos 1: a offset 1
    //   pos 2: a offset 2 (end of "XY")
    //   pos 3: root offset 2 (scalar consumed, before "c")
    //   pos 4: c offset 1

    const r3 = resolveTreePosition(reader, schema, 3)
    expect(r3).not.toBeNull()
    // Must be root offset 2, NOT root offset 1 (the pre-fix bug)
    expect(r3!.path.length).toBe(0)
    expect(r3!.offset).toBe(2)
  })
})

// ===========================================================================
// flattenTreePosition — targeted tests
// ===========================================================================

describe("flattenTreePosition", () => {
  it("empty path at root: offset maps directly", () => {
    const schema = Schema.struct({ title: Schema.text() })
    const { reader } = setup({ title: "Hello" })
    expect(flattenTreePosition(reader, schema, RawPath.empty, 0)).toBe(0)
  })

  it("text field offset translates to flat position", () => {
    const schema = Schema.struct({
      first: Schema.text(),
      second: Schema.text(),
    })
    const { reader } = setup({ first: "AB", second: "C" })
    // "second" starts after "first" (nodeSize=2)
    expect(
      flattenTreePosition(reader, schema, RawPath.empty.field("second"), 0),
    ).toBe(2)
  })

  it("list item accounts for preceding items + struct open boundary", () => {
    const schema = Schema.list(Schema.struct({ name: Schema.text() }))
    const { reader } = setup([{ name: "Alice" }, { name: "Bob" }])
    // [1].name offset 0: skip item[0](nodeSize=7) + struct open(1) = 8
    expect(
      flattenTreePosition(
        reader,
        schema,
        RawPath.empty.item(1).field("name"),
        0,
      ),
    ).toBe(8)
  })

  // Exercises the code path where flatten lands on a non-root composite
  // (the `flat += 1 // opening boundary` + `flatOffsetInComposite` branch)
  it("composite child-offset at non-root level", () => {
    const schema = Schema.struct({
      items: Schema.list(Schema.struct({ t: Schema.text() })),
    })
    const { reader } = setup({
      items: [{ t: "ab" }, { t: "c" }],
    })
    // The list at path "items" has contentSize = (2+2) + (2+1) = 7
    // Resolve pos that lands at list offset 1 (between items):
    //   root → items list (open=+1), item[0] nodeSize=4
    //   flat = 0 (no preceding root siblings) + 1 (list open) + 4 (item[0]) = 5
    expect(
      flattenTreePosition(reader, schema, RawPath.empty.field("items"), 1),
    ).toBe(5)
  })
})

// ===========================================================================
// Map ordering
// ===========================================================================

describe("map ordering", () => {
  it("lexicographic key order, round-trip holds", () => {
    const schema = Schema.struct({
      meta: Schema.record(Schema.text()),
    })
    assertRoundTrip(schema, {
      meta: { zebra: "ZZ", alpha: "A", middle: "MM" },
    })
  })
})

// ===========================================================================
// Round-trip property — the fundamental invariant
// ===========================================================================

describe("round-trip: flatten(resolve(pos)) === pos", () => {
  it("struct with text field", () => {
    assertRoundTrip(Schema.struct({ title: Schema.text() }), { title: "Hello" })
  })

  it("struct with mixed fields (text + scalar + text)", () => {
    assertRoundTrip(
      Schema.struct({ a: Schema.text(), b: Schema.number(), c: Schema.text() }),
      { a: "XY", b: 42, c: "Z" },
    )
  })

  it("list of structs", () => {
    assertRoundTrip(Schema.list(Schema.struct({ name: Schema.text() })), [
      { name: "Alice" },
      { name: "Bob" },
      { name: "C" },
    ])
  })

  it("nested: struct > list > struct > text", () => {
    assertRoundTrip(
      Schema.struct({
        items: Schema.list(Schema.struct({ body: Schema.text() })),
      }),
      { items: [{ body: "Hi" }, { body: "Q" }] },
    )
  })

  it("deeply nested: struct > struct > struct > text", () => {
    assertRoundTrip(
      Schema.struct({
        outer: Schema.struct({
          inner: Schema.struct({ deep: Schema.text() }),
        }),
      }),
      { outer: { inner: { deep: "ABCDE" } } },
    )
  })

  it("empty content", () => {
    const cs = assertRoundTrip(Schema.struct({ title: Schema.text() }), {
      title: "",
    })
    expect(cs).toBe(0)
  })

  it("movable list", () => {
    assertRoundTrip(Schema.movableList(Schema.struct({ v: Schema.text() })), [
      { v: "ab" },
      { v: "c" },
    ])
  })

  it("struct with map field", () => {
    assertRoundTrip(
      Schema.struct({ settings: Schema.record(Schema.number()) }),
      { settings: { width: 100, height: 200, depth: 50 } },
    )
  })

  it("nullable sum (null)", () => {
    assertRoundTrip(Schema.struct({ subtitle: Schema.string().nullable() }), {
      subtitle: null,
    })
  })

  it("nullable sum (non-null)", () => {
    assertRoundTrip(Schema.struct({ subtitle: Schema.string().nullable() }), {
      subtitle: "Hello",
    })
  })
})

// ===========================================================================
// Integration — live reader reflects mutations
// ===========================================================================

describe("live reader reflects mutations", () => {
  it("round-trip holds before and after state mutation", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      items: Schema.list(Schema.struct({ name: Schema.text() })),
    })

    const state: Record<string, unknown> = {
      title: "Doc",
      items: [{ name: "A" }],
    }
    const reader = plainReader(state)

    // Round-trip pre-mutation
    const cs1 = contentSize(reader, schema, RawPath.empty)
    for (let pos = 0; pos <= cs1; pos++) {
      const r = resolveTreePosition(reader, schema, pos)!
      expect(flattenTreePosition(reader, schema, r.path, r.offset)).toBe(pos)
    }
    // Mutate
    ;(state as any).title = "Document"
    ;(state as any).items = [{ name: "Alpha" }, { name: "Beta" }]

    // Round-trip post-mutation — same reader, different content
    const cs2 = contentSize(reader, schema, RawPath.empty)
    expect(cs2).not.toBe(cs1)
    for (let pos = 0; pos <= cs2; pos++) {
      const r = resolveTreePosition(reader, schema, pos)!
      expect(flattenTreePosition(reader, schema, r.path, r.offset)).toBe(pos)
    }
  })
})
