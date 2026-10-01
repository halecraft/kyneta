// op-payload-ownership — an op's payload is a snapshot, never a view.
//
// Every value a change carries (a `replace` value, inserted items, map `set`
// values, added set members, rich-text marks) is shared by the op a
// subscriber receives and the subtree inside the store. `freezePayload`
// freezes it in place at the store's edge, so neither can change it: a later
// write into that subtree copies the frozen node first.
//
// That needs the store to own the payload. The `Owned` brand on the change
// constructors keeps a caller from mutating the object it handed to a write,
// and `applyChanges` owns the ops it is handed.

import { describe, expect, it } from "vitest"
import type { MapChange, SetChange } from "../change.js"
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
import { isDeeplyFrozen } from "../clone.js"
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
import { freezePayload } from "../reader.js"

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

  it("mutating a delivered payload throws, and the document is unchanged", () => {
    const doc: any = createDoc(json.bind(Doc))
    let thrown: unknown
    subscribe(doc, (cs: any) => {
      const change = settingsOp(cs.changes)
      try {
        if (change?.value) change.value.dark = true
      } catch (error) {
        thrown = error
      }
    })

    batch(doc, (d: any) => d.settings.set({ dark: false, font: 2 }))

    expect(thrown).toBeInstanceOf(TypeError)
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
// freezePayload — pure, no substrate required
// ---------------------------------------------------------------------------

describe("freezePayload", () => {
  it("freezes a payload in place and keeps the change", () => {
    const change = replaceChange(own({ outer: { inner: [1, 2, 3] } }))
    expect(freezePayload(change)).toBe(change)
    expect(isDeeplyFrozen(change.value)).toBe(true)
  })

  it("leaves changes that carry no objects alone", () => {
    const scalar = replaceChange(42)
    expect(freezePayload(scalar)).toBe(scalar)
    const text = textChange([{ insert: "x" }])
    expect(freezePayload(text)).toBe(text)
    const items = sequenceChange([{ insert: [1, "a"] }])
    expect(freezePayload(items)).toBe(items)
  })

  it("freezes every kind of carried value", () => {
    const inserted = sequenceChange([
      { retain: 1 },
      { insert: [trustAsOwned({ n: 1 })] },
    ])
    freezePayload(inserted)
    const insert = inserted.instructions[1]
    expect(
      isDeeplyFrozen(insert && "insert" in insert ? insert.insert[0] : null),
    ).toBe(true)

    const set = mapChange(trustAsOwned({ k: { n: 1 } }))
    freezePayload(set)
    expect(isDeeplyFrozen(set.set?.k)).toBe(true)

    const added = setOpChange([trustAsOwned({ n: 1 })])
    freezePayload(added)
    expect(isDeeplyFrozen(added.add?.[0])).toBe(true)

    const marked = richTextChange([
      { format: 1, marks: trustAsOwned({ link: { href: "x" } }) },
    ])
    freezePayload(marked)
    const format = marked.instructions[0]
    expect(
      isDeeplyFrozen(format && "marks" in format ? format.marks : null),
    ).toBe(true)
  })

  it("leaves a byte array unfrozen, since none can be frozen", () => {
    const bytes = new Uint8Array([1])
    const change = replaceChange(trustAsOwned({ bytes }))
    freezePayload(change)
    expect(Object.isFrozen(change.value)).toBe(true)
    expect(change.value.bytes).toBe(bytes)
  })
})

// ---------------------------------------------------------------------------
// The inverse pre-state clone, and why the root is different
// ---------------------------------------------------------------------------

describe("inverse capture owns its own snapshot", () => {
  // The substrates read pre-state without copying it, because every `invert`
  // owns what it retains (`own`): a value a read froze is shared, since no
  // write can change it, and anything else is copied. These two pin that: if
  // `invertReplace` or `invertMap` held an unfrozen value uncopied, the
  // recorded inverse would be a live view of the store and abort would
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

  it("own() shares a deeply frozen value, which nobody can change", () => {
    const value = Object.freeze({ a: Object.freeze([1]) })
    expect(own(value)).toBe(value)
  })

  it("own() copies a shallow-frozen value, and one holding bytes", () => {
    const shallow = Object.freeze({ a: [1] })
    expect(own(shallow)).not.toBe(shallow)
    const bytes = Object.freeze({ b: new Uint8Array([1]) })
    const owned = own(bytes)
    expect(owned).not.toBe(bytes)
    expect(owned.b).not.toBe(bytes.b)
    expect([...owned.b]).toEqual([1])
  })

  it("a read handed back to a write is shared, not copied", () => {
    const doc: any = createDoc(json.bind(Doc))
    const ops: Op[] = []
    subscribe(doc, (cs: any) => ops.push(...cs.changes))
    const settings = doc.settings()
    doc.settings.set(settings)
    expect(settingsOp(ops)?.value).toBe(settings)
    expect(doc.settings()).toBe(settings)
  })

  it("leaves primitives alone — nothing can hold a reference to one", () => {
    expect(own(42)).toBe(42)
    expect(own("x")).toBe("x")
    expect(own(null)).toBe(null)
  })
})

describe("applyChanges owns the ops it is handed", () => {
  it("leaves the caller's payloads unfrozen, and a later mutation does not reach σ", () => {
    const doc: any = createDoc(json.bind(Doc))
    const value = { dark: true, font: 4 }
    const ops: Op[] = [
      {
        path: RawPath.empty.field("settings"),
        change: replaceChange(trustAsOwned(value)),
      },
    ]
    applyChanges(doc, ops)
    expect(Object.isFrozen(value)).toBe(false)
    value.font = 99
    expect(doc.settings()).toEqual({ dark: true, font: 4 })
  })

  it("shares a payload that is already deeply frozen", () => {
    const source: any = createDoc(json.bind(Doc))
    const held: Op[] = []
    subscribe(source, (cs: any) => held.push(...cs.changes))
    source.settings.set({ dark: true, font: 5 })

    const target: any = createDoc(json.bind(Doc))
    applyChanges(target, held)
    expect(target.settings()).toBe(settingsOp(held)?.value)
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

  it("set clear names the members it removed", () => {
    const { doc, ops } = kindsDoc()
    doc.members.add({ n: 1 })
    doc.members.add({ n: 2 })
    doc.members.clear()

    expect(doc.members()).toEqual([])
    expect((ops[2]?.change as SetChange | undefined)?.remove).toEqual([
      { n: 1 },
      { n: 2 },
    ])
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
