// plan-delivery — the functional core of the notification pipeline.
//
// `planDelivery` walks a flush's ops once and answers both channels:
//   - own-path: what changed at exactly this node
//   - deep:     what changed anywhere in this node's subtree, rebased
//
// The own-path cases below came from the old `planNotifications` suite and are
// unchanged in substance: a node's own path is a single key, so grouping there
// works the same as it always did. The deep block is new — the old planner did
// no ancestor work at all, so none of it had functional-core coverage.

import { describe, expect, it } from "vitest"
import type { Op } from "../index.js"
import { planDelivery } from "../interpreters/with-changefeed.js"
import type { Path } from "../path.js"
import { RawPath } from "../path.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an Op from a path and change type string. */
function pc(path: Path, type: string): Op {
  return { path, change: { type } }
}

/** A KeySet matching every key — "everyone is listening everywhere". */
const ALL = { has: () => true }
/** A KeySet matching nothing — "nobody is listening". */
const NONE = { has: () => false }
/** A KeySet matching exactly the given keys. */
const only = (...keys: string[]) => new Set(keys)

/** Plan with own-path subscribers everywhere, deep subscribers nowhere. */
const planOwn = (pending: readonly Op[]) => planDelivery(pending, ALL, NONE)

/** Render a deep buffer as `relativePath:changeType` strings, in order. */
const shape = (ops: readonly Op[] | undefined) =>
  (ops ?? []).map(op => `${op.path.format()}:${op.change.type}`)

// ---------------------------------------------------------------------------
// Table-driven tests — mirrors the planCacheUpdate pattern
// ---------------------------------------------------------------------------

describe("planDelivery: own-path channel", () => {
  it("empty pending → empty own-path map", () => {
    const plan = planOwn([])
    expect(plan.ownPath.size).toBe(0)
  })

  it("single change → single group with 1 entry", () => {
    const path = RawPath.empty.field("title")
    const plan = planOwn([pc(path, "text")])

    expect(plan.ownPath.size).toBe(1)
    expect(plan.ownPath.get(path.key)).toEqual([{ type: "text" }])
  })

  it("two changes at the same path → single group with 2 entries", () => {
    const path = RawPath.empty.field("x")
    const plan = planOwn([pc(path, "replace"), pc(path, "replace")])

    expect(plan.ownPath.size).toBe(1)
    const changes = plan.ownPath.get(path.key) as any
    expect(changes).toHaveLength(2)
    expect(changes[0]?.type).toBe("replace")
    expect(changes[1]?.type).toBe("replace")
  })

  it("three changes at two paths → two groups", () => {
    const pathX = RawPath.empty.field("x")
    const pathY = RawPath.empty.field("y")
    const plan = planOwn([
      pc(pathX, "replace"),
      pc(pathY, "replace"),
      pc(pathX, "replace"),
    ])

    expect(plan.ownPath.size).toBe(2)
    expect(plan.ownPath.get(pathX.key)).toHaveLength(2)
    expect(plan.ownPath.get(pathY.key)).toHaveLength(1)
  })

  it("preserves change ordering within a group", () => {
    const path = RawPath.empty.field("counter")
    const plan = planOwn([
      pc(path, "increment"),
      pc(path, "replace"),
      pc(path, "increment"),
    ])

    const changes = plan.ownPath.get(path.key) as any
    expect(changes).toHaveLength(3)
    expect(changes[0]?.type).toBe("increment")
    expect(changes[1]?.type).toBe("replace")
    expect(changes[2]?.type).toBe("increment")
  })

  it("nested paths are grouped independently", () => {
    const settingsPath = RawPath.empty.field("settings")
    const darkModePath = RawPath.empty.field("settings").field("darkMode")
    const fontSizePath = RawPath.empty.field("settings").field("fontSize")

    const plan = planOwn([
      pc(darkModePath, "replace"),
      pc(fontSizePath, "replace"),
      pc(settingsPath, "map"),
    ])

    expect(plan.ownPath.size).toBe(3)
    expect(plan.ownPath.get(settingsPath.key)).toHaveLength(1)
    expect(plan.ownPath.get(darkModePath.key)).toHaveLength(1)
    expect(plan.ownPath.get(fontSizePath.key)).toHaveLength(1)
  })

  it("index path segments produce distinct keys", () => {
    const path0 = RawPath.empty.field("items").item(0)
    const path1 = RawPath.empty.field("items").item(1)

    const plan = planOwn([
      pc(path0, "replace"),
      pc(path1, "replace"),
      pc(path0, "replace"),
    ])

    expect(plan.ownPath.size).toBe(2)
    expect(plan.ownPath.get(path0.key)).toHaveLength(2)
    expect(plan.ownPath.get(path1.key)).toHaveLength(1)
  })

  it("root path (empty) is a valid group key", () => {
    const rootPath = RawPath.empty
    const childPath = RawPath.empty.field("x")

    const plan = planOwn([pc(rootPath, "map"), pc(childPath, "replace")])

    expect(plan.ownPath.size).toBe(2)
    expect(plan.ownPath.get(rootPath.key)).toHaveLength(1)
    expect(plan.ownPath.get(childPath.key)).toHaveLength(1)
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

    const plan = planOwn(pending)
    expect(plan.ownPath.size).toBe(5)
    for (const path of paths) {
      expect(plan.ownPath.get(path.key)).toHaveLength(3)
    }
  })
})

