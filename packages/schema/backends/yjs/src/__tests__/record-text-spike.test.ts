// record-text-spike — validate text-inside-struct patterns for Yjs backend.
//
// The Yjs analog of the Loro counter-in-record spike. Yjs doesn't support
// counter annotations, but it DOES support text annotations. The same
// structural bug exists: when a struct is dynamically inserted into a
// record or list via .set() or .push(), text fields declared in the schema
// but missing from the value object don't get Y.Text containers created.
//
// This spike tests:
//   1. record(struct({ name: string(), bio: text() }))
//   2. list(struct({ name: string(), bio: text() }))
//
// Key operations:
//   1. .set(key, { name }) — insert with text field omitted
//   2. .at(key).bio.insert(0, "Hello") — insert into the text field
//   3. Reading back: doc.profiles() should return { [key]: { name, bio } }
//   4. Sync: two peers should converge after exchanging deltas

import { describe, expect, it } from "vitest"
import {
  change,
  createYjsDoc,
  createYjsDocFromEntirety,
  exportEntirety,
  exportSince,
  merge,
  Schema,
  subscribe,
  text,
  version,
} from "../index.js"

// ===========================================================================
// Schemas
// ===========================================================================

const ProfileSchema = Schema.doc({
  profiles: Schema.record(
    Schema.struct({
      displayName: Schema.string(),
      bio: text(),
    }),
  ),
})

const PlainRecordSchema = Schema.doc({
  profiles: Schema.record(
    Schema.struct({
      displayName: Schema.string(),
      age: Schema.number(),
    }),
  ),
})

const ListProfileSchema = Schema.doc({
  players: Schema.list(
    Schema.struct({
      name: Schema.string(),
      bio: text(),
    }),
  ),
})

// ===========================================================================
// Baseline: record-of-struct (plain, no text)
// ===========================================================================

describe("record-of-struct (plain baseline)", () => {
  it("set a record entry and read it back", () => {
    const doc = createYjsDoc(PlainRecordSchema)

    change(doc, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice", age: 30 })
    })

    const snapshot = doc.profiles()
    expect(snapshot).toEqual({
      alice: { displayName: "Alice", age: 30 },
    })
  })

  it("set multiple entries and read all back", () => {
    const doc = createYjsDoc(PlainRecordSchema)

    change(doc, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice", age: 30 })
      d.profiles.set("bob", { displayName: "Bob", age: 25 })
    })

    const snapshot = doc.profiles()
    expect(snapshot).toEqual({
      alice: { displayName: "Alice", age: 30 },
      bob: { displayName: "Bob", age: 25 },
    })
  })

  it("navigate into a record entry via .at()", () => {
    const doc = createYjsDoc(PlainRecordSchema)

    change(doc, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice", age: 30 })
    })

    const entry = (doc as any).profiles.at("alice")
    expect(entry).toBeDefined()
    expect(entry.displayName()).toBe("Alice")
    expect(entry.age()).toBe(30)
  })

  it("syncs record-of-struct between two peers via snapshot", () => {
    const docA = createYjsDoc(PlainRecordSchema)

    change(docA, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice", age: 30 })
    })

    const snapshot = exportEntirety(docA)
    const docB = createYjsDocFromEntirety(PlainRecordSchema, snapshot)

    expect(docB.profiles()).toEqual({
      alice: { displayName: "Alice", age: 30 },
    })
  })

  it("syncs record-of-struct between two peers via delta", () => {
    const docA = createYjsDoc(PlainRecordSchema)

    change(docA, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice", age: 30 })
    })

    // Establish docB from snapshot (avoids Yjs clientID collision)
    const docB = createYjsDocFromEntirety(
      PlainRecordSchema,
      exportEntirety(docA),
    )

    const v0 = version(docB)

    change(docA, (d: any) => {
      d.profiles.set("bob", { displayName: "Bob", age: 25 })
    })

    const delta = exportSince(docA, v0)
    expect(delta).not.toBeNull()
    merge(docB, delta!, "sync")

    expect(docB.profiles()).toEqual({
      alice: { displayName: "Alice", age: 30 },
      bob: { displayName: "Bob", age: 25 },
    })
  })
})

