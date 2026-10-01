// CoordinateTrie — one node per coordinate, reached only from the root.
import { describe, expect, it } from "vitest"
import { CoordinateTrie, coordinateNeeded } from "../coordinate-trie.js"
import { AddressBase, type AddressedPath, RawPath } from "../path.js"

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
    expect(trie.node(list)?.children.size).toBe(0)
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

  it("locates a raw path at the addresses a navigation derived", () => {
    const trie = new CoordinateTrie()
    const navigated = trie.root.field("items").item(2).entry("k")
    const located = trie.locate(RawPath.empty.field("items").item(2).entry("k"))
    expect(located.key).toBe(navigated.key)
    expect(trie.node(located)).toBe(trie.node(navigated))
  })

  it("locate creates nothing, and keeps the coordinates past the trie's reach raw", () => {
    const trie = new CoordinateTrie()
    const items = trie.root.field("items")
    const before = trie.below(trie.root).length
    const located = trie.locate(
      RawPath.empty.field("items").item(3).field("title"),
    )
    expect(trie.below(trie.root).length).toBe(before)
    expect(located.segments[0]).toBe(items.segments[0])
    expect(located.segments[1]).not.toBeInstanceOf(AddressBase)
    expect(located.format()).toBe("items[3].title")
    expect(trie.node(located)).toBeUndefined()
  })

  it("coordinateNeeded keeps a coordinate for any one need", () => {
    const none = { refs: 0, children: 0, listeners: 0, subscribed: false }
    expect(coordinateNeeded(none)).toBe(false)
    expect(coordinateNeeded({ ...none, refs: 1 })).toBe(true)
    expect(coordinateNeeded({ ...none, children: 1 })).toBe(true)
    expect(coordinateNeeded({ ...none, listeners: 1 })).toBe(true)
    expect(coordinateNeeded({ ...none, subscribed: true })).toBe(true)
  })

  it("prune removes an emptied branch, a list item included", () => {
    const trie = new CoordinateTrie()
    const list = trie.root.field("items")
    const inside = list.item(0).field("x")
    trie.prune(inside)
    expect(trie.node(list)).toBeUndefined()
    expect(trie.below(trie.root)).toEqual([])
  })

  it("prune stops at a coordinate something needs", () => {
    let item: AddressedPath | undefined
    const trie = new CoordinateTrie(at => at.key === item?.key)
    const list = trie.root.field("items")
    item = list.item(0)
    const inside = item.field("x")
    trie.prune(inside)
    expect(trie.node(inside)).toBeUndefined()
    expect(trie.node(item)).toBeDefined()
    expect(trie.node(list)?.children.get(0)).toBe(item.last)
  })
})

describe("a list's children are keyed by index", () => {
  const items = (trie: CoordinateTrie) => trie.root.field("items")

  it("an item is its list's child at its index, and follows an insert", () => {
    const trie = new CoordinateTrie()
    const item = items(trie).item(1)
    expect(trie.node(items(trie))?.children.get(1)).toBe(item.last)
    trie.advance(items(trie), [{ insert: [0] }])
    expect(trie.node(items(trie))?.children.get(2)).toBe(item.last)
    expect(trie.node(items(trie))?.children.has(1)).toBe(false)
    expect(trie.node(item)).toBe(item.last)
  })

  it("a raw index locates the item now at that index", () => {
    const trie = new CoordinateTrie()
    const item = items(trie).item(0)
    trie.advance(items(trie), [{ insert: [0, 0] }])
    const located = trie.locate(RawPath.empty.field("items").item(2))
    expect(located.last).toBe(item.last)
    expect(trie.locate(RawPath.empty.field("items").item(0)).last).not.toBe(
      item.last,
    )
  })

  it("an item a change deleted is dead, with what is below it, and unlinked", () => {
    const trie = new CoordinateTrie()
    const item = items(trie).item(0)
    const inside = item.field("x")
    trie.advance(items(trie), [{ delete: 1 }])
    expect(item.last?.dead).toBe(true)
    expect(inside.last?.dead).toBe(true)
    expect(trie.node(item)).toBeUndefined()
    expect(trie.node(items(trie))?.children.size).toBe(0)
  })
})
