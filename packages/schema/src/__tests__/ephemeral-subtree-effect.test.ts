// The ephemeral substrate's horizons agree with `planSubtreeEffect` wherever
// the two must.
//
// A horizon answers "which unseen writes does this write defeat";
// `planSubtreeEffect` answers "what below this path may be new locally". They
// are different questions, answered by separate code, but at a dynamic (record)
// position the answers must coincide: the keys a change names are exactly the
// keys it stamps past what they held, and a whole rewrite of a record is one
// horizon over all of it. This law keeps the two from drifting.

import { describe, expect, it } from "vitest"
import type { ChangeBase, MapChange } from "../change.js"
import {
  mapChange,
  mapChangeEffects,
  mapClearChange,
  own,
  replaceChange,
} from "../change.js"
import { deepClonePlain } from "../clone.js"
import { type Path, RawPath } from "../path.js"
import { KIND, Schema, type Schema as SchemaNode } from "../schema.js"
import {
  applyChangeToStateTree,
  type Container,
  isHorizon,
  isLive,
  newestTimestamp,
  type StateTree,
} from "../substrates/state-tree.js"
import { planSubtreeEffect } from "../subtree-effect.js"
import { stamp } from "./ephemeral-fixtures.js"

const Doc = Schema.struct({
  peers: Schema.record(
    Schema.struct({
      cursor: Schema.number(),
      tags: Schema.record(Schema.number()),
    }),
  ),
  settings: Schema.struct({
    dark: Schema.boolean(),
    m: Schema.record(Schema.number()),
  }),
  counts: Schema.record(Schema.number()),
})

const root = RawPath.empty
const peers = root.field("peers")
const settings = root.field("settings")
const counts = root.field("counts")

/** A populated tree, every node written at t=100. */
function populated(): Container {
  const tree: Container = {}
  applyChangeToStateTree(
    tree,
    root,
    replaceChange(
      own({
        peers: {
          alice: { cursor: 1, tags: { a: 1 } },
          bob: { cursor: 2, tags: {} },
        },
        settings: { dark: false, m: { x: 1 } },
        counts: { x: 1, y: 2 },
      }),
    ),
    stamp(100),
    Doc,
  )
  return tree
}

/** Every horizon in `tree`, by the key of its path. */
function horizons(tree: StateTree, prefix: string[] = []): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (node: StateTree, at: string[]): void => {
    if (isLive(node)) return
    if (isHorizon(node)) {
      found.set(at.join("."), `${node[1]}:${node[3]}`)
      if (node[0] !== null) walk(node[0], at)
      return
    }
    for (const [key, child] of Object.entries(node)) walk(child, [...at, key])
  }
  walk(tree, prefix)
  return found
}

/** The node at `keys`, through horizons' content. */
function nodeAt(
  tree: StateTree,
  keys: readonly string[],
): StateTree | undefined {
  let node: StateTree | undefined = tree
  for (const key of keys) {
    if (node === undefined || isLive(node)) return undefined
    const container: Container | null = isHorizon(node) ? node[0] : node
    node = container?.[key]
  }
  return node
}

/** The schema at a path of declared fields and record keys. */
function schemaAt(path: Path): SchemaNode {
  let schema: SchemaNode = Doc
  for (const segment of path.segments) {
    schema =
      schema[KIND] === "product"
        ? (schema as { fields: Record<string, SchemaNode> }).fields[
            String(segment.coord())
          ]
        : (schema as { item: SchemaNode }).item
  }
  return schema
}

/** Whether `path` sits at a record key, or is itself a record. */
function isDynamic(path: Path): boolean {
  if (schemaAt(path)[KIND] === "map") return true
  return path.length > 0 && schemaAt(path.slice(0, -1))[KIND] === "map"
}

