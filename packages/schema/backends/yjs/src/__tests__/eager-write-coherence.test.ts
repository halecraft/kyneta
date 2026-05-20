// eager-write-coherence — pins the post-Phase-3 contract for the Yjs
// substrate's write path:
//
//   1. Re-entry: subscriber callbacks may freely `change()` the doc.
//      Substrate writes land synchronously; both reads (σ via the
//      Reader) AND subsequent writes (λ via applyChangeToYjs) succeed
//      against the new state.
//   2. Projection law: `σ ≡ Π(λ)` holds at every prepare boundary
//      (asserted via deep-equal between the substrate's reader view
//      and a fresh `materializeYjsShadow` after a non-trivial
//      mutation sequence).
//   3. Json-boundary storage: `struct.json` / `record.json` subtrees
//      round-trip as plain JSON values in the parent Y.Map entry, not
//      as nested Y.Map containers.
//
// Yjs doesn't need a nested-commit semantics test (4.7) because its
// native `Y.transact` already collapses re-entrant nesting for free.

import {
  change,
  interpret,
  observation,
  readable,
  Schema,
  subscribe,
  unwrap,
  writable,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { materializeYjsShadow } from "../materialize.js"
import {
  createYjsSubstrate,
  yjsSubstrateFactory,
} from "../substrate.js"
import { ensureContainers } from "../populate.js"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function build<S extends ReturnType<typeof Schema.struct>>(schema: S) {
  const substrate = yjsSubstrateFactory.create(schema)
  const doc = interpret(schema, substrate.context())
    .with(readable)
    .with(writable)
    .with(observation)
    .done() as any
  return { substrate, doc }
}

// Unbound variant — bypasses the trivialBinding that identity-keys
// product fields, so raw-name `materializeYjsShadow(doc, schema)` /
// `rootMap.get(name)` calls in tests round-trip with the substrate.
function buildUnbound<S extends ReturnType<typeof Schema.struct>>(schema: S) {
  const doc = new Y.Doc()
  ensureContainers(doc, schema)
  const substrate = createYjsSubstrate(doc, schema)
  const view = interpret(schema, substrate.context())
    .with(readable)
    .with(writable)
    .with(observation)
    .done() as any
  return { substrate, doc: view }
}

// ---------------------------------------------------------------------------
// 1. Re-entry — subscriber writes after subscriber push
// ---------------------------------------------------------------------------

describe("Yjs re-entry: subscriber writes after subscriber push", () => {
  it("substrate-write timing: push then set inside the just-pushed item", () => {
    const schema = Schema.struct({
      events: Schema.list(
        Schema.struct({ kind: Schema.string(), body: Schema.string() }),
      ),
    })
    const { doc } = build(schema)

    subscribe(doc.events, () => {
      if ((doc.events as any).length !== 1) return
      change(doc, (d: any) => {
        d.events.push({ kind: "assistant", body: "" })
      })
      change(doc, (d: any) => {
        d.events.at(1).body.set("hello")
      })
    })

    expect(() => {
      change(doc, (d: any) => {
        d.events.push({ kind: "user", body: "hi" })
      })
    }).not.toThrow()

    expect((doc.events as any).length).toBe(2)
    expect((doc.events as any).at(1).body()).toBe("hello")
  })

  it("read-your-writes: re-entrant read inside subscriber sees just-pushed item", () => {
    const schema = Schema.struct({
      items: Schema.list(Schema.struct({ name: Schema.string() })),
    })
    const { doc } = build(schema)

    let observed: string | undefined
    subscribe(doc.items, () => {
      if ((doc.items as any).length !== 1) return
      change(doc, (d: any) => {
        d.items.push({ name: "synthesised" })
      })
      observed = (doc.items as any).at(1).name()
    })

    change(doc, (d: any) => {
      d.items.push({ name: "user" })
    })

    expect(observed).toBe("synthesised")
  })
})

// ---------------------------------------------------------------------------
// 2. Projection law σ ≡ Π(λ)
// ---------------------------------------------------------------------------

describe("Yjs projection law", () => {
  it("shadow equals materialized projection of native doc after a mixed mutation sequence", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      items: Schema.list(
        Schema.struct({ name: Schema.string(), done: Schema.boolean() }),
      ),
      meta: Schema.struct.json({
        tags: Schema.string(),
        version: Schema.number(),
      }),
      peers: Schema.record(Schema.boolean()),
    })
    const { doc } = buildUnbound(schema)

    change(doc, (d: any) => {
      d.title.insert(0, "Hello")
      d.items.push({ name: "a", done: false })
    })
    change(doc, (d: any) => {
      d.items.at(0).done.set(true)
      d.items.push({ name: "b", done: false })
    })
    change(doc, (d: any) => {
      d.meta.set({ tags: "kyneta", version: 2 })
      d.peers.set("alice", true)
      d.peers.set("bob", false)
    })

    const nativeDoc = unwrap(doc) as Y.Doc
    const projected = materializeYjsShadow(nativeDoc, schema)
    expect(projected).toEqual({
      title: "Hello",
      items: [
        { name: "a", done: true },
        { name: "b", done: false },
      ],
      meta: { tags: "kyneta", version: 2 },
      peers: { alice: true, bob: false },
    })
    expect((doc.title as any)()).toBe("Hello")
  })
})

