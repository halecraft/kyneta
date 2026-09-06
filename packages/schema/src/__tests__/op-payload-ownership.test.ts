// op-payload-ownership — an op's payload is a snapshot, never a view.
//
// A `replace` payload arrives holding whatever the caller passed, and the store
// writes it in by reference. Without a copy at the store boundary, two things
// share one object: the op a subscriber receives, and the subtree inside the
// store. A later write into that subtree then mutates the op, so the op reports
// a value the batch never wrote.
//
// `ownedForStore` severs that at the store's edge. The caller's half — a caller
// mutating the object it handed to `.set()` — is enforced separately, by the
// `Owned` brand on the change constructors.

import { describe, expect, it } from "vitest"
import type { ReplaceChange } from "../change.js"
import { replaceChange } from "../change.js"
// Everything from one entrypoint: binding compares schema identity, and
// `../basic/index.js` is a separate module instance whose schemas this
// entrypoint's binder does not recognise.
import type { Op } from "../index.js"
import {
  applyChanges,
  batch,
  createDoc,
  ephemeral,
  json,
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
    const change = replaceChange(value)
    const out = ownedForStore(change) as typeof change
    expect(out.value).toEqual(value)
    expect(out.value).not.toBe(value)
  })

  it("leaves replay and projection batches alone", () => {
    // These changes were built by the sending peer or by a decay tick, so
    // nothing local shares them — and they arrive in bulk on the merge path.
    const change = replaceChange(value)
    expect(ownedForStore(change, { replay: true })).toBe(change)
    expect(ownedForStore(change, { replay: true, projection: true })).toBe(
      change,
    )
  })

  it("leaves non-replace changes and scalar payloads alone", () => {
    const scalar = replaceChange(42)
    expect(ownedForStore(scalar)).toBe(scalar)
    const text = { type: "text" as const, instructions: [] }
    expect(ownedForStore(text)).toBe(text)
  })

  it("does not deep-freeze or otherwise alter the payload's contents", () => {
    const nested = { outer: { inner: [1, 2, 3] } }
    const out = ownedForStore(replaceChange(nested)) as ReplaceChange<
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
  it("a replay batch reaches the store as the very object that arrived", () => {
    const change = replaceChange({ dark: true, font: 9 })
    // Identity, not equality: a copy here would be pure cost on the merge path.
    expect(ownedForStore(change, { replay: true })).toBe(change)
  })

  it("root-path replaces are still copied for local writes", () => {
    const change = replaceChange({ tick: 1 })
    expect(ownedForStore(change, {})).not.toBe(change)
    expect(ownedForStore(change, {})).toEqual(change)
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
