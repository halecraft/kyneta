// plan-delivery — the functional core of the notification pipeline.
//
// `planDelivery` walks a flush's ops once and answers both channels:
//   - own-path: what changed at exactly this coordinate
//   - deep:     what changed anywhere in this coordinate's subtree, rebased
// and walks each op both ways: up through its ancestors, and down through the
// part of the tree it rewrote, where subscribers receive it projected.

import { describe, expect, it } from "vitest"
import type { ChangeBase } from "../change.js"
import {
  mapChange,
  replaceChange,
  treeChange,
  trustAsOwned,
} from "../change.js"
import { type DeliveryPlan, planDelivery } from "../delivery.js"
import type { Op } from "../index.js"
import type { SubscriberNode } from "../interpreters/subscriber-trie.js"
import { SubscriberTrie } from "../interpreters/subscriber-trie.js"
import type { Path } from "../path.js"
import { RawPath } from "../path.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an Op from a path and a change whose type rewrites nothing below. */
function pc(path: RawPath, type: string): Op {
  return { path, change: { type } }
}

/** Plan raw ops, each prepared at its own path. */
function planOps(pending: readonly Op[], trie: SubscriberTrie): DeliveryPlan {
  return planDelivery(
    pending.map(op => ({ op, at: op.path })),
    trie,
  )
}

/** A trie with own-path and deep subscribers at the given paths. */
function subscribers(opts: {
  own?: readonly Path[]
  deep?: readonly Path[]
}): SubscriberTrie {
  const trie = new SubscriberTrie()
  for (const path of opts.own ?? []) trie.listenOwn(path, () => {})
  for (const path of opts.deep ?? []) trie.listenDeep(path, () => {})
  return trie
}

/** The own-path buffer planned for `path`. */
function ownAt(plan: DeliveryPlan, trie: SubscriberTrie, path: Path) {
  const node = trie.find(path)
  return node === undefined ? undefined : plan.ownPath.get(node)
}

/** The deep buffer planned for `path`. */
function deepAt(plan: DeliveryPlan, trie: SubscriberTrie, path: Path) {
  const node = trie.find(path)
  return node === undefined ? undefined : plan.deep.get(node)
}

/** Plan with own-path subscribers at `paths` and no deep subscribers. */
function planOwn(pending: readonly Op[], paths: readonly Path[]) {
  const trie = subscribers({ own: paths })
  return { trie, plan: planOps(pending, trie) }
}

/** Render a deep buffer as `relativePath:changeType` strings, in order. */
const shape = (ops: readonly Op[] | undefined) =>
  (ops ?? []).map(op => `${op.path.format()}:${op.change.type}`)

const nodeOf = (trie: SubscriberTrie, path: Path): SubscriberNode => {
  const node = trie.find(path)
  if (node === undefined) throw new Error(`no node at ${path.format()}`)
  return node
}

// ---------------------------------------------------------------------------
// Table-driven tests — mirrors the planCacheUpdate pattern
// ---------------------------------------------------------------------------