describe("planDelivery: immutability", () => {
  it("does not mutate the input array", () => {
    const path = RawPath.empty.field("x")
    const input: Op[] = [pc(path, "replace")]
    const copy = [...input]

    planOwn(input)

    expect(input).toEqual(copy)
  })

  it("returns a new map each time", () => {
    const path = RawPath.empty.field("x")
    const input = [pc(path, "replace")]

    const plan1 = planOwn(input)
    const plan2 = planOwn(input)

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
    const plan = planOwn([{ path, change }])

    const changes = plan.ownPath.get(path.key) as any
    expect(changes).toHaveLength(1)
    expect(changes[0]).toBe(change) // Same reference — no cloning
  })

  // The no-copying property has a wider blast radius now that one flush can
  // reach a change from several buffers at once. It is a statement about the
  // *planner*: it groups and rebases, it does not duplicate. Ownership is
  // settled before the planner ever sees a change — `own` at construction,
  // `ownedForStore` at the store boundary — so a consumer may hold a delivered
  // op indefinitely.
  it("shares one change object between the own-path and deep buffers", () => {
    const path = RawPath.empty.field("settings").field("dark")
    const change = { type: "replace" as const, value: true }
    const plan = planDelivery([{ path, change }], ALL, ALL)

    const own = plan.ownPath.get(path.key) as any
    const deep = plan.deep.get(RawPath.empty.key) as any
    expect(own[0]).toBe(change)
    expect(deep[0]?.change).toBe(change)
  })
})

// ---------------------------------------------------------------------------
// Deep channel — the ancestor accumulation the old planner never did
// ---------------------------------------------------------------------------

describe("planDelivery: deep channel", () => {
  const abc = RawPath.empty.field("a").field("b").field("c")

  it("one op reaches every ancestor, each at its own relative path", () => {
    const plan = planDelivery([pc(abc, "replace")], NONE, ALL)

    expect(plan.deep.size).toBe(4)
    expect(shape(plan.deep.get(RawPath.empty.key))).toEqual(["a.b.c:replace"])
    expect(shape(plan.deep.get(RawPath.empty.field("a").key))).toEqual([
      "b.c:replace",
    ])
    expect(
      shape(plan.deep.get(RawPath.empty.field("a").field("b").key)),
    ).toEqual(["c:replace"])
    // At the changed node itself the relative path is empty, which `format()`
    // renders as "root".
    expect(shape(plan.deep.get(abc.key))).toEqual(["root:replace"])
  })

  it("two ops under a common ancestor merge into one buffer, in dispatch order", () => {
    const x = RawPath.empty.field("outer").field("x")
    const y = RawPath.empty.field("outer").field("y")
    const plan = planDelivery([pc(x, "replace"), pc(y, "text")], NONE, ALL)

    expect(shape(plan.deep.get(RawPath.empty.field("outer").key))).toEqual([
      "x:replace",
      "y:text",
    ])
  })

  it("dispatch order survives an ancestor write straddling two descendant writes", () => {
    // Grouping by path would float the ancestor write past both descendant
    // writes, and replaying that order reaches a different state than the
    // writes produced. This is the case that rules out grouping.
    const outer = RawPath.empty.field("outer")
    const x = outer.field("x")
    const plan = planDelivery(
      [pc(x, "replace"), pc(outer, "map"), pc(x, "replace")],
      NONE,
      ALL,
    )

    expect(shape(plan.deep.get(RawPath.empty.key))).toEqual([
      "outer.x:replace",
      "outer:map",
      "outer.x:replace",
    ])
  })

  it("own-path and descendant changes land in one buffer at the subscriber", () => {
    const outer = RawPath.empty.field("outer")
    const plan = planDelivery(
      [pc(outer, "map"), pc(outer.field("x"), "replace")],
      NONE,
      only(outer.key),
    )

    expect(shape(plan.deep.get(outer.key))).toEqual(["root:map", "x:replace"])
  })

  it("deepOrder is deepest-first", () => {
    const plan = planDelivery([pc(abc, "replace")], NONE, ALL)

    expect(plan.deepOrder).toEqual([
      abc.key,
      RawPath.empty.field("a").field("b").key,
      RawPath.empty.field("a").key,
      RawPath.empty.key,
    ])
  })

  it("subscribers at equal depth keep first-touch order", () => {
    // Both are depth 1, so the depth sort cannot separate them. Insertion
    // order decides, which requires `sort` to be stable.
    const first = RawPath.empty.field("zebra")
    const second = RawPath.empty.field("alpha")
    const plan = planDelivery(
      [pc(first, "replace"), pc(second, "replace")],
      NONE,
      only(first.key, second.key),
    )

    expect(plan.deepOrder).toEqual([first.key, second.key])
  })

  it("allocates no buffer for a key nobody is subscribed at", () => {
    const plan = planDelivery([pc(abc, "replace")], NONE, only(abc.key))

    expect(plan.deep.size).toBe(1)
    expect(plan.deep.has(RawPath.empty.key)).toBe(false)
  })

  it("no deep subscribers → no deep work at all", () => {
    const plan = planDelivery([pc(abc, "replace")], ALL, NONE)

    expect(plan.deep.size).toBe(0)
    expect(plan.deepOrder).toEqual([])
    expect(plan.ownPath.size).toBe(1)
  })
})
