// ref-track — the dependency reports a ref's members make in a tracking
// scope, against real refs (createDoc + batch): aspect inference, and the
// load-bearing stable-key-invariance property.

import { describe, expect, it } from "vitest"
import {
  batch,
  createDoc,
  Schema,
  subscribe,
  subscribeNode,
} from "../basic/index.js"
import { __countKeptRefs } from "../coordinate-trie.js"
import { TRANSACT } from "../interpreters/writable.js"
import { withReadScope } from "../tracking.js"

const TodoApp = Schema.struct({
  title: Schema.string(),
  todos: Schema.list(
    Schema.struct({
      id: Schema.string(),
      text: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

const seed = (doc: any, n: number) =>
  batch(doc, (d: any) => {
    for (let i = 0; i < n; i++) {
      d.todos.push({ id: `t${i}`, text: `x${i}`, done: i % 2 === 0 })
    }
  })

describe("tracking — aspect inference", () => {
  it("leaf () reports a single value dep", () => {
    const doc = createDoc(TodoApp)
    const { deps } = withReadScope(() => (doc as any).title())
    expect(deps.map(d => d.aspect)).toEqual(["value"])
  })

  it("composite () reports a single deep dep", () => {
    const doc = createDoc(TodoApp)
    seed(doc, 3)
    const { value, deps } = withReadScope(() => (doc as any).todos())
    expect(Array.isArray(value)).toBe(true)
    expect((value as unknown[]).length).toBe(3)
    expect(deps).toHaveLength(1)
    expect(deps[0].aspect).toBe("deep")
  })

  it("at(i).field() = structure(list) + value(field), nothing more", () => {
    const doc = createDoc(TodoApp)
    seed(doc, 1)
    const { deps } = withReadScope(() => (doc as any).todos.at(0).done())
    expect(deps).toHaveLength(2)
    expect(deps.map(d => d.aspect).sort()).toEqual(["structure", "value"])
  })

  it("iteration reports structure once + value per element read", () => {
    const doc = createDoc(TodoApp)
    seed(doc, 2)
    const { deps } = withReadScope(() =>
      [...(doc as any).todos].map((t: any) => t.done()),
    )
    expect(deps.filter(d => d.aspect === "structure")).toHaveLength(1)
    expect(deps.filter(d => d.aspect === "value")).toHaveLength(2)
  })

  it("does not capture fields the thunk never reads (text)", () => {
    const doc = createDoc(TodoApp)
    seed(doc, 1)
    // Reading only done — text is never touched, so no text dep.
    const { deps } = withReadScope(() => (doc as any).todos.at(0).done())
    expect(deps).toHaveLength(2) // structure(list) + value(done) only
  })

  it("captures nothing outside a scope", () => {
    const doc = createDoc(TodoApp)
    seed(doc, 1)
    // Reads here happen with no active scope — must not leak into the next scope.
    ;(doc as any).todos.at(0).done()
    const { deps } = withReadScope(() => (doc as any).title())
    expect(deps).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Map aspect inference
// ---------------------------------------------------------------------------

const MapTest = Schema.struct({
  items: Schema.record(Schema.struct({ val: Schema.number() })),
})

const seedMap = (doc: any, n: number) =>
  batch(doc, (d: any) => {
    for (let i = 0; i < n; i++) d.items.set(`k${i}`, { val: i })
  })

describe("tracking — map aspect inference", () => {
  it("map () reports a single deep dep (fold suppressed)", () => {
    const doc = createDoc(MapTest)
    seedMap(doc, 3)
    const { value, deps } = withReadScope(() => (doc as any).items())
    expect(value).toEqual({ k0: { val: 0 }, k1: { val: 1 }, k2: { val: 2 } })
    expect(deps).toHaveLength(1)
    expect(deps[0].aspect).toBe("deep")
  })

  it("map.at(key).field() reports structure(map) + value(field)", () => {
    const doc = createDoc(MapTest)
    seedMap(doc, 1)
    const { deps } = withReadScope(() => (doc as any).items.at("k0").val())
    expect(deps).toHaveLength(2)
    expect(deps.map(d => d.aspect).sort()).toEqual(["structure", "value"])
  })

  it("map.has(key) reports a single structure dep", () => {
    const doc = createDoc(MapTest)
    const { deps } = withReadScope(() => (doc as any).items.has("k0"))
    expect(deps).toHaveLength(1)
    expect(deps[0].aspect).toBe("structure")
  })

  it("map.size reports a single structure dep (getter)", () => {
    const doc = createDoc(MapTest)
    const { deps } = withReadScope(() => (doc as any).items.size)
    expect(deps).toHaveLength(1)
    expect(deps[0].aspect).toBe("structure")
  })

  it("map iteration reports structure once + value per element read", () => {
    const doc = createDoc(MapTest)
    seedMap(doc, 2)
    // [Symbol.iterator] yields [key, childRef] pairs (Map.entries semantics).
    const { deps } = withReadScope(() =>
      [...(doc as any).items].map(([_, ref]: any) => ref.val()),
    )
    expect(deps.filter(d => d.aspect === "structure")).toHaveLength(1)
    expect(deps.filter(d => d.aspect === "value")).toHaveLength(2)
  })

  it("does not capture fields the thunk never reads", () => {
    const doc = createDoc(MapTest)
    seedMap(doc, 1)
    // Reading only has — val is never touched, so no val dep.
    const { deps } = withReadScope(() => (doc as any).items.has("k0"))
    expect(deps).toHaveLength(1)
    expect(deps[0].aspect).toBe("structure")
  })
})

// ---------------------------------------------------------------------------
// Sum aspect inference
// ---------------------------------------------------------------------------
//
// A sum ref is a Proxy that forwards every operation, the apply trap
// `useValue` calls through included, to its active variant's ref, which
// reports its own reads. So `node()` reports a single `deep` dep against the
// active variant, as a product would; calling the same sum ref after a
// variant switch reads the new variant, and `useTracked` re-runs the thunk
// when the deep subscription fires.

const SumTest = Schema.struct({
  node: Schema.discriminatedUnion("type", [
    Schema.struct({ type: Schema.string("absent") }),
    Schema.struct({ type: Schema.string("present"), value: Schema.number() }),
  ]),
})

describe("tracking — sum aspect inference", () => {
  it("calling a sum ref reports a single deep dep against the active variant", () => {
    const doc = createDoc(SumTest)
    batch(doc, (d: any) => {
      d.node.set({ type: "present", value: 42 })
    })

    const { deps, value } = withReadScope(() => (doc as any).node())

    expect(value).toEqual({ type: "present", value: 42 })
    // The sum Proxy forwards `()` to the active variant's read, which reports
    // a composite read: a single `deep` dep.
    expect(deps).toHaveLength(1)
    expect(deps[0]?.aspect).toBe("deep")
  })
})

const TreeTest = Schema.struct({
  outline: Schema.tree(Schema.struct({ label: Schema.string() })),
})

describe("tracking — tree aspect inference", () => {
  it("tree () reports a single deep dep (fold suppressed)", () => {
    const doc = createDoc(TreeTest)
    let _id = ""
    batch(doc, (d: any) => {
      _id = d.outline.create({ data: { label: "root" } })
    })
    const { value, deps } = withReadScope(() => (doc as any).outline())
    expect(Array.isArray(value)).toBe(true)
    expect((value as unknown[]).length).toBe(1)
    expect(deps).toHaveLength(1)
    expect(deps[0].aspect).toBe("deep")
  })

  it("tree.node(id).field() reports structure(tree) + value(field)", () => {
    const doc = createDoc(TreeTest)
    let id = ""
    batch(doc, (d: any) => {
      id = d.outline.create({ data: { label: "n" } })
    })
    const { deps } = withReadScope(() => (doc as any).outline.node(id).label())
    expect(deps).toHaveLength(2)
    expect(deps.map(d => d.aspect).sort()).toEqual(["structure", "value"])
  })

  it("tree.roots reports a single structure dep (getter)", () => {
    const doc = createDoc(TreeTest)
    const { deps } = withReadScope(() => (doc as any).outline.roots)
    expect(deps).toHaveLength(1)
    expect(deps[0].aspect).toBe("structure")
  })

  it("tree iteration reports structure once + value per element read", () => {
    const doc = createDoc(TreeTest)
    batch(doc, (d: any) => {
      d.outline.create({ data: { label: "a" } })
      d.outline.create({ data: { label: "b" } })
    })
    // [Symbol.iterator] yields ReadableTreeNode, whose .data is the child ref.
    const { deps } = withReadScope(() =>
      [...(doc as any).outline].map((n: any) => n.data.label()),
    )
    expect(deps.filter(d => d.aspect === "structure")).toHaveLength(1)
    expect(deps.filter(d => d.aspect === "value")).toHaveLength(2)
  })
})

describe("tracking — stable key invariance (cursor-stable identity)", () => {
  it("a value dep key is invariant under a structural insert before it", () => {
    const doc = createDoc(TodoApp)
    batch(doc, (d: any) => d.todos.push({ id: "a", text: "x", done: false }))

    // Element "a" at index 0.
    const before = withReadScope(() => (doc as any).todos.at(0).done())
    const keyBefore = before.deps.find(d => d.aspect === "value")?.key
    expect(keyBefore).toBeDefined()

    // Insert "b" at the front → "a" shifts to index 1.
    batch(doc, (d: any) =>
      d.todos.insert(0, { id: "b", text: "y", done: true }),
    )

    // Re-read the SAME element, now at index 1.
    const after = withReadScope(() => (doc as any).todos.at(1).done())
    const keyAfter = after.deps.find(d => d.aspect === "value")?.key

    expect(keyAfter).toBe(keyBefore)
  })

  it("distinct elements have distinct value keys", () => {
    const doc = createDoc(TodoApp)
    seed(doc, 2)
    const k0 = withReadScope(() => (doc as any).todos.at(0).done()).deps.find(
      d => d.aspect === "value",
    )?.key
    const k1 = withReadScope(() => (doc as any).todos.at(1).done()).deps.find(
      d => d.aspect === "value",
    )?.key
    expect(k0).toBeDefined()
    expect(k1).toBeDefined()
    expect(k0).not.toBe(k1)
  })
})

// ---------------------------------------------------------------------------
// .get — precise inside a scope, ref-free outside one
// ---------------------------------------------------------------------------

describe("tracking — .get", () => {
  const Rows = Schema.struct({
    rec: Schema.record(Schema.struct({ n: Schema.number() })),
    list: Schema.list(Schema.struct({ n: Schema.number() })),
  })

  function rowsDoc() {
    const doc: any = createDoc(Rows)
    batch(doc, (d: any) => {
      d.rec.set("k", { n: 1 })
      d.rec.set("j", { n: 2 })
      d.list.push({ n: 1 }, { n: 2 })
    })
    return doc
  }

  /**
   * How many times a computation re-runs after `write`, subscribed to the
   * deps it read as the reactive runtime subscribes to them: `deep` to the
   * subtree, `value` and `structure` to the node itself.
   */
  function reruns(read: () => unknown, write: () => void): number {
    const { deps } = withReadScope(read)
    let count = 0
    const stops = deps.map(dep =>
      dep.aspect === "deep"
        ? subscribe(dep.ref as any, () => count++)
        : subscribeNode(dep.ref as any, () => count++),
    )
    write()
    for (const stop of stops) stop()
    return count
  }

  it("a record's .get(k) reports structure on the record and deep on the entry", () => {
    const doc = rowsDoc()
    const { value, deps } = withReadScope(() => doc.rec.get("k"))
    expect(value).toEqual({ n: 1 })
    expect(deps.map(d => [d.ref, d.aspect])).toEqual([
      [doc.rec, "structure"],
      [doc.rec.at("k"), "deep"],
    ])
  })

  it("re-runs on a write into its entry, and not on a write into another", () => {
    const doc = rowsDoc()
    expect(
      reruns(
        () => doc.rec.get("k"),
        () => doc.rec.at("k").n.set(5),
      ),
    ).toBeGreaterThan(0)
    expect(
      reruns(
        () => doc.rec.get("k"),
        () => doc.rec.at("j").n.set(5),
      ),
    ).toBe(0)
  })

  it("re-runs on adding or deleting a key", () => {
    const doc = rowsDoc()
    expect(
      reruns(
        () => doc.rec.get("k"),
        () => doc.rec.set("x", { n: 3 }),
      ),
    ).toBeGreaterThan(0)
    expect(
      reruns(
        () => doc.rec.get("k"),
        () => doc.rec.delete("j"),
      ),
    ).toBeGreaterThan(0)
  })

  it("a sequence's .get(i) is as precise", () => {
    const doc = rowsDoc()
    expect(
      reruns(
        () => doc.list.get(0),
        () => doc.list.at(0).n.set(5),
      ),
    ).toBeGreaterThan(0)
    expect(
      reruns(
        () => doc.list.get(0),
        () => doc.list.at(1).n.set(5),
      ),
    ).toBe(0)
    expect(
      reruns(
        () => doc.list.get(0),
        () => doc.list.push({ n: 3 }),
      ),
    ).toBeGreaterThan(0)
  })

  it("a missing key reads undefined, and still reports structure", () => {
    const doc = rowsDoc()
    const { value, deps } = withReadScope(() => doc.rec.get("missing"))
    expect(value).toBeUndefined()
    expect(deps.map(d => d.aspect)).toEqual(["structure"])
  })

  it("outside a scope, .get keeps no refs", () => {
    const doc = rowsDoc()
    expect(doc.rec.get("k")).toEqual({ n: 1 })
    expect(doc.list.get(1)).toEqual({ n: 2 })
    expect(__countKeptRefs(doc[TRANSACT])).toBe(0)
  })
})
