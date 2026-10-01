// SubscriberTrie — subscribers and population state, one node per coordinate.
import { describe, expect, it } from "vitest"
import { RawPath } from "../path.js"
import { type SubscriberNode, SubscriberTrie } from "../subscriber-trie.js"

const outer = RawPath.empty.field("outer")
const x = outer.field("x")
const m = RawPath.empty.field("m")
const list = RawPath.empty.field("list")

/** The nodes below `node`. */
function countBelow(node: SubscriberNode): number {
  let count = 0
  for (const child of node.children.values()) count += 1 + countBelow(child)
  return count
}

describe("SubscriberTrie", () => {
  it("prunes a node that no longer holds anything, and a stale teardown is harmless", () => {
    const trie = new SubscriberTrie()
    const unsubscribe = trie.listenOwn(x, () => {})
    expect(trie.find(x)?.own?.size).toBe(1)
    unsubscribe()
    expect(trie.find(x)).toBeUndefined()
    expect(trie.find(outer)).toBeUndefined()

    trie.listenOwn(x, () => {})
    unsubscribe()
    expect(trie.find(x)?.own?.size).toBe(1)
  })

  it("scope skips subtrees nobody watches", () => {
    const trie = new SubscriberTrie()
    trie.markPopulated(outer.field("y"), "none")
    trie.listenDeep(x, () => {})
    const root = trie.find(RawPath.empty)
    if (root === undefined) throw new Error("no root")
    expect(trie.scope(root, "all").map(([, rel]) => rel.length)).toEqual([1, 2])
  })

  it("populated covers an op's path, its ancestors, and what it rewrote", () => {
    const trie = new SubscriberTrie()
    trie.markPopulated(x, "none")
    expect(trie.isPopulated(x)).toBe(true)
    expect(trie.isPopulated(outer)).toBe(true)
    expect(trie.isPopulated(outer.field("y"))).toBe(false)

    trie.markPopulated(m, { keys: ["k"] })
    expect(trie.isPopulated(m.entry("k").field("n"))).toBe(true)
    expect(trie.isPopulated(m.entry("j"))).toBe(false)

    trie.markPopulated(outer, "all")
    expect(trie.isPopulated(outer.field("y").field("z"))).toBe(true)
  })

  it("fires a population listener once, when a rewrite above reaches it", () => {
    const trie = new SubscriberTrie()
    let fired = 0
    trie.listenPopulated(x, () => {
      fired++
    })
    trie.markPopulated(outer, "all")
    trie.markPopulated(outer, "all")
    expect(fired).toBe(1)
    expect(trie.find(x)?.watchers).toBe(0)
  })

  it("after a whole-document adopt, a deeper mark creates no node", () => {
    const trie = new SubscriberTrie()
    trie.markPopulated(RawPath.empty, "all")
    const before = countBelow(trie.root)
    trie.markPopulated(m.entry("k").field("n"), "all")
    trie.markPopulated(x, { keys: ["y"] })
    expect(countBelow(trie.root)).toBe(before)
    expect(trie.isPopulated(m.entry("k").field("n"))).toBe(true)
  })

  it("holdsAt sees a listener of each kind at or below a path, and ignores a populated mark", () => {
    const trie = new SubscriberTrie()
    trie.markPopulated(x, "all")
    expect(trie.holdsAt(outer)).toBe(false)
    for (const listen of [
      () => trie.listenOwn(x, () => {}),
      () => trie.listenDeep(x, () => {}),
      () => trie.listenPopulated(outer.field("z"), () => {}),
    ]) {
      const unsubscribe = listen()
      expect(trie.holdsAt(outer)).toBe(true)
      expect(trie.holdsAt(m)).toBe(false)
      unsubscribe()
      expect(trie.holdsAt(outer)).toBe(false)
    }
  })
})

describe("a list's items are populated exactly when the list is", () => {
  it("a mark through a list item stops before the item, and populates the list", () => {
    const trie = new SubscriberTrie()
    trie.markPopulated(list.item(3).field("title"), "none")
    expect(trie.find(list)?.populated).toBe(true)
    expect(trie.find(list.item(3))).toBeUndefined()
    expect(trie.isPopulated(list.item(7).field("title"))).toBe(true)
  })

  it("no item is populated while its list is not", () => {
    const trie = new SubscriberTrie()
    trie.markPopulated(outer, "none")
    expect(trie.isPopulated(list.item(0))).toBe(false)
  })

  it("populating a list fires the listeners at and below its items, once", () => {
    const trie = new SubscriberTrie()
    const fired: string[] = []
    trie.listenPopulated(list.item(0), () => fired.push("item"))
    trie.listenPopulated(list.item(1).field("title"), () => fired.push("title"))
    trie.markPopulated(list, "none")
    trie.markPopulated(list, "none")
    expect(fired.sort()).toEqual(["item", "title"])
    expect(trie.find(list.item(0))).toBeUndefined()
    expect(trie.find(list.item(1))).toBeUndefined()
  })
})