// ===========================================================================
// text-inside-struct-inside-record
// ===========================================================================

describe("text-inside-struct-inside-record", () => {
  it("set a record entry with text field omitted and read it back", () => {
    const doc = createYjsDoc(ProfileSchema)

    change(doc, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice" })
    })

    const snapshot = doc.profiles()
    expect(snapshot).toEqual({
      alice: { displayName: "Alice", bio: "" },
    })
  })

  it("set a record entry with text field provided and read it back", () => {
    const doc = createYjsDoc(ProfileSchema)

    change(doc, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice", bio: "Hello world" })
    })

    const snapshot = doc.profiles()
    expect(snapshot).toEqual({
      alice: { displayName: "Alice", bio: "Hello world" },
    })
  })

  it("navigate into a record entry and read the text", () => {
    const doc = createYjsDoc(ProfileSchema)

    change(doc, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice" })
    })

    const entry = (doc as any).profiles.at("alice")
    expect(entry).toBeDefined()
    expect(entry.displayName()).toBe("Alice")
    expect(entry.bio()).toBe("")
  })

  it("insert text into a text field inside a record entry (field omitted at creation)", () => {
    const doc = createYjsDoc(ProfileSchema)

    change(doc, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice" })
    })

    change(doc, (d: any) => {
      d.profiles.at("alice").bio.insert(0, "Hello world")
    })

    expect((doc as any).profiles.at("alice").bio()).toBe("Hello world")
  })

  it("insert text into a text field inside a record entry (field provided at creation)", () => {
    const doc = createYjsDoc(ProfileSchema)

    change(doc, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice", bio: "Initial" })
    })

    change(doc, (d: any) => {
      d.profiles.at("alice").bio.insert(7, " bio")
    })

    expect((doc as any).profiles.at("alice").bio()).toBe("Initial bio")
  })

  it("set multiple entries and edit text independently", () => {
    const doc = createYjsDoc(ProfileSchema)

    change(doc, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice" })
      d.profiles.set("bob", { displayName: "Bob" })
    })

    change(doc, (d: any) => {
      d.profiles.at("alice").bio.insert(0, "Alice's bio")
      d.profiles.at("bob").bio.insert(0, "Bob's bio")
    })

    expect((doc as any).profiles.at("alice").bio()).toBe("Alice's bio")
    expect((doc as any).profiles.at("bob").bio()).toBe("Bob's bio")
  })

  it("subscribe fires on text edit inside record entry", () => {
    const doc = createYjsDoc(ProfileSchema)

    change(doc, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice" })
    })

    let fired = false
    subscribe(doc, () => {
      fired = true
    })

    change(doc, (d: any) => {
      d.profiles.at("alice").bio.insert(0, "Hello")
    })

    expect(fired).toBe(true)
  })

  it("syncs text-inside-record via snapshot", () => {
    const docA = createYjsDoc(ProfileSchema)

    change(docA, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice" })
    })
    change(docA, (d: any) => {
      d.profiles.at("alice").bio.insert(0, "Collaborative bio")
    })

    const snapshot = exportEntirety(docA)
    const docB = createYjsDocFromEntirety(ProfileSchema, snapshot)

    expect(docB.profiles()).toEqual({
      alice: { displayName: "Alice", bio: "Collaborative bio" },
    })

    // Text navigation works on the reconstructed doc
    expect((docB as any).profiles.at("alice").bio()).toBe("Collaborative bio")
  })

  it("syncs text-inside-record via delta", () => {
    const docA = createYjsDoc(ProfileSchema)

    change(docA, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice" })
    })

    // Establish docB from snapshot (consistent with Yjs test patterns —
    // two independently-created Y.Docs may share a clientID, causing
    // silent update drops)
    const docB = createYjsDocFromEntirety(ProfileSchema, exportEntirety(docA))
    const v0 = version(docB)

    change(docA, (d: any) => {
      d.profiles.at("alice").bio.insert(0, "Hello from A")
    })

    const delta = exportSince(docA, v0)
    expect(delta).not.toBeNull()
    merge(docB, delta!, "sync")

    expect(docB.profiles()).toEqual({
      alice: { displayName: "Alice", bio: "Hello from A" },
    })

    // Text on B is functional — can insert independently
    change(docB, (d: any) => {
      d.profiles.at("alice").bio.insert(12, "!")
    })
    expect((docB as any).profiles.at("alice").bio()).toBe("Hello from A!")
  })

  it("concurrent text edits inside record entries converge", () => {
    const docA = createYjsDoc(ProfileSchema)

    // Sync initial state: A creates the entry, B starts from snapshot
    change(docA, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice" })
    })
    const docB = createYjsDocFromEntirety(ProfileSchema, exportEntirety(docA))

    // Both peers edit concurrently
    const vA = version(docA)
    const vB = version(docB)

    change(docA, (d: any) => {
      d.profiles.at("alice").bio.insert(0, "Hello ")
    })
    change(docB, (d: any) => {
      d.profiles.at("alice").bio.insert(0, "World")
    })

    // Sync both ways
    const deltaAB = exportSince(docA, vB)
    const deltaBA = exportSince(docB, vA)
    expect(deltaAB).not.toBeNull()
    expect(deltaBA).not.toBeNull()
    merge(docB, deltaAB!, "sync")
    merge(docA, deltaBA!, "sync")

    // Both converge to the same value (order depends on client IDs)
    expect((docA as any).profiles.at("alice").bio()).toBe(
      (docB as any).profiles.at("alice").bio(),
    )
  })
})

