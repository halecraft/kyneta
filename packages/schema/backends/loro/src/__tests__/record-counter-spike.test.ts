// record-counter-spike — validate the bumper-cars scoreboard pattern.
//
// The bumper-cars scoreboard needs:
//   Schema.record(Schema.struct({ name: Schema.string(), color: Schema.string(), bumps: Schema.counter() }))
//
// This nests a LoroCounter inside a LoroMap (the struct) inside another
// LoroMap (the record). The key operations are:
//   1. .set(peerId, { name, color }) — insert a new player score entry
//   2. .at(peerId).bumps.increment(1) — increment a player's bump count
//   3. Reading back: doc.scores() should return { [peerId]: { name, color, bumps } }
//   4. Sync: two peers should converge after exchanging deltas
//
// This spike tests the full vertical: schema → substrate → change → read → sync.

import { describe, expect, it } from "vitest"
import {
  change,
  createDoc,
  exportEntirety,
  exportSince,
  loro,
  merge,
  Schema,
  subscribe,
  version,
} from "../index.js"

// ===========================================================================
// Scoreboard schema — the bumper-cars pattern
// ===========================================================================

const PlayerScoreSchema = Schema.struct({
  name: Schema.string(),
  color: Schema.string(),
  bumps: Schema.counter(),
})

const ScoreboardSchema = Schema.struct({
  scores: Schema.record(PlayerScoreSchema),
})
const boundScoreboard = loro.bind(ScoreboardSchema)

// ===========================================================================
// Simpler variant: record of plain struct (no counter) — baseline
// ===========================================================================

const PlainScoreSchema = Schema.struct({
  name: Schema.string(),
  color: Schema.string(),
  points: Schema.number(),
})

const PlainScoreboardSchema = Schema.struct({
  scores: Schema.record(PlainScoreSchema),
})
const boundPlainScoreboard = loro.bind(PlainScoreboardSchema)

// ===========================================================================
// Tests
// ===========================================================================

describe("record-of-struct (plain baseline)", () => {
  it("set a record entry and read it back", () => {
    const doc = createDoc(boundPlainScoreboard)

    change(doc, (d: any) => {
      d.scores.set("alice", { name: "Alice", color: "#FF0000", points: 0 })
    })

    const snapshot = doc.scores()
    expect(snapshot).toEqual({
      alice: { name: "Alice", color: "#FF0000", points: 0 },
    })
  })

  it("set multiple entries and read all back", () => {
    const doc = createDoc(boundPlainScoreboard)

    change(doc, (d: any) => {
      d.scores.set("alice", { name: "Alice", color: "#FF0000", points: 0 })
      d.scores.set("bob", { name: "Bob", color: "#0000FF", points: 0 })
    })

    const snapshot = doc.scores()
    expect(snapshot).toEqual({
      alice: { name: "Alice", color: "#FF0000", points: 0 },
      bob: { name: "Bob", color: "#0000FF", points: 0 },
    })
  })

  it("navigate into a record entry via .at()", () => {
    const doc = createDoc(boundPlainScoreboard)

    change(doc, (d: any) => {
      d.scores.set("alice", { name: "Alice", color: "#FF0000", points: 0 })
    })

    const entry = (doc as any).scores.at("alice")
    expect(entry).toBeDefined()
    expect(entry.name()).toBe("Alice")
    expect(entry.color()).toBe("#FF0000")
    expect(entry.points()).toBe(0)
  })

  it("mutate a field inside a record entry via .at().field.set()", () => {
    const doc = createDoc(boundPlainScoreboard)

    change(doc, (d: any) => {
      d.scores.set("alice", { name: "Alice", color: "#FF0000", points: 0 })
    })

    change(doc, (d: any) => {
      d.scores.at("alice").points.set(5)
    })

    expect((doc as any).scores.at("alice").points()).toBe(5)
  })

  it("syncs record-of-struct between two peers", () => {
    const docA = createDoc(boundPlainScoreboard)

    change(docA, (d: any) => {
      d.scores.set("alice", { name: "Alice", color: "#FF0000", points: 3 })
    })

    const snapshot = exportEntirety(docA)
    const docB = createDoc(boundPlainScoreboard, snapshot)

    expect(docB.scores()).toEqual({
      alice: { name: "Alice", color: "#FF0000", points: 3 },
    })

    // Mutate on A, sync delta to B
    const v0 = version(docB)
    change(docA, (d: any) => {
      d.scores.set("bob", { name: "Bob", color: "#0000FF", points: 1 })
    })
    const delta = exportSince(docA, v0)
    expect(delta).not.toBeNull()
    merge(docB, delta!, "sync")

    expect(docB.scores()).toEqual({
      alice: { name: "Alice", color: "#FF0000", points: 3 },
      bob: { name: "Bob", color: "#0000FF", points: 1 },
    })
  })
})

