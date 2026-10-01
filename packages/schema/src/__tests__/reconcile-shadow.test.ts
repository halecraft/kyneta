// reconcile-shadow — σ brought up to date from λ where a change touched it.
import { describe, expect, it } from "vitest"
import { deepClonePlain, isDeeplyFrozen } from "../clone.js"
import {
  createMaterializeInterpreter,
  mapChange,
  own,
  plainValueResolver,
  Schema,
} from "../index.js"
import type { Touched } from "../landing.js"
import { RawPath } from "../path.js"
import {
  planReconcile,
  type ReconcileTarget,
  reconcileShadow,
} from "../reconcile-shadow.js"
import type { SubtreeEffect } from "../subtree-effect.js"

const Point = Schema.struct({ x: Schema.number(), y: Schema.number() })

const Doc = Schema.struct({
  title: Schema.text(),
  settings: Schema.struct({ dark: Schema.boolean(), font: Schema.number() }),
  rows: Schema.record(
    Schema.struct({ body: Schema.text(), n: Schema.number() }),
  ),
  shape: Schema.discriminatedUnion("kind", [
    Schema.struct({ kind: Schema.string("circle"), radius: Schema.number() }),
    Schema.struct({ kind: Schema.string("square"), side: Schema.number() }),
  ]),
  blob: Schema.struct.json({ x: Schema.number() }),
  items: Schema.list(Point),
  tree: Schema.tree(Schema.struct({ label: Schema.string() })),
  optional: Schema.record(Point.nullable()),
  room: Schema.struct({ x: Schema.number() }).decay(1000),
  presence: Schema.record(
    Schema.struct({ cursor: Schema.number() }).decay(1000),
  ),
})

const at = (...segments: (string | number)[]): RawPath => {
  let path = RawPath.empty
  for (const segment of segments) {
    path =
      typeof segment === "number"
        ? path.item(segment)
        : segment.startsWith(":")
          ? path.entry(segment.slice(1))
          : path.field(segment)
  }
  return path
}

const touch = (path: RawPath, effect: SubtreeEffect): Touched => ({
  path,
  effect,
})

/** Each target as `[path, keys?]`. */
const described = (targets: readonly ReconcileTarget[]) =>
  targets.map(target =>
    target.keys === undefined
      ? [target.path.format()]
      : [target.path.format(), target.keys],
  )