describe("planDelivery: own-path channel", () => {
  it("empty pending → empty own-path map", () => {
    const { plan } = planOwn([], [RawPath.empty])
    expect(plan.ownPath.size).toBe(0)
  })

  it("single change → single group with 1 entry", () => {
    const path = RawPath.empty.field("title")
    const { trie, plan } = planOwn([pc(path, "text")], [path])

    expect(plan.ownPath.size).toBe(1)
    expect(ownAt(plan, trie, path)).toEqual([{ type: "text" }])
  })

  it("two changes at the same path → single group with 2 entries", () => {
    const path = RawPath.empty.field("x")
    const { trie, plan } = planOwn(
      [pc(path, "replace"), pc(path, "replace")],
      [path],
    )

    expect(plan.ownPath.size).toBe(1)
    const changes = ownAt(plan, trie, path) as any
    expect(changes).toHaveLength(2)
    expect(changes[0]?.type).toBe("replace")
    expect(changes[1]?.type).toBe("replace")
  })

  it("three changes at two paths → two groups", () => {
    const pathX = RawPath.empty.field("x")
    const pathY = RawPath.empty.field("y")
    const { trie, plan } = planOwn(
      [pc(pathX, "replace"), pc(pathY, "replace"), pc(pathX, "replace")],
      [pathX, pathY],
    )

    expect(plan.ownPath.size).toBe(2)
    expect(ownAt(plan, trie, pathX)).toHaveLength(2)
    expect(ownAt(plan, trie, pathY)).toHaveLength(1)
  })

  it("preserves change ordering within a group", () => {
    const path = RawPath.empty.field("counter")
    const { trie, plan } = planOwn(
      [pc(path, "increment"), pc(path, "replace"), pc(path, "increment")],
      [path],
    )

    const changes = ownAt(plan, trie, path) as any
    expect(changes).toHaveLength(3)
    expect(changes[0]?.type).toBe("increment")
    expect(changes[1]?.type).toBe("replace")
    expect(changes[2]?.type).toBe("increment")
  })

  it("nested paths are grouped independently", () => {
    const settingsPath = RawPath.empty.field("settings")
    const darkModePath = RawPath.empty.field("settings").field("darkMode")
    const fontSizePath = RawPath.empty.field("settings").field("fontSize")

    const { trie, plan } = planOwn(
      [
        pc(darkModePath, "replace"),
        pc(fontSizePath, "replace"),
        pc(settingsPath, "map"),
      ],
      [settingsPath, darkModePath, fontSizePath],
    )

    expect(plan.ownPath.size).toBe(3)
    expect(ownAt(plan, trie, settingsPath)).toHaveLength(1)
    expect(ownAt(plan, trie, darkModePath)).toHaveLength(1)
    expect(ownAt(plan, trie, fontSizePath)).toHaveLength(1)
  })

  it("index path segments are distinct coordinates", () => {
    const path0 = RawPath.empty.field("items").item(0)
    const path1 = RawPath.empty.field("items").item(1)

    const { trie, plan } = planOwn(
      [pc(path0, "replace"), pc(path1, "replace"), pc(path0, "replace")],
      [path0, path1],
    )

    expect(plan.ownPath.size).toBe(2)
    expect(ownAt(plan, trie, path0)).toHaveLength(2)
    expect(ownAt(plan, trie, path1)).toHaveLength(1)
  })

  it("the root is a coordinate like any other", () => {
    const rootPath = RawPath.empty
    const childPath = RawPath.empty.field("x")

    const { trie, plan } = planOwn(
      [pc(rootPath, "map"), pc(childPath, "replace")],
      [rootPath, childPath],
    )

    expect(plan.ownPath.size).toBe(2)
    expect(ownAt(plan, trie, rootPath)).toHaveLength(1)
    expect(ownAt(plan, trie, childPath)).toHaveLength(1)
  })

  it("many changes to many paths group correctly", () => {
    const paths = Array.from({ length: 5 }, (_, i) =>
      RawPath.empty.field(`field${i}`),
    )
    const pending: Op[] = []
    // 3 changes per path = 15 total
    for (let round = 0; round < 3; round++) {
      for (const path of paths) {
        pending.push(pc(path, "replace"))
      }
    }

    const { trie, plan } = planOwn(pending, paths)
    expect(plan.ownPath.size).toBe(5)
    for (const path of paths) {
      expect(ownAt(plan, trie, path)).toHaveLength(3)
    }
  })
})

describe("planDelivery: immutability", () => {
  it("does not mutate the input array", () => {
    const path = RawPath.empty.field("x")
    const input: Op[] = [pc(path, "replace")]
    const copy = [...input]

    planOwn(input, [path])

    expect(input).toEqual(copy)
  })

  it("returns a new map each time", () => {
    const path = RawPath.empty.field("x")
    const input = [pc(path, "replace")]

    const trie = subscribers({ own: [path] })
    const plan1 = planOps(input, trie)
    const plan2 = planOps(input, trie)

    expect(plan1.ownPath).not.toBe(plan2.ownPath)
  })
})

describe("planDelivery: change data integrity", () => {
  it("preserves full change objects (not just type)", () => {
    const path = RawPath.empty.field("items")
    const change = {
      type: "sequence" as const,
      ops: [{ retain: 2 }, { insert: ["a", "b"] }],
    }
    const { trie, plan } = planOwn([{ path, change }], [path])

    const changes = ownAt(plan, trie, path) as any
    expect(changes).toHaveLength(1)
    expect(changes[0]).toBe(change) // Same reference — no cloning
  })

  // The no-copying property has a wider blast radius now that one flush can
  // reach a change from several buffers at once. It is a statement about the
  // *planner*: it groups and rebases, it does not duplicate. Ownership is
  // settled before the planner ever sees a change — `own` at construction,
  // `freezePayload` at the store boundary — so a consumer may hold a delivered
  // op indefinitely.
  it("shares one change object between the own-path and deep buffers", () => {
    const path = RawPath.empty.field("settings").field("dark")
    const change = { type: "replace" as const, value: true }
    const trie = subscribers({ own: [path], deep: [RawPath.empty] })
    const plan = planOps([{ path, change }], trie)

    const own = ownAt(plan, trie, path) as any
    const deep = deepAt(plan, trie, RawPath.empty) as any
    expect(own[0]).toBe(change)
    expect(deep[0]?.change).toBe(change)
  })
})

