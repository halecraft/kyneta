// reactive.test.ts — the reactive runtime over real kyneta refs.
//
// Imports schema via the package boundary (dist) — the same module graph the
// runtime imports `@kyneta/schema` from — so read-tracking is one instance.

import { batch, createDoc, Schema } from "@kyneta/schema/basic"
import { describe, expect, it } from "vitest"
import { diffDeps } from "../diff.js"
import { computed, reactive } from "../reactive.js"

const TodoApp = Schema.struct({
  title: Schema.string(),
  count: Schema.number(),
  todos: Schema.list(
    Schema.struct({
      id: Schema.string(),
      text: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))

const seed = (doc: any, n: number) =>
  batch(doc, (d: any) => {
    for (let i = 0; i < n; i++) {
      d.todos.push({ id: `t${i}`, text: `x${i}`, done: i % 2 === 0 })
    }
  })

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

describe("diffDeps", () => {
  const dep = (key: string) => ({
    key,
    aspect: "value" as const,
    ref: {} as any,
  })

  it("classifies add / remove / keep by key", () => {
    const prev = new Set(["a", "b"])
    const { add, remove, keep } = diffDeps(prev, [dep("b"), dep("c")])
    expect(add.map(d => d.key)).toEqual(["c"])
    expect(remove).toEqual(["a"])
    expect(keep).toEqual(["b"])
  })

  it("empty next removes everything", () => {
    const { add, remove } = diffDeps(new Set(["a", "b"]), [])
    expect(add).toEqual([])
    expect(remove.sort()).toEqual(["a", "b"])
  })
})

// ---------------------------------------------------------------------------
// Core reactivity
// ---------------------------------------------------------------------------

describe("reactive", () => {
  it("re-runs on a dependency change; version advances (pull-on-read)", () => {
    const doc = createDoc(TodoApp)
    const r = reactive(() => (doc as any).title())
    expect(r()).toBe("")
    expect(r.version).toBe(0)

    batch(doc, (d: any) => d.title.set("hi"))
    expect(r()).toBe("hi") // direct schema-ref dep → synchronous pull
    expect(r.version).toBe(1)
  })

  it("PARSIMONY: a text edit does not re-run a done-filter; a done flip does", () => {
    const doc = createDoc(TodoApp)
    seed(doc, 3)
    const visible = reactive(() =>
      [...(doc as any).todos]
        .filter((t: any) => t.done())
        .map((t: any) => t.id()),
    )
    expect(visible()).toEqual(["t0", "t2"]) // i%2==0 done
    expect(visible.version).toBe(0)

    // Editing a todo's text touches neither structure(todos) nor any value(done).
    batch(doc, (d: any) => d.todos.at(0).text.set("edited"))
    expect(visible.version).toBe(0) // no dependency fired → no recompute

    // Flipping a done crosses the filter → recompute.
    batch(doc, (d: any) => d.todos.at(0).done.set(false))
    expect(visible()).toEqual(["t2"]) // pull-on-read
    expect(visible.version).toBe(1)
  })

  it("a structural add re-runs (structure dep)", () => {
    const doc = createDoc(TodoApp)
    seed(doc, 1)
    const count = reactive(() => (doc as any).todos.length)
    expect(count()).toBe(1)
    batch(doc, (d: any) => d.todos.push({ id: "n", text: "", done: false }))
    expect(count()).toBe(2)
    expect(count.version).toBe(1)
  })

  it("COALESCING: several changes in one tick flush to one re-run", async () => {
    const doc = createDoc(TodoApp)
    const r = reactive(() => (doc as any).title())
    let notifs = 0
    r.subscribe(() => notifs++)

    batch(doc, (d: any) => d.title.set("a"))
    batch(doc, (d: any) => d.title.set("b"))
    await tick()

    expect(notifs).toBe(1)
    expect(r()).toBe("b")
    expect(r.version).toBe(1)
  })

  it("COMPOSITION: a reactive reading a computed re-runs once, glitch-free", async () => {
    const doc = createDoc(TodoApp)
    const base = computed(() => (doc as any).count())
    let derivedRuns = 0
    const derived = reactive(() => {
      derivedRuns++
      return base() * 2
    })
    expect(derived()).toBe(0)
    expect(derivedRuns).toBe(1)

    batch(doc, (d: any) => d.count.set(5))
    await tick() // transitive reactive→reactive propagation completes on the flush

    expect(derived()).toBe(10)
    expect(derived.version).toBe(1)
    expect(derivedRuns).toBe(2) // exactly one re-run (no glitch double-compute)
  })

  it("DISPOSAL: after dispose, changes cause no re-run and no notify", async () => {
    const doc = createDoc(TodoApp)
    const r = reactive(() => (doc as any).title())
    let notifs = 0
    r.subscribe(() => notifs++)

    r.dispose()
    batch(doc, (d: any) => d.title.set("x"))
    await tick()

    expect(notifs).toBe(0)
    expect(r.version).toBe(0)
  })
})