const cases: readonly [string, Path, ChangeBase][] = [
  [
    "a record key arrives",
    peers,
    mapChange(own({ carol: { cursor: 3, tags: {} } })),
  ],
  [
    "a record key is rewritten whole",
    peers,
    mapChange(own({ alice: { cursor: 9, tags: {} } })),
  ],
  ["a record key leaves", peers, mapChange(undefined, ["bob"])],
  [
    "a key named in both lists, scalar values",
    counts,
    mapChange(own({ x: 5 }), ["x", "y"]),
  ],
  ["a record is cleared", counts, mapClearChange()],
  [
    "a record is cleared and refilled",
    peers,
    mapClearChange(own({ dave: { cursor: 0, tags: {} } })),
  ],
  [
    "a replace at a record key",
    peers.entry("alice"),
    replaceChange(own({ cursor: 7, tags: { b: 2 } })),
  ],
  ["a scalar replace at a record key", counts.entry("x"), replaceChange(7)],
  [
    "a replace of a declared struct",
    settings,
    replaceChange(own({ dark: true, m: { z: 1 } })),
  ],
  [
    "a replace of a declared scalar",
    settings.field("dark"),
    replaceChange(true),
  ],
  [
    "a map change at a declared struct",
    settings,
    mapChange(own({ dark: true })),
  ],
  [
    "a replace at the root",
    root,
    replaceChange(own({ settings: { dark: true, m: {} } })),
  ],
]

describe("horizons agree with planSubtreeEffect at dynamic positions", () => {
  for (const [name, path, change] of cases) {
    it(name, () => {
      const tree = populated()
      const before = deepClonePlain(tree)
      applyChangeToStateTree(tree, path, change, stamp(200), Doc)

      const was = horizons(before)
      const raised = [...horizons(tree)].filter(
        ([key, value]) => was.get(key) !== value,
      )
      const at = path.segments.map(segment => String(segment.coord()))
      const effect = planSubtreeEffect(change)

      // No horizon is raised outside the change's effect.
      const inScope = (key: string): boolean => {
        const keys = key === "" ? [] : key.split(".")
        const below = keys.slice(0, at.length).join(".") === at.join(".")
        if (!below) return false
        if (effect === "none") return false
        if (effect === "all") return true
        return (
          keys.length > at.length && effect.keys.includes(keys[at.length] ?? "")
        )
      }
      for (const [key] of raised) expect(inScope(key), key).toBe(true)

      const dynamic = isDynamic(path)
      const container = (value: unknown) =>
        typeof value === "object" && value !== null
      if (effect === "all") {
        const written = nodeAt(tree, at)
        if (
          dynamic &&
          (change.type === "map" ||
            container((change as { value?: unknown }).value))
        ) {
          // A whole rewrite at a dynamic position: one replacement horizon.
          expect(isHorizon(written) && !written[3], "replacement horizon").toBe(
            true,
          )
          expect(raised.some(([key]) => key === at.join("."))).toBe(true)
        } else if (dynamic) {
          expect(isLive(written), "live leaf").toBe(true)
        } else {
          // A declared position is written field by field: no horizon at it.
          expect(raised.some(([key]) => key === at.join("."))).toBe(false)
        }
      } else if (effect !== "none" && schemaAt(path)[KIND] === "map") {
        const { set, remove } = mapChangeEffects(change as MapChange, [])
        for (const key of effect.keys) {
          const node = nodeAt(tree, [...at, key])
          const old = nodeAt(before, [...at, key])
          if (remove.includes(key)) {
            expect(isHorizon(node) && node[3], `${key} deleted`).toBe(true)
          } else if (container(set[key])) {
            expect(isHorizon(node) && !node[3], `${key} replaced`).toBe(true)
          } else {
            expect(isLive(node), `${key} live`).toBe(true)
          }
          if (node !== undefined && old !== undefined) {
            expect(newestTimestamp(node)).toBeGreaterThan(newestTimestamp(old))
          }
        }
      } else if (effect !== "none") {
        // Keys at a declared position are written in place.
        expect(raised.some(([key]) => key === at.join("."))).toBe(false)
      }
    })
  }
})