describe("record-of-struct-with-counter (bumper-cars scoreboard)", () => {
  it("set a record entry with counter and read it back", () => {
    const doc = createDoc(boundScoreboard)

    change(doc, (d: any) => {
      d.scores.set("alice", { name: "Alice", color: "#FF0000" })
    })

    const snapshot = doc.scores()
    expect(snapshot).toEqual({
      alice: { name: "Alice", color: "#FF0000", bumps: 0 },
    })
  })

  it("navigate into a record entry and read the counter", () => {
    const doc = createDoc(boundScoreboard)

    change(doc, (d: any) => {
      d.scores.set("alice", { name: "Alice", color: "#FF0000" })
    })

    const entry = (doc as any).scores.at("alice")
    expect(entry).toBeDefined()
    expect(entry.name()).toBe("Alice")
    expect(entry.color()).toBe("#FF0000")
    expect(entry.bumps()).toBe(0)
  })

  it("increment a counter inside a record entry via .at().bumps.increment()", () => {
    const doc = createDoc(boundScoreboard)

    change(doc, (d: any) => {
      d.scores.set("alice", { name: "Alice", color: "#FF0000" })
    })

    change(doc, (d: any) => {
      const score = d.scores.at("alice")
      score.bumps.increment(1)
    })

    expect((doc as any).scores.at("alice").bumps()).toBe(1)
  })

  it("multiple increments accumulate", () => {
    const doc = createDoc(boundScoreboard)

    change(doc, (d: any) => {
      d.scores.set("alice", { name: "Alice", color: "#FF0000" })
    })

    change(doc, (d: any) => d.scores.at("alice").bumps.increment(1))
    change(doc, (d: any) => d.scores.at("alice").bumps.increment(1))
    change(doc, (d: any) => d.scores.at("alice").bumps.increment(3))

    expect((doc as any).scores.at("alice").bumps()).toBe(5)

    const snapshot = doc.scores()
    expect(snapshot.alice.bumps).toBe(5)
  })

  it("increment counters on multiple entries independently", () => {
    const doc = createDoc(boundScoreboard)

    change(doc, (d: any) => {
      d.scores.set("alice", { name: "Alice", color: "#FF0000" })
      d.scores.set("bob", { name: "Bob", color: "#0000FF" })
    })

    change(doc, (d: any) => {
      d.scores.at("alice").bumps.increment(3)
      d.scores.at("bob").bumps.increment(7)
    })

    expect((doc as any).scores.at("alice").bumps()).toBe(3)
    expect((doc as any).scores.at("bob").bumps()).toBe(7)

    const snapshot = doc.scores()
    expect(snapshot).toEqual({
      alice: { name: "Alice", color: "#FF0000", bumps: 3 },
      bob: { name: "Bob", color: "#0000FF", bumps: 7 },
    })
  })

  it("subscribe fires on counter increment inside record entry", () => {
    const doc = createDoc(boundScoreboard)

    change(doc, (d: any) => {
      d.scores.set("alice", { name: "Alice", color: "#FF0000" })
    })

    let fired = false
    subscribe(doc, () => {
      fired = true
    })

    change(doc, (d: any) => d.scores.at("alice").bumps.increment(1))

    expect(fired).toBe(true)
  })

  it("syncs record-with-counter between two peers via snapshot", () => {
    const docA = createDoc(boundScoreboard)

    change(docA, (d: any) => {
      d.scores.set("alice", { name: "Alice", color: "#FF0000" })
    })
    change(docA, (d: any) => d.scores.at("alice").bumps.increment(5))

    const snapshot = exportEntirety(docA)
    const docB = createDoc(boundScoreboard, snapshot)

    expect(docB.scores()).toEqual({
      alice: { name: "Alice", color: "#FF0000", bumps: 5 },
    })

    // Counter navigation works on the reconstructed doc
    expect((docB as any).scores.at("alice").bumps()).toBe(5)
  })

  it("syncs record-with-counter between two peers via delta", () => {
    const docA = createDoc(boundScoreboard)
    const docB = createDoc(boundScoreboard)

    const v0 = version(docB)

    change(docA, (d: any) => {
      d.scores.set("alice", { name: "Alice", color: "#FF0000" })
    })
    change(docA, (d: any) => d.scores.at("alice").bumps.increment(3))

    const delta = exportSince(docA, v0)
    expect(delta).not.toBeNull()
    merge(docB, delta!, "sync")

    expect(docB.scores()).toEqual({
      alice: { name: "Alice", color: "#FF0000", bumps: 3 },
    })

    // Counter on B is functional — can increment independently
    change(docB, (d: any) => d.scores.at("alice").bumps.increment(2))
    expect((docB as any).scores.at("alice").bumps()).toBe(5)
  })

  it("concurrent counter increments from two peers converge", () => {
    const docA = createDoc(boundScoreboard)
    const docB = createDoc(boundScoreboard)

    // Sync initial state: A creates the entry, syncs to B
    change(docA, (d: any) => {
      d.scores.set("alice", { name: "Alice", color: "#FF0000" })
    })

    const snapshot = exportEntirety(docA)
    merge(docB, snapshot, "sync")

    // Both peers increment concurrently
    const vA = version(docA)
    const vB = version(docB)

    change(docA, (d: any) => d.scores.at("alice").bumps.increment(3))
    change(docB, (d: any) => d.scores.at("alice").bumps.increment(7))

    // Sync A → B
    const deltaAB = exportSince(docA, vB)
    expect(deltaAB).not.toBeNull()
    merge(docB, deltaAB!, "sync")

    // Sync B → A
    const deltaBA = exportSince(docB, vA)
    expect(deltaBA).not.toBeNull()
    merge(docA, deltaBA!, "sync")

    // Both converge: 3 + 7 = 10 (counters sum, not overwrite)
    expect((docA as any).scores.at("alice").bumps()).toBe(10)
    expect((docB as any).scores.at("alice").bumps()).toBe(10)
  })

  it("full game scenario: multiple players, concurrent bumps, convergence", () => {
    const server = createDoc(boundScoreboard)
    const clientA = createDoc(boundScoreboard)
    const clientB = createDoc(boundScoreboard)

    // Server creates entries for both players
    change(server, (d: any) => {
      d.scores.set("peerA", { name: "Alice", color: "#FF6B6B" })
      d.scores.set("peerB", { name: "Bob", color: "#54A0FF" })
    })

    // Sync server → both clients
    const snapshot = exportEntirety(server)
    merge(clientA, snapshot, "sync")
    merge(clientB, snapshot, "sync")

    // Server detects collision: peerA scored
    const v0A = version(clientA)
    const _v0B = version(clientB)

    change(server, (d: any) => {
      d.scores.at("peerA").bumps.increment(1)
    })

    // Sync server → both clients
    const delta1 = exportSince(server, v0A)
    merge(clientA, delta1!, "sync")
    merge(clientB, delta1!, "sync")

    expect((clientA as any).scores.at("peerA").bumps()).toBe(1)
    expect((clientB as any).scores.at("peerA").bumps()).toBe(1)
    expect((clientA as any).scores.at("peerB").bumps()).toBe(0)

    // More collisions — peerB scores twice
    const v1A = version(clientA)
    change(server, (d: any) => {
      d.scores.at("peerB").bumps.increment(1)
    })
    change(server, (d: any) => {
      d.scores.at("peerB").bumps.increment(1)
    })

    const delta2 = exportSince(server, v1A)
    merge(clientA, delta2!, "sync")
    merge(clientB, delta2!, "sync")

    // Final state
    const expected = {
      peerA: { name: "Alice", color: "#FF6B6B", bumps: 1 },
      peerB: { name: "Bob", color: "#54A0FF", bumps: 2 },
    }

    expect(server.scores()).toEqual(expected)
    expect(clientA.scores()).toEqual(expected)
    expect(clientB.scores()).toEqual(expected)
  })
})