// ---------------------------------------------------------------------------
// Deep channel — the ancestor accumulation the old planner never did
// ---------------------------------------------------------------------------

describe("planDelivery: deep channel", () => {
  const a = RawPath.empty.field("a")
  const ab = a.field("b")
  const abc = ab.field("c")
  const chain = [RawPath.empty, a, ab, abc]

  it("one op reaches every ancestor, each at its own relative path", () => {
    const trie = subscribers({ deep: chain })
    const plan = planOps([pc(abc, "replace")], trie)

    expect(plan.deep.size).toBe(4)
    expect(shape(deepAt(plan, trie, RawPath.empty))).toEqual(["a.b.c:replace"])
    expect(shape(deepAt(plan, trie, a))).toEqual(["b.c:replace"])
    expect(shape(deepAt(plan, trie, ab))).toEqual(["c:replace"])
    // At the changed node itself the relative path is empty, which `format()`
    // renders as "root".
    expect(shape(deepAt(plan, trie, abc))).toEqual(["root:replace"])
  })

  it("two ops under a common ancestor merge into one buffer, in dispatch order", () => {
    const outer = RawPath.empty.field("outer")
    const trie = subscribers({ deep: [outer] })
    const plan = planOps(
      [pc(outer.field("x"), "replace"), pc(outer.field("y"), "text")],
      trie,
    )

    expect(shape(deepAt(plan, trie, outer))).toEqual(["x:replace", "y:text"])
  })

  it("dispatch order survives an ancestor write straddling two descendant writes", () => {
    // Grouping by path would float the ancestor write past both descendant
    // writes, and replaying that order reaches a different state than the
    // writes produced. This is the case that rules out grouping.
    const outer = RawPath.empty.field("outer")
    const x = outer.field("x")
    const trie = subscribers({ deep: [RawPath.empty] })
    const plan = planOps(
      [pc(x, "replace"), pc(outer, "map"), pc(x, "replace")],
      trie,
    )

    expect(shape(deepAt(plan, trie, RawPath.empty))).toEqual([
      "outer.x:replace",
      "outer:map",
      "outer.x:replace",
    ])
  })

  it("own-path and descendant changes land in one buffer at the subscriber", () => {
    const outer = RawPath.empty.field("outer")
    const trie = subscribers({ deep: [outer] })
    const plan = planOps(
      [pc(outer, "map"), pc(outer.field("x"), "replace")],
      trie,
    )

    expect(shape(deepAt(plan, trie, outer))).toEqual(["root:map", "x:replace"])
  })

  it("deepOrder is deepest-first", () => {
    const trie = subscribers({ deep: chain })
    const plan = planOps([pc(abc, "replace")], trie)

    expect(plan.deepOrder).toEqual(
      [abc, ab, a, RawPath.empty].map(path => nodeOf(trie, path)),
    )
  })

  it("subscribers at equal depth keep first-touch order", () => {
    // Both are depth 1, so the depth sort cannot separate them. Insertion
    // order decides, which requires `sort` to be stable.
    const first = RawPath.empty.field("zebra")
    const second = RawPath.empty.field("alpha")
    const trie = subscribers({ deep: [second, first] })
    const plan = planOps([pc(first, "replace"), pc(second, "replace")], trie)

    expect(plan.deepOrder).toEqual([nodeOf(trie, first), nodeOf(trie, second)])
  })

  it("allocates no buffer for a coordinate nobody is subscribed at", () => {
    const trie = subscribers({ deep: [abc] })
    const plan = planOps([pc(abc, "replace")], trie)

    expect(plan.deep.size).toBe(1)
    expect(deepAt(plan, trie, abc)).toBeDefined()
  })

  it("no deep subscribers → no deep work at all", () => {
    const trie = subscribers({ own: [abc] })
    const plan = planOps([pc(abc, "replace")], trie)

    expect(plan.deep.size).toBe(0)
    expect(plan.deepOrder).toEqual([])
    expect(plan.ownPath.size).toBe(1)
  })

  it("two coordinates whose joined keys collide stay apart", () => {
    const tricky = RawPath.empty.field("a\0b")
    expect(tricky.key).toBe(ab.key)
    const trie = subscribers({ deep: [tricky, ab] })
    const plan = planOps([pc(ab, "text")], trie)

    expect(shape(deepAt(plan, trie, ab))).toEqual(["root:text"])
    expect(deepAt(plan, trie, tricky)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Down — a coarse change reaches the subscribers inside what it rewrote
// ---------------------------------------------------------------------------

describe("planDelivery: the rewritten scope", () => {
  const roster = RawPath.empty.field("roster")
  const alice = roster.entry("alice")
  const aliceCursor = alice.field("cursor")
  const bob = roster.entry("bob")

  const projected = (ops: readonly Op[] | undefined): ChangeBase[] =>
    (ops ?? []).map(op => op.change)

  it("a replace reaches every subscriber below it, with its value there", () => {
    const outer = RawPath.empty.field("outer")
    const x = outer.field("x")
    const trie = subscribers({ own: [x], deep: [x] })
    const change = replaceChange(trustAsOwned({ x: 1, y: 2 }))
    const plan = planOps([{ path: outer, change }], trie)

    expect(ownAt(plan, trie, x)).toEqual([replaceChange(1)])
    expect(shape(deepAt(plan, trie, x))).toEqual(["root:replace"])
    expect(projected(deepAt(plan, trie, x))).toEqual([replaceChange(1)])
  })

  it("a map set reaches the keys it writes and not their siblings", () => {
    const trie = subscribers({ deep: [aliceCursor, bob] })
    const change = mapChange(trustAsOwned({ alice: { cursor: 5 } }))
    const plan = planOps([{ path: roster, change }], trie)

    expect(projected(deepAt(plan, trie, aliceCursor))).toEqual([
      replaceChange(5),
    ])
    expect(deepAt(plan, trie, bob)).toBeUndefined()
  })

  it("a removed key is replaced with undefined", () => {
    const trie = subscribers({ own: [alice], deep: [aliceCursor] })
    const plan = planOps(
      [{ path: roster, change: mapChange(undefined, ["alice"]) }],
      trie,
    )

    expect(ownAt(plan, trie, alice)).toEqual([replaceChange(undefined)])
    expect(projected(deepAt(plan, trie, aliceCursor))).toEqual([
      replaceChange(undefined),
    ])
  })

  it("a list item inside a rewrite has no correspondence, and is removed", () => {
    const items = RawPath.empty.field("items")
    const item = items.item(0)
    const trie = subscribers({ deep: [item] })
    const change = replaceChange(trustAsOwned(["new"]))
    const plan = planOps([{ path: items, change }], trie)

    expect(projected(deepAt(plan, trie, item))).toEqual([
      replaceChange(undefined),
    ])
  })

  it("a deleted tree node receives the tree-delete terminal", () => {
    const tree = RawPath.empty.field("tree")
    const node = tree.node("n1")
    const label = node.field("label")
    const trie = subscribers({ deep: [tree, node, label] })
    const change = treeChange([{ action: "delete", target: "n1" }])
    const plan = planOps([{ path: tree, change }], trie)

    expect(projected(deepAt(plan, trie, tree))).toEqual([change])
    expect(projected(deepAt(plan, trie, node))).toEqual([
      treeChange([{ action: "delete", target: "n1" }]),
    ])
    expect(projected(deepAt(plan, trie, label))).toEqual([
      replaceChange(undefined),
    ])
  })

  it("a change that rewrites nothing below reaches nobody below", () => {
    const outer = RawPath.empty.field("outer")
    const trie = subscribers({ deep: [outer.field("x")] })
    const plan = planOps([pc(outer, "text")], trie)

    expect(plan.deep.size).toBe(0)
  })

  it("a subscriber hears projections and its own ops in dispatch order", () => {
    const trie = subscribers({ deep: [alice] })
    const plan = planOps(
      [
        { path: aliceCursor, change: replaceChange(1) },
        {
          path: roster,
          change: mapChange(trustAsOwned({ alice: { cursor: 2 } })),
        },
      ],
      trie,
    )

    expect(shape(deepAt(plan, trie, alice))).toEqual([
      "cursor:replace",
      "root:replace",
    ])
  })
})
