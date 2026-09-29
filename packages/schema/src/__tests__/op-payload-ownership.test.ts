// op-payload-ownership — an op's payload is a snapshot, never a view.
//
// Every value a change carries (a `replace` value, inserted items, map `set`
// values, added set members, rich-text marks) arrives holding whatever the
// caller passed, and the store writes it in by reference. Without a copy at
// the store boundary, two things share one object: the op a subscriber
// receives, and the subtree inside the store. A later write into that subtree
// then mutates the op, so the op reports a value the batch never wrote.
//
// `ownedForStore` severs that at the store's edge. The caller's half — a caller
// mutating the object it handed to a write — is enforced separately, by the
// `Owned` brand on the change constructors.

import { describe, expect, it } from "vitest"
import type {
  MapChange,
  ReplaceChange,
  RichTextChange,
  SequenceChange,
  SetChange,
} from "../change.js"
import {
  mapChange,
  own,
  replaceChange,
  richTextChange,
  sequenceChange,
  setOpChange,
  textChange,
  trustAsOwned,
} from "../change.js"
// Everything from one entrypoint: binding compares schema identity, and
// `../basic/index.js` is a separate module instance whose schemas this
// entrypoint's binder does not recognise.
import type { Op } from "../index.js"
import {
  applyChanges,
  batch,
  createDoc,
  createRef,
  ephemeral,
  json,
  plainSubstrateFactory,
  Schema,
  subscribe,
} from "../index.js"
import { RawPath } from "../path.js"
import { ownedForStore } from "../reader.js"

const Doc = Schema.struct({
  settings: Schema.struct({ dark: Schema.boolean(), font: Schema.number() }),
  tick: Schema.number(),
})

const settingsOp = (changes: readonly Op[]) =>
  changes.find(op => op.path.format() === "settings")?.change as
    | { value?: { dark?: boolean; font?: number } }
    | undefined

describe("an op's payload is stable from capture to delivery", () => {
  it("a later write into the subtree does not rewrite an earlier op", () => {
    const doc: any = createDoc(json.bind(Doc))
    let captured: ReturnType<typeof settingsOp>
    subscribe(doc, (cs: any) => {
      captured ??= settingsOp(cs.changes)
    })

    batch(doc, (d: any) => {
      d.settings.dark.set(true)
      d.settings.set({ dark: false, font: 1 })
      d.settings.dark.set(true)
    })

    // The op says the batch set dark to false, because it did.
    expect(captured?.value).toEqual({ dark: false, font: 1 })
  })

  it("a subscriber mutating an op cannot corrupt the document", () => {
    const doc: any = createDoc(json.bind(Doc))
    subscribe(doc, (cs: any) => {
      const change = settingsOp(cs.changes)
      if (change?.value) change.value.dark = true
    })

    batch(doc, (d: any) => d.settings.set({ dark: false, font: 2 }))

    expect(doc.settings().dark).toBe(false)
  })

  it("ops held past the callback still replay to the same state", () => {
    const source: any = createDoc(json.bind(Doc))
    const held: Op[] = []
    subscribe(source, (cs: any) => held.push(...cs.changes))

    batch(source, (d: any) => d.settings.set({ dark: true, font: 3 }))
    // A second, unrelated batch. If the held ops aliased the store, this would
    // rewrite them before they are replayed.
    batch(source, (d: any) => {
      d.settings.dark.set(false)
      d.tick.set(7)
    })

    const target: any = createDoc(json.bind(Doc))
    applyChanges(target, held)
    expect(target()).toEqual(source())
  })

  it("holds on the ephemeral substrate too", () => {
    // Its own fixture: the ephemeral substrate stores a nested struct as one
    // register tuple, and its binding rejects shapes the state lattice cannot
    // merge, so it does not take the fixture above.
    const Presence = Schema.struct({
      settings: Schema.struct({
        dark: Schema.boolean(),
        font: Schema.number(),
      }),
    })
    const doc: any = createDoc(ephemeral.bind(Presence))
    let captured: ReturnType<typeof settingsOp>
    subscribe(doc, (cs: any) => {
      captured ??= settingsOp(cs.changes)
    })

    batch(doc, (d: any) => {
      d.settings.set({ dark: false, font: 1 })
      d.settings.dark.set(true)
    })

    expect(captured?.value).toEqual({ dark: false, font: 1 })
  })
})

// ---------------------------------------------------------------------------
// ownedForStore — pure, no substrate required
// ---------------------------------------------------------------------------

