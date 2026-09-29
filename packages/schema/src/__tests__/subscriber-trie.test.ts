// SubscriberTrie — subscribers and population state, one node per coordinate.
import { describe, expect, it } from "vitest"
import { SubscriberTrie } from "../interpreters/subscriber-trie.js"
import { RawPath } from "../path.js"

const outer = RawPath.empty.field("outer")
const x = outer.field("x")
const m = RawPath.empty.field("m")

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
})