// ---------------------------------------------------------------------------
// 3. JSON boundary: plain JS values in the parent Y.Map entry
// ---------------------------------------------------------------------------

describe("Yjs json-boundary storage", () => {
  it("struct.json field stores a plain JS value at the parent boundary key", () => {
    const schema = Schema.struct({
      config: Schema.struct.json({
        tags: Schema.string(),
        retries: Schema.number(),
      }),
    })
    const { doc } = build(schema)

    change(doc, (d: any) => {
      d.config.set({ tags: "ci", retries: 3 })
    })
    expect(doc.config()).toEqual({ tags: "ci", retries: 3 })

    change(doc, (d: any) => {
      d.config.tags.set("prod")
    })
    expect(doc.config()).toEqual({ tags: "prod", retries: 3 })

    // Direct CRDT inspection: the boundary slot in the root Y.Map
    // holds a plain JS object — NOT a Y.Map. Yjs Y.Map instances
    // would respond to `instanceof Y.Map`.
    const native = unwrap(doc) as Y.Doc
    const rootMap = native.getMap("root")
    const rootKeys: string[] = []
    rootMap.forEach((_v, k) => rootKeys.push(k))
    expect(rootKeys.length).toBe(1)
    const value = rootMap.get(rootKeys[0]!)
    expect(value).toEqual({ tags: "prod", retries: 3 })
    expect(value instanceof Y.Map).toBe(false)
  })

  it("list.json items round-trip and replace cleanly on field-inside-item writes", () => {
    const schema = Schema.struct({
      todos: Schema.list.json(
        Schema.struct({ title: Schema.string(), done: Schema.boolean() }),
      ),
    })
    const { doc } = build(schema)

    change(doc, (d: any) => {
      d.todos.push({ title: "first", done: false })
    })
    change(doc, (d: any) => {
      d.todos.push({ title: "second", done: false })
    })
    expect(doc.todos()).toEqual([
      { title: "first", done: false },
      { title: "second", done: false },
    ])

    change(doc, (d: any) => {
      d.todos.at(0).done.set(true)
    })
    expect(doc.todos()).toEqual([
      { title: "first", done: true },
      { title: "second", done: false },
    ])
  })

  it("record.json entries round-trip through the json-boundary path", () => {
    const schema = Schema.struct({
      profiles: Schema.record.json(
        Schema.struct({ email: Schema.string() }),
      ),
    })
    const { doc } = build(schema)

    change(doc, (d: any) => {
      d.profiles.set("alice", { email: "alice@example.com" })
      d.profiles.set("bob", { email: "bob@example.com" })
    })
    expect(doc.profiles()).toEqual({
      alice: { email: "alice@example.com" },
      bob: { email: "bob@example.com" },
    })

    change(doc, (d: any) => {
      d.profiles.at("alice").email.set("alice@new.example.com")
    })
    expect(doc.profiles()).toEqual({
      alice: { email: "alice@new.example.com" },
      bob: { email: "bob@example.com" },
    })
  })
})