describe("ownedForStore", () => {
  const value = { a: 1 }

  it("copies a local replace payload", () => {
    const change = replaceChange(own(value))
    const out = ownedForStore(change) as typeof change
    expect(out.value).toEqual(value)
    expect(out.value).not.toBe(value)
  })

  it("copies a replayed payload too", () => {
    // No local caller built it, so no `own()` is needed at construction — but
    // the store still takes it and later mutates it, and a merge's changesets
    // reach subscribers like any other.
    const change = replaceChange(own(value))
    expect(ownedForStore(change)).not.toBe(change)
  })

  it("exempts nothing \u2014 a decay tick's payload is copied like any other", () => {
    // The exemption `projection` used to carry was justified by a payload that
    // was the whole shadow and that nobody read. A tick now announces the ops
    // its re-projection moved and carries their values, which subscribers do
    // read, so the exemption had become the alias this function severs.
    const change = replaceChange(own(value))
    expect(ownedForStore(change)).not.toBe(change)
  })

  it("leaves changes that carry no objects alone", () => {
    const scalar = replaceChange(42)
    expect(ownedForStore(scalar)).toBe(scalar)
    const text = textChange([{ insert: "x" }])
    expect(ownedForStore(text)).toBe(text)
    const items = sequenceChange([{ insert: [1, "a"] }])
    expect(ownedForStore(items)).toBe(items)
  })

  it("copies every kind of carried value", () => {
    const item = { n: 1 }
    const inserted = ownedForStore(
      sequenceChange([{ retain: 1 }, { insert: [trustAsOwned(item)] }]),
    ) as SequenceChange
    const insert = inserted.instructions[1]
    const insertedItem = insert && "insert" in insert ? insert.insert[0] : null
    expect(insertedItem).toEqual(item)
    expect(insertedItem).not.toBe(item)

    const set = ownedForStore(mapChange(trustAsOwned({ k: item }))) as MapChange
    expect(set.set?.k).toEqual(item)
    expect(set.set?.k).not.toBe(item)

    const added = ownedForStore(setOpChange([trustAsOwned(item)])) as SetChange
    expect(added.add?.[0]).toEqual(item)
    expect(added.add?.[0]).not.toBe(item)

    const marks = { link: { href: "x" } }
    const marked = ownedForStore(
      richTextChange([{ format: 1, marks: trustAsOwned(marks) }]),
    ) as RichTextChange
    const format = marked.instructions[0]
    const formatMarks = format && "marks" in format ? format.marks : null
    expect(formatMarks).toEqual(marks)
    expect(formatMarks).not.toBe(marks)
  })

  it("does not deep-freeze or otherwise alter the payload's contents", () => {
    const nested = { outer: { inner: [1, 2, 3] } }
    const out = ownedForStore(replaceChange(own(nested))) as ReplaceChange<
      typeof nested
    >
    expect(out.value).toEqual(nested)
    expect(out.value.outer).not.toBe(nested.outer)
  })
})

// ---------------------------------------------------------------------------
// Genesis and triggers must not pay for this
// ---------------------------------------------------------------------------

describe("paths that deliberately hand the store an unshared value", () => {
  it("root-path replaces are still copied for local writes", () => {
    const change = replaceChange(own({ tick: 1 }))
    expect(ownedForStore(change)).not.toBe(change)
    expect(ownedForStore(change)).toEqual(change)
    void RawPath.empty
  })
})

// ---------------------------------------------------------------------------
// The inverse pre-state clone, and why the root is different
// ---------------------------------------------------------------------------

describe("inverse capture owns its own snapshot", () => {
  // The substrates read pre-state without copying it, because every `invert`
  // deep-clones what it retains. These two pin that, one level down from where
  // the copy used to be: if `invertReplace` or `invertMap` stopped cloning, the
  // recorded inverse would hold a live view of the store and abort would
  // restore the value the batch just wrote.
  it("a ROOT write compensates to pre-state", () => {
    const doc: any = createDoc(json.bind(Doc))
    batch(doc, (d: any) =>
      d.set({ settings: { dark: false, font: 1 }, tick: 1 }),
    )

    expect(() =>
      batch(doc, (d: any) => {
        d.set({ settings: { dark: true, font: 2 }, tick: 2 })
        throw new Error("abort")
      }),
    ).toThrow("abort")

    expect(doc()).toEqual({ settings: { dark: false, font: 1 }, tick: 1 })
  })

  it("a NESTED write compensates to pre-state", () => {
    const doc: any = createDoc(json.bind(Doc))
    batch(doc, (d: any) => d.settings.set({ dark: false, font: 1 }))

    expect(() =>
      batch(doc, (d: any) => {
        d.settings.set({ dark: true, font: 2 })
        d.settings.dark.set(false)
        throw new Error("abort")
      }),
    ).toThrow("abort")

    expect(doc.settings()).toEqual({ dark: false, font: 1 })
  })
})