// ===========================================================================
// Generality: list-of-struct-with-counter
// ===========================================================================

const ListScoreSchema = Schema.struct({
  players: Schema.list(
    Schema.struct({
      name: Schema.string(),
      bumps: Schema.counter(),
    }),
  ),
})
const boundListScore = loro.bind(ListScoreSchema)

describe("list-of-struct-with-counter (generality check)", () => {
  it("push a struct with counter into a list and read it back", () => {
    const doc = createDoc(boundListScore)

    change(doc, (d: any) => {
      d.players.push({ name: "Alice" })
    })

    expect(doc.players.length).toBe(1)
    expect((doc as any).players.at(0).name()).toBe("Alice")
    expect((doc as any).players.at(0).bumps()).toBe(0)
  })

  it("increment a counter inside a list item", () => {
    const doc = createDoc(boundListScore)

    change(doc, (d: any) => {
      d.players.push({ name: "Alice" })
    })

    change(doc, (d: any) => {
      d.players.at(0).bumps.increment(3)
    })

    expect((doc as any).players.at(0).bumps()).toBe(3)
  })

  it("push with explicit counter value", () => {
    const doc = createDoc(boundListScore)

    change(doc, (d: any) => {
      d.players.push({ name: "Alice", bumps: 5 })
    })

    expect((doc as any).players.at(0).bumps()).toBe(5)
  })

  it("multiple list items with independent counters", () => {
    const doc = createDoc(boundListScore)

    change(doc, (d: any) => {
      d.players.push({ name: "Alice" })
      d.players.push({ name: "Bob" })
    })

    change(doc, (d: any) => {
      d.players.at(0).bumps.increment(2)
      d.players.at(1).bumps.increment(7)
    })

    expect((doc as any).players.at(0).bumps()).toBe(2)
    expect((doc as any).players.at(1).bumps()).toBe(7)
  })

  it("syncs list-of-struct-with-counter via delta", () => {
    const docA = createDoc(boundListScore)
    const docB = createDoc(boundListScore)

    const v0 = version(docB)

    change(docA, (d: any) => {
      d.players.push({ name: "Alice" })
    })
    change(docA, (d: any) => {
      d.players.at(0).bumps.increment(4)
    })

    const delta = exportSince(docA, v0)
    merge(docB, delta!, "sync")

    expect(docB.players.length).toBe(1)
    expect((docB as any).players.at(0).name()).toBe("Alice")
    expect((docB as any).players.at(0).bumps()).toBe(4)
  })
})

