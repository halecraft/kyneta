// CoordinateTrie — one node per coordinate, reached only from the root.
import { describe, expect, it } from "vitest"
import { CoordinateTrie } from "../coordinate-trie.js"
import { RawPath, resolveToAddressed } from "../path.js"

describe("CoordinateTrie", () => {
  it("below visits parents before children", () => {
    const trie = new CoordinateTrie()
    const a = trie.root.field("a")
    const ab = a.field("b")
    const abc = ab.entry("c")
    const ad = a.item(0)
    const below = trie.below(a).map(([path]) => path.key)
    expect(below).toEqual([ab.key, abc.key, ad.key])
    expect(below.indexOf(ab.key)).toBeLessThan(below.indexOf(abc.key))
  })

  it("within names the keys a change rewrote, and everything below them", () => {
    const trie = new CoordinateTrie()
    const m = trie.root.field("m")
    const k = m.entry("k")
    const kx = k.field("x")
    m.entry("j")
    expect(trie.within(m, { keys: ["k"] }).map(([path]) => path.key)).toEqual([
      k.key,
      kx.key,
    ])
    expect(trie.within(m, "none")).toEqual([])
    expect(trie.within(m, "all")).toHaveLength(3)
  })

  it("drop unlinks a coordinate and everything below it, marking each address dead", () => {
    const trie = new CoordinateTrie()
    const list = trie.root.field("items")
    const item = list.item(0)
    const inside = item.field("x")
    trie.drop(item)
    expect(trie.node(item)).toBeUndefined()
    expect(trie.node(inside)).toBeUndefined()
    expect(item.segments[1]?.dead).toBe(true)
    expect(inside.segments[2]?.dead).toBe(true)
    expect(trie.node(list)?.sequenceTable?.byIndex.size).toBe(0)
  })

  it("a dropped coordinate is unreachable, and a stale path cannot bring it back", () => {
    const trie = new CoordinateTrie()
    const item = trie.root.field("items").item(0)
    trie.drop(item)
    // Deriving below a dropped coordinate hands out dead addresses and
    // creates nothing.
    const below = item.field("x")
    expect(below.segments[2]?.dead).toBe(true)
    expect(trie.node(below)).toBeUndefined()
    expect(trie.node(item)).toBeUndefined()
    // The list's next item at that index is a new coordinate.
    const next = trie.root.field("items").item(0)
    expect(next.key).not.toBe(item.key)
  })

  it("keys a segment whose text contains the key separator exactly", () => {
    const trie = new CoordinateTrie()
    const tricky = trie.root.field("a\0b")
    const a = trie.root.field("a")
    const ab = a.field("b")
    expect(tricky.key).toBe(ab.key) // joined keys collide ...
    expect(trie.node(tricky)).not.toBe(trie.node(ab)) // ... coordinates do not
    expect(trie.below(a).map(([path]) => path.segments.length)).toEqual([2])
  })

  it("resolves a raw path to the same addresses a navigation derives", () => {
    const trie = new CoordinateTrie()
    const navigated = trie.root.field("items").item(2).entry("k")
    const resolved = resolveToAddressed(
      RawPath.empty.field("items").item(2).entry("k"),
      trie,
    )
    expect(resolved.key).toBe(navigated.key)
    expect(trie.node(resolved)).toBe(trie.node(navigated))
  })
})