// ---------------------------------------------------------------------------
// The caller edge
// ---------------------------------------------------------------------------

describe("a caller cannot rewrite an op after handing over its object", () => {
  it("mutating the object passed to .set() changes neither the document nor the op", () => {
    const doc: any = createDoc(json.bind(Doc))
    let captured: ReturnType<typeof settingsOp>
    subscribe(doc, (cs: any) => {
      captured ??= settingsOp(cs.changes)
    })

    const obj = { dark: false, font: 1 }
    batch(doc, (d: any) => d.settings.set(obj))
    obj.dark = true // the caller keeps its reference and reuses it

    expect(doc.settings().dark).toBe(false)
    expect(captured?.value).toEqual({ dark: false, font: 1 })
  })
})

describe("Owned", () => {
  it("own() copies; trustAsOwned() does not", () => {
    const value = { a: 1 }
    expect(own(value)).not.toBe(value)
    expect(own(value)).toEqual(value)
    expect(trustAsOwned(value)).toBe(value)
  })

  it("leaves primitives alone — nothing can hold a reference to one", () => {
    expect(own(42)).toBe(42)
    expect(own("x")).toBe("x")
    expect(own(null)).toBe(null)
  })
})

describe("every write copies the values it is handed", () => {
  const Kinds = Schema.struct({
    items: Schema.list(Schema.struct({ n: Schema.number() })),
    entries: Schema.record(Schema.struct({ n: Schema.number() })),
    members: Schema.set(Schema.struct({ n: Schema.number() })),
    outline: Schema.tree(
      Schema.struct({
        label: Schema.string(),
        tags: Schema.list(Schema.string()),
      }),
    ),
    body: Schema.richText({ link: { expand: "none" } }),
  })

  function kindsDoc() {
    const substrate = plainSubstrateFactory.create(Kinds)
    const doc: any = createRef(Kinds, substrate)
    const ops: Op[] = []
    subscribe(doc, (cs: any) => ops.push(...cs.changes))
    return { doc, ops }
  }

  /** The first value an op carries, whatever its kind. */
  function carried(op: Op | undefined): unknown {
    const change = op?.change as {
      instructions?: readonly { insert?: readonly unknown[]; marks?: unknown }[]
      set?: Record<string, unknown>
      add?: readonly unknown[]
    }
    const inserted = change.instructions?.find(inst => inst.insert)?.insert
    if (inserted) return inserted[0]
    const marks = change.instructions?.find(inst => inst.marks)?.marks
    if (marks) return marks
    if (change.set) return Object.values(change.set)[0]
    return change.add?.[0]
  }

  it("push and insert", () => {
    const { doc, ops } = kindsDoc()
    const pushed = { n: 1 }
    const inserted = { n: 2 }
    doc.items.push(pushed)
    doc.items.insert(0, inserted)
    pushed.n = 99
    inserted.n = 99

    expect(doc.items()).toEqual([{ n: 2 }, { n: 1 }])
    expect(carried(ops[0])).toEqual({ n: 1 })
    expect(carried(ops[1])).toEqual({ n: 2 })
  })

  it("map set", () => {
    const { doc, ops } = kindsDoc()
    const value = { n: 1 }
    doc.entries.set("k", value)
    value.n = 99

    expect(doc.entries()).toEqual({ k: { n: 1 } })
    expect(carried(ops[0])).toEqual({ n: 1 })
  })

  it("set add", () => {
    const { doc, ops } = kindsDoc()
    const member = { n: 1 }
    doc.members.add(member)
    member.n = 99

    expect(doc.members()).toEqual([{ n: 1 }])
    expect(carried(ops[0])).toEqual({ n: 1 })
  })

  it("tree create's initial data", () => {
    const { doc, ops } = kindsDoc()
    const data = { label: "a", tags: ["x"] }
    const id = doc.outline.create({ data })
    data.tags.push("y")

    expect(doc.outline.node(id)()).toEqual({ label: "a", tags: ["x"] })
    const dataOp = ops.find(op => op.change.type === "map")
    expect(carried(dataOp)).toEqual("a")
    expect((dataOp?.change as MapChange | undefined)?.set?.tags).toEqual(["x"])
  })

  it("rich-text mark", () => {
    const { doc, ops } = kindsDoc()
    doc.body.insert(0, "hi")
    const href = { href: "x" }
    doc.body.mark(0, 2, "link", href)
    href.href = "y"

    expect(doc.body()).toEqual([{ text: "hi", marks: { link: { href: "x" } } }])
    expect(carried(ops[1])).toEqual({ link: { href: "x" } })
  })
})
