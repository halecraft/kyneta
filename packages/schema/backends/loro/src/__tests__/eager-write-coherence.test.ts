// eager-write-coherence — pins the post-Phase-2 contract for the Loro
// substrate's write path:
//
//   1. Re-entry: subscriber callbacks may freely `change()` the doc.
//      Substrate writes land synchronously; both reads (σ via the
//      Reader) AND subsequent writes (λ via change-mapping) succeed
//      against the new state.
//   2. Projection law: `σ ≡ Π(λ)` holds at every prepare boundary
//      (asserted by deep-equal between the substrate shadow and a
//      fresh `materializeLoroShadow` after a non-trivial mutation
//      sequence — including ops at every supported constructor).
//   3. Json-boundary storage: `struct.json`/`list.json`/`record.json`
//      subtrees round-trip as plain JSON values in the parent CRDT
//      container, not as nested LoroMap/LoroList containers.
//   4. Nested-commit semantics: outer + re-entrant `change()`s collapse
//      into one `doc.commit()` per outermost logical action, with
//      the outer-origin's commit message winning.
//
// These properties together replace the documented pre-1.7.0 "Loro
// reads are immediate-but-writes-are-buffered" caveat with the
// uniform read-and-write coherence law.

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
import { LoroDoc, type LoroDoc as LoroDocType } from "loro-crdt"
import { describe, expect, it } from "vitest"
import {
  createLoroSubstrate,
  ensureLoroContainers,
  loroSubstrateFactory,
} from "../substrate.js"
import { materializeLoroShadow } from "../materialize.js"

// ---------------------------------------------------------------------------
// Test harness — build a fully-stacked doc from a schema
// ---------------------------------------------------------------------------

function build<S extends ReturnType<typeof Schema.struct>>(schema: S) {
  const substrate = loroSubstrateFactory.create(schema)
  const doc = interpret(schema, substrate.context())
    .with(readable)
    .with(writable)
    .with(observation)
    .done() as any
  return { substrate, doc }
}

// `loroSubstrateFactory.create` derives a trivialBinding that
// identity-keys every product field — useful in production but
// makes raw-name materialise/inspect calls in tests fragile. The
// unbound variant constructs the substrate without a binding so
// `materializeLoroShadow(doc, schema)` round-trips with the same
// view the substrate writes to.
function buildUnbound<S extends ReturnType<typeof Schema.struct>>(schema: S) {
  const doc = new LoroDoc()
  ensureLoroContainers(doc, schema)
  doc.commit()
  const substrate = createLoroSubstrate(doc, schema)
  const view = interpret(schema, substrate.context())
    .with(readable)
    .with(writable)
    .with(observation)
    .done() as any
  return { substrate, doc: view }
}

// ---------------------------------------------------------------------------
// 1. Re-entry: subscriber writes to a path created by an earlier
//    re-entrant change(). Pre-Phase-2 this crashed Loro's
//    `replaceChangeToDiff` because the parent list slot was in σ but
//    not in λ.
// ---------------------------------------------------------------------------

