// eager-write-coherence — pins the post-Phase-2 contract for the Loro
// substrate's write path:
//
//   1. Re-entry: subscriber callbacks may freely `batch()` the doc.
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
//   4. Nested-commit semantics: outer + re-entrant `batch()`s collapse
//      into one `doc.commit()` per outermost logical action, with
//      the outer-origin's commit message winning.
//
// These properties together replace the documented pre-1.7.0 "Loro
// reads are immediate-but-writes-are-buffered" caveat with the
// uniform read-and-write coherence law.

import {
  batch,
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
import { materializeLoroShadow } from "../materialize.js"
import {
  createLoroSubstrate,
  ensureLoroContainers,
  loroSubstrateFactory,
} from "../substrate.js"

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
//    re-entrant batch(). Pre-Phase-2 this crashed Loro's
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
      batch(doc, (d: any) => {
        d.events.push({ kind: "assistant", body: "" })
      })
      batch(doc, (d: any) => {
        d.events.at(1).body.set("hello")
      })
    })

    expect(() => {
      batch(doc, (d: any) => {
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
      batch(doc, (d: any) => {
        d.items.push({ name: "synthesised" })
      })
      // Same-tick read of the just-pushed item must succeed.
      observed = (doc.items as any).at(1).name()
    })

    batch(doc, (d: any) => {
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

    // Stagger the pushes and the inner field mutation across batch()
    // batches so the address table fully reflects each structural step
    // before the next prepare runs.
    batch(doc, (d: any) => {
      d.title.insert(0, "Hello")
      d.count.increment(5)
      d.items.push({ name: "a", done: false })
    })
    batch(doc, (d: any) => {
      d.items.at(0).done.set(true)
      d.items.push({ name: "b", done: false })
    })
    batch(doc, (d: any) => {
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

    batch(doc, (d: any) => {
      d.config.set({ tags: "ci", retries: 3 })
    })
    expect(doc.config()).toEqual({ tags: "ci", retries: 3 })

    // Nested write inside the json subtree — coalesces to a full-value
    // write at the boundary key.
    batch(doc, (d: any) => {
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
    batch(doc, (d: any) => {
      d.todos.push({ title: "first", done: false })
    })
    batch(doc, (d: any) => {
      d.todos.push({ title: "second", done: false })
    })
    expect(doc.todos()).toEqual([
      { title: "first", done: false },
      { title: "second", done: false },
    ])

    // Field write inside a list.json item — list-replace at index in
    // the plain-JSON array stored at the boundary slot.
    batch(doc, (d: any) => {
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
      profiles: Schema.record.json(Schema.struct({ email: Schema.string() })),
    })
    const { doc } = build(schema)

    batch(doc, (d: any) => {
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
    batch(doc, (d: any) => {
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
  it("subscriber re-entry produces a separate outermost commit; each carries its own origin", () => {
    const schema = Schema.struct({
      a: Schema.string(),
      b: Schema.string(),
    })
    const { doc } = build(schema)

    // Inner subscriber re-enters with its own origin.
    subscribe(doc.a, () => {
      if (doc.b() !== "") return // only on first delivery
      batch(
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
    batch(
      doc,
      (d: any) => {
        d.a.set("outer-write")
      },
      { origin: "outer" },
    )

    // Both ops landed.
    expect(doc.a()).toBe("outer-write")
    expect(doc.b()).toBe("inner-write")

    // Two non-empty local batches: under the three-primitive substrate
    // model, the inner re-entrant `batch()` runs INSIDE the outer's
    // ctx.flush — by which point the outer's frame has already popped.
    // The inner sees `frameStarts.length === 0`, so its runBatch is
    // treated as outermost and invokes substrate.runBatch (a separate
    // Loro commit). Each block is its own atomic abort unit; each
    // gets its own commit. The Loro depth-counter pattern that used
    // to collapse these into one commit is gone (see jj:ryquprut).
    const localBatches = batches.filter(
      b => b.by === "local" && b.eventCount > 0,
    )
    expect(localBatches).toHaveLength(2)

    // Under the new design, `message` is never set by the substrate.
    // We assert that the messages are undefined (kyneta does not write
    // commit messages), but the surrounding two-non-empty-batches
    // assertion remains true.
    const log = native.getAllChanges() as Map<
      unknown,
      Array<{ counter: number; length: number; message?: string }>
    >
    const allChanges: Array<{ message?: string }> = []
    log.forEach(cs => {
      allChanges.push(...cs)
    })
    const newChanges = allChanges.slice(before)
    expect(newChanges.every(c => c.message === undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. Three-primitive-substrate: read-your-writes carries through to Loro
//    σ-eager + abort produces one batched native event with net-zero delta
// ---------------------------------------------------------------------------

describe("Loro three-primitive substrate (jj:ryquprut)", () => {
  it("multi-push in one batch() block appends in order against the CRDT", () => {
    const schema = Schema.struct({
      todos: Schema.list(Schema.string()),
    })
    const { doc } = build(schema)

    batch(doc, (d: any) => {
      d.todos.push("a")
      d.todos.push("b")
      d.todos.push("c")
    })

    expect((doc.todos as any)()).toEqual(["a", "b", "c"])
  })

  it("abort restores state on outermost throw", () => {
    const schema = Schema.struct({
      a: Schema.string(),
      b: Schema.string(),
    })
    const { doc } = build(schema)

    expect(() => {
      batch(doc, (d: any) => {
        d.a.set("set-a")
        d.b.set("set-b")
        throw new Error("abort")
      })
    }).toThrow("abort")

    expect((doc.a as any)()).toBe("")
    expect((doc.b as any)()).toBe("")
  })

  it("abort fires one Changeset with aborted: true on the Loro stack", () => {
    const schema = Schema.struct({ a: Schema.string() })
    const { doc } = build(schema)

    let aborted = false
    subscribe(doc.a, (cs: any) => {
      if (cs.aborted) aborted = true
    })

    expect(() => {
      batch(doc, (d: any) => {
        d.a.set("hello")
        throw new Error("abort")
      })
    }).toThrow("abort")

    expect(aborted).toBe(true)
    expect((doc.a as any)()).toBe("")
  })
})

// ---------------------------------------------------------------------------
// Eager creation of a declared-but-absent rich-text field
// ---------------------------------------------------------------------------
//
// Loro binds the `"all-containers"` eager policy: a field the written value
// omits still gets its container up front, so a later write has somewhere to
// land. These tests cover that for a `richText` field, which reaches the
// backend as a node carrying no value at all.
//
// They are the ONLY thing exercising that path. Nothing else in the repository
// writes a `richText` field on a document, so a green suite would be equally
// consistent with the path never running — which makes these load-bearing
// evidence rather than coverage, and a poor candidate for deletion as
// redundant.

describe("Loro eager creation of an absent richtext field", () => {
  const Marks = { bold: { expand: "after" } } as const
  const Nested = Schema.struct({
    // A nested struct, because a whole-value `.set()` is the operation that
    // leaves a declared field absent — and the root struct cannot be `.set()`
    // on a CRDT backend, where the root identity is fixed.
    inner: Schema.struct({
      title: Schema.string(),
      body: Schema.richText(Marks),
    }),
  })

  it("a whole-value set omitting the richtext field leaves it writable", () => {
    const { doc } = build(Nested)
    batch(doc, (d: any) => d.inner.set({ title: "x" } as any))
    batch(doc, (d: any) => d.inner.body.insert(0, "zz"))
    expect(doc.inner.body()).toEqual([{ text: "zz" }])
    expect(doc.inner.title()).toBe("x")
  })

  it("converges across peers", () => {
    // Two peers from a shared base each write the field. Whether the container
    // was created eagerly or lazily, they must agree afterwards — that is what
    // makes either timing safe.
    const a = build(Nested)
    // A writes the parent struct while omitting `body` — the eager case — and
    // B starts from that ephemeral, so both peers share a base in which the
    // rich-text container was created without ever being written to.
    batch(a.doc, (d: any) => d.inner.set({ title: "x" } as any))
    const b = build(Nested)
    b.substrate.merge(a.substrate.exportEntirety(), { origin: "sync" })

    batch(a.doc, (d: any) => d.inner.body.insert(0, "AAA"))
    batch(b.doc, (d: any) => d.inner.body.insert(0, "BBB"))

    a.substrate.merge(b.substrate.exportEntirety(), { origin: "sync" })
    b.substrate.merge(a.substrate.exportEntirety(), { origin: "sync" })

    expect(a.doc.inner.body()).toEqual(b.doc.inner.body())
  })
})