// ===========================================================================
// text-inside-struct-inside-list
// ===========================================================================

describe("text-inside-struct-inside-list", () => {
  it("push a struct with text field omitted and read it back", () => {
    const doc = createYjsDoc(ListProfileSchema)

    change(doc, (d: any) => {
      d.players.push({ name: "Alice" })
    })

    expect(doc.players.length).toBe(1)
    expect((doc as any).players.at(0).name()).toBe("Alice")
    expect((doc as any).players.at(0).bio()).toBe("")
  })

  it("push a struct with text field provided and read it back", () => {
    const doc = createYjsDoc(ListProfileSchema)

    change(doc, (d: any) => {
      d.players.push({ name: "Alice", bio: "Hi there" })
    })

    expect(doc.players.length).toBe(1)
    expect((doc as any).players.at(0).name()).toBe("Alice")
    expect((doc as any).players.at(0).bio()).toBe("Hi there")
  })

  it("insert text into a text field inside a list item (field omitted at creation)", () => {
    const doc = createYjsDoc(ListProfileSchema)

    change(doc, (d: any) => {
      d.players.push({ name: "Alice" })
    })

    change(doc, (d: any) => {
      d.players.at(0).bio.insert(0, "Alice's bio")
    })

    expect((doc as any).players.at(0).bio()).toBe("Alice's bio")
  })

  it("multiple list items with independent text fields", () => {
    const doc = createYjsDoc(ListProfileSchema)

    change(doc, (d: any) => {
      d.players.push({ name: "Alice" })
      d.players.push({ name: "Bob" })
    })

    change(doc, (d: any) => {
      d.players.at(0).bio.insert(0, "Alice's bio")
      d.players.at(1).bio.insert(0, "Bob's bio")
    })

    expect((doc as any).players.at(0).bio()).toBe("Alice's bio")
    expect((doc as any).players.at(1).bio()).toBe("Bob's bio")
  })

  it("syncs list-of-struct-with-text via delta", () => {
    const docA = createYjsDoc(ListProfileSchema)

    change(docA, (d: any) => {
      d.players.push({ name: "Alice" })
    })

    // Establish docB from snapshot (avoids Yjs clientID collision)
    const docB = createYjsDocFromEntirety(
      ListProfileSchema,
      exportEntirety(docA),
    )
    const v0 = version(docB)

    change(docA, (d: any) => {
      d.players.at(0).bio.insert(0, "Synced bio")
    })

    const delta = exportSince(docA, v0)
    expect(delta).not.toBeNull()
    merge(docB, delta!, "sync")

    expect(docB.players.length).toBe(1)
    expect((docB as any).players.at(0).name()).toBe("Alice")
    expect((docB as any).players.at(0).bio()).toBe("Synced bio")
  })
})