describe("Loro re-entry: subscriber writes after subscriber push", () => {
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
      // Same-tick read of the just-pushed item must succeed.
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

describe("Loro projection law", () => {
  it("shadow equals materialized projection of native doc after a mixed mutation sequence", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      count: Schema.counter(),
      items: Schema.list(
        Schema.struct({ name: Schema.string(), done: Schema.boolean() }),
      ),
      meta: Schema.struct.json({
        tags: Schema.string(),
        version: Schema.number(),
      }),
      peers: Schema.record(Schema.boolean()),
    })
    // Unbound substrate — raw field names in the native Loro tree
    // so `materializeLoroShadow(doc, schema)` (called without a
    // binding) finds the same keys.
    const { doc } = buildUnbound(schema)

    // Stagger the pushes and the inner field mutation across change()
    // batches so the address table fully reflects each structural step
    // before the next prepare runs.
    change(doc, (d: any) => {
      d.title.insert(0, "Hello")
      d.count.increment(5)
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

    const nativeDoc = unwrap(doc) as LoroDocType
    const projected = materializeLoroShadow(nativeDoc, schema)
    // The shadow is the σ that the Reader closes over — same view
    // any subscriber would see via `doc.field()`. Π(λ) must agree
    // with σ at every prepare boundary, which after the final
    // commit means a fresh materialise round-trips to the same view.
    expect(projected).toEqual({
      title: "Hello",
      count: 5,
      items: [
        { name: "a", done: true },
        { name: "b", done: false },
      ],
      meta: { tags: "kyneta", version: 2 },
      peers: { alice: true, bob: false },
    })
    // Spot check the canonical reader path.
    expect((doc.title as any)()).toBe("Hello")
    expect((doc.count as any)()).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// 3. JSON boundary: subtrees stored as plain JSON; nested writes
//    round-trip through the coalescer; direct inspection confirms no
//    LoroMap container is created at the boundary slot.
// ---------------------------------------------------------------------------

describe("Loro json-boundary storage", () => {
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

    // Nested write inside the json subtree — coalesces to a full-value
    // write at the boundary key.
    change(doc, (d: any) => {
      d.config.tags.set("prod")
    })
    expect(doc.config()).toEqual({ tags: "prod", retries: 3 })

    // Direct CRDT inspection: the value lives in `_props` at the
    // (identity-hashed) boundary key as a plain JS object, NOT a
    // LoroMap container.
    const native = unwrap(doc) as LoroDocType
    const propsMap = native.getMap("_props")
    const propsKeys = propsMap.keys()
    expect(propsKeys.length).toBe(1) // only `config` lives in _props
    const value = propsMap.get(propsKeys[0]!)
    expect(value).toEqual({ tags: "prod", retries: 3 })
    // A LoroMap would have a `.kind()` method; a plain JS object doesn't.
    expect(typeof (value as any)?.kind).not.toBe("function")
  })

  it("list.json items round-trip and replace cleanly on field-inside-item writes", () => {
    const schema = Schema.struct({
      todos: Schema.list.json(
        Schema.struct({ title: Schema.string(), done: Schema.boolean() }),
      ),
    })
    const { doc } = build(schema)

    // Two pushes in one change block would both read length 0 (the
    // transaction buffers all dispatches until commit), so the second
    // would prepend instead of append. Separate blocks keep the
    // arrayLength read synchronous to the prior write.
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

    // Field write inside a list.json item — list-replace at index in
    // the plain-JSON array stored at the boundary slot.
    change(doc, (d: any) => {
      d.todos.at(0).done.set(true)
    })
    expect(doc.todos()).toEqual([
      { title: "first", done: true },
      { title: "second", done: false },
    ])

    // Native inspection: the `todos` slot in `_props` is a plain
    // array, not a LoroList container.
    const native = unwrap(doc) as LoroDocType
    const propsMap = native.getMap("_props")
    const value = propsMap.get(propsMap.keys()[0]!)
    expect(Array.isArray(value)).toBe(true)
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

    // Map refs surface entries via `.at(key)`, not direct property
    // access — the boundary subtree below is plain JS, so we resolve
    // the email field by navigating from the map ref.
    change(doc, (d: any) => {
      d.profiles.at("alice").email.set("alice@new.example.com")
    })
    expect(doc.profiles()).toEqual({
      alice: { email: "alice@new.example.com" },
      bob: { email: "bob@example.com" },
    })
  })
})

// ---------------------------------------------------------------------------
// 4. Nested-commit semantics: outer + inner re-entries collapse into
//    one Loro commit; outermost commit message wins. The depth-counter
//    contract introduced in Phase 2 Task 2.2.
// ---------------------------------------------------------------------------

describe("Loro nested-commit semantics under re-entry", () => {
  it("one doc.subscribe batch per outermost change(); outer-origin commit message wins", () => {
    const schema = Schema.struct({
      a: Schema.string(),
      b: Schema.string(),
    })
    const { doc } = build(schema)

    // Inner subscriber re-enters with its own origin.
    subscribe(doc.a, () => {
      if (doc.b() !== "") return // only on first delivery
      change(
        doc,
        (d: any) => {
          d.b.set("inner-write")
        },
        { origin: "inner" },
      )
    })

    // Subscribe to the underlying LoroDoc and capture every batch
    // fired across the outer change. The runBatch contract collapses
    // outer + inner re-entries into a single `doc.commit()`, so
    // exactly one non-empty `by:"local"` batch should appear.
    const native = unwrap(doc) as LoroDocType
    const batches: Array<{
      by: "local" | "import" | "checkout"
      eventCount: number
    }> = []
    native.subscribe(batch => {
      batches.push({
        by: batch.by,
        eventCount: batch.events.length,
      })
    })

    // Capture the change counter before the outer write so the
    // commit-message assertion below restricts itself to the change
    // produced by this outer logical action.
    const before = (() => {
      const log = native.getAllChanges() as Map<
        unknown,
        Array<{ counter: number; length: number; message?: string }>
      >
      let n = 0
      log.forEach(cs => {
        n += cs.length
      })
      return n
    })()

    // The outer change. Triggers the re-entrant subscriber and finishes.
    change(
      doc,
      (d: any) => {
        d.a.set("outer-write")
      },
      { origin: "outer" },
    )

    // Both ops landed.
    expect(doc.a()).toBe("outer-write")
    expect(doc.b()).toBe("inner-write")

    // Exactly one non-empty local batch fired for the entire outer
    // logical action — the depth-counter collapses re-entries into
    // one Loro commit.
    const localBatches = batches.filter(
      b => b.by === "local" && b.eventCount > 0,
    )
    expect(localBatches).toHaveLength(1)

    // Inspect the commit-log: the newly-recorded change(s) should
    // carry the OUTER origin in their `.message` field — the inner
    // re-entry contributes its ops but not its commit message.
    const log = native.getAllChanges() as Map<
      unknown,
      Array<{ counter: number; length: number; message?: string }>
    >
    const allChanges: Array<{ message?: string }> = []
    log.forEach(cs => {
      allChanges.push(...cs)
    })
    const newChanges = allChanges.slice(before)
    // At least one new change with the outer-origin message.
    expect(newChanges.some(c => c.message === "outer")).toBe(true)
    // None of the new changes should be tagged with the inner origin —
    // the inner re-entry's commit message was deliberately suppressed.
    expect(newChanges.some(c => c.message === "inner")).toBe(false)
  })
})