describe("planReconcile", () => {
  it.each<[string, readonly Touched[], unknown[]]>([
    ["a text op names its node", [touch(at("title"), "none")], [["title"]]],
    [
      "a record set of two keys gives one target with both keys",
      [touch(at("rows"), { keys: ["a", "b"] })],
      [["rows", ["a", "b"]]],
    ],
    [
      "a struct field write gives a target at its field",
      [touch(at("settings"), { keys: ["dark"] })],
      [["settings.dark"]],
    ],
    [
      "a replace names its node",
      [touch(at("settings"), "all")],
      [["settings"]],
    ],
    [
      "a tree delete names the tree",
      [touch(at("tree"), { keys: ["n1"] })],
      [["tree"]],
    ],
    [
      "an op inside a sum lifts to the sum",
      [touch(at("shape", "radius"), "all")],
      [["shape"]],
    ],
    [
      "an op inside a .json() node lifts to it",
      [touch(at("blob", "x"), "all")],
      [["blob"]],
    ],
    [
      "an op under a decaying container lifts to it",
      [touch(at("room", "x"), "all")],
      [["room"]],
    ],
    [
      "a record entry becomes its record, keyed",
      [touch(at("rows", ":a"), "all")],
      [["rows", ["a"]]],
    ],
    [
      "a lift that lands on an entry becomes its record, keyed (a sum)",
      [touch(at("optional", ":a", "x"), "all")],
      [["optional", ["a"]]],
    ],
    [
      "a lift that lands on an entry becomes its record, keyed (decay)",
      [touch(at("presence", ":alice", "cursor"), "all")],
      [["presence", ["alice"]]],
    ],
    [
      "a keyed target covers what is below its key, and keys merge",
      [
        touch(at("rows", ":a", "body"), "none"),
        touch(at("rows"), { keys: ["a"] }),
        touch(at("rows", ":b"), "all"),
        touch(at("rows", ":c", "n"), "all"),
      ],
      [["rows", ["a", "b"]], ["rows.c.n"]],
    ],
    [
      "a node target covers everything below it",
      [
        touch(at("settings", "dark"), "all"),
        touch(at("settings"), "all"),
        touch(at("items", 3, "x"), "all"),
        touch(at("items"), "none"),
      ],
      [["settings"], ["items"]],
    ],
    [
      "a root touch gives one root target",
      [touch(at("title"), "none"), touch(RawPath.empty, "all")],
      [["root"]],
    ],
    [
      "a path that does not fit is refreshed at the prefix that does",
      [touch(at("settings", "nope"), "all")],
      [["settings"]],
    ],
  ])("%s", (_name, touched, expected) => {
    expect(described(planReconcile(Doc, touched))).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// reconcileShadow, over a plain value standing in for λ
// ---------------------------------------------------------------------------

const Rows = Schema.struct({
  settings: Schema.struct({ dark: Schema.boolean(), font: Schema.number() }),
  rows: Schema.record(
    Schema.struct({ body: Schema.text(), n: Schema.number() }),
  ),
})

function shadowOf() {
  return {
    settings: { dark: false, font: 12 },
    rows: {
      a: { body: "hello", n: 1 },
      b: { body: "bye", n: 2 },
    },
  }
}

function reconcile(
  shadow: Record<string, unknown>,
  lambda: unknown,
  touched: readonly Touched[],
) {
  const resolver = plainValueResolver(lambda)
  return reconcileShadow(
    { current: shadow },
    planReconcile(Rows, touched),
    resolver,
    createMaterializeInterpreter(resolver),
  )
}

describe("reconcileShadow", () => {
  it("a changed field leaves every other σ object as it was", () => {
    const shadow = shadowOf()
    const before = { ...shadow, rows: shadow.rows }
    const lambda = deepClonePlain(shadow)
    lambda.rows.a.body = "hello world"

    const ops = reconcile(shadow, lambda, [
      touch(at("rows", ":a", "body"), "none"),
    ])

    expect(ops.map(op => op.path.format())).toEqual(["rows.a.body"])
    expect(shadow.rows.a.body).toBe("hello world")
    expect(shadow.rows).toBe(before.rows)
    expect(shadow.rows.b).toBe(before.rows.b)
    expect(shadow.settings).toBe(before.settings)
  })

  it("an entry λ dropped and one it gained are one map change", () => {
    const shadow = shadowOf()
    const a = shadow.rows.a
    const lambda = deepClonePlain(shadow) as {
      rows: Record<string, unknown>
    }
    delete lambda.rows.b
    lambda.rows.c = { body: "new", n: 3 }

    const ops = reconcile(shadow, lambda, [
      touch(at("rows"), { keys: ["b", "c"] }),
    ])

    expect(ops.map(op => [op.path.format(), op.change])).toEqual([
      ["rows", mapChange(own({ c: { body: "new", n: 3 } }), ["b"])],
    ])
    expect(shadow.rows).toEqual({
      a: { body: "hello", n: 1 },
      c: { body: "new", n: 3 },
    })
    expect(shadow.rows.a).toBe(a)
  })

  it("the ops it returns share their values with σ, frozen, and nothing with λ", () => {
    const shadow = shadowOf()
    const lambda = deepClonePlain(shadow) as {
      rows: Record<string, unknown>
    }
    lambda.rows.c = { body: "new", n: 3 }
    const [op] = reconcile(shadow, lambda, [touch(at("rows", ":c"), "all")])
    const set = (op?.change as { set?: Record<string, unknown> }).set
    expect(set?.c).toBe((shadow.rows as Record<string, unknown>).c)
    expect(set?.c).not.toBe(lambda.rows.c)
    expect(isDeeplyFrozen(set?.c)).toBe(true)
  })

  it("a root target re-materializes the document", () => {
    const shadow = shadowOf()
    const lambda = deepClonePlain(shadow)
    lambda.settings.dark = true
    const ops = reconcile(shadow, lambda, [touch(RawPath.empty, "all")])
    expect(ops.map(op => op.path.format())).toEqual(["settings.dark"])
    expect(shadow).toEqual(lambda)
  })
})