// ===========================================================================
// Generality: text-inside-struct-inside-record
// ===========================================================================

const ProfileSchema = Schema.struct({
  profiles: Schema.record(
    Schema.struct({
      displayName: Schema.string(),
      bio: Schema.text(),
    }),
  ),
})
const boundProfile = loro.bind(ProfileSchema)

describe("text-inside-struct-inside-record (generality check)", () => {
  it("set a record entry with text and read it back", () => {
    const doc = createDoc(boundProfile)

    change(doc, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice" })
    })

    const snapshot = doc.profiles()
    expect(snapshot).toEqual({
      alice: { displayName: "Alice", bio: "" },
    })
  })

  it("navigate into a record entry and read the text", () => {
    const doc = createDoc(boundProfile)

    change(doc, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice" })
    })

    expect((doc as any).profiles.at("alice").bio()).toBe("")
  })

  it("insert text into a text field inside a record entry", () => {
    const doc = createDoc(boundProfile)

    change(doc, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice" })
    })

    change(doc, (d: any) => {
      d.profiles.at("alice").bio.insert(0, "Hello world")
    })

    expect((doc as any).profiles.at("alice").bio()).toBe("Hello world")
  })

  it("set entry with initial text value", () => {
    const doc = createDoc(boundProfile)

    change(doc, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice", bio: "Hi there" })
    })

    expect((doc as any).profiles.at("alice").bio()).toBe("Hi there")
  })

  it("syncs text-inside-record via delta", () => {
    const docA = createDoc(boundProfile)
    const docB = createDoc(boundProfile)

    const v0 = version(docB)

    change(docA, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice" })
    })
    change(docA, (d: any) => {
      d.profiles.at("alice").bio.insert(0, "Collaborative bio")
    })

    const delta = exportSince(docA, v0)
    merge(docB, delta!, "sync")

    expect((docB as any).profiles.at("alice").bio()).toBe("Collaborative bio")
  })

  it("concurrent text edits inside record entries converge", () => {
    const docA = createDoc(boundProfile)
    const docB = createDoc(boundProfile)

    // Sync initial state
    change(docA, (d: any) => {
      d.profiles.set("alice", { displayName: "Alice" })
    })
    const snapshot = exportEntirety(docA)
    merge(docB, snapshot, "sync")

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
    merge(docB, deltaAB!, "sync")
    merge(docA, deltaBA!, "sync")

    // Both converge to the same value (order depends on peer IDs)
    expect((docA as any).profiles.at("alice").bio()).toBe(
      (docB as any).profiles.at("alice").bio(),
    )
  })
})
