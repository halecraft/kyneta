// A state-based merge announces what moved as finely as the store keeps it, so
// a subscriber below a top-level field hears a change inside it — the
// presence use case: one peer's cursor, watched on its own.

import { describe, expect, it } from "vitest"
import { deleted, Schema, subscribe, subscribeNode } from "../index.js"
import { peerOf, ship } from "./ephemeral-fixtures.js"

const Presence = Schema.struct({
  peers: Schema.record(Schema.struct({ cursor: Schema.number() })),
  outer: Schema.struct({ x: Schema.number(), y: Schema.number() }),
})

describe("a merge reaches subscribers below a top-level field", () => {
  it("a subscriber at one peer's cursor hears that peer move, and nothing else", () => {
    const local = peerOf(Presence)
    const remote = peerOf(Presence)
    remote.doc.peers.set("alice", { cursor: 1 })
    remote.doc.peers.set("bob", { cursor: 1 })
    ship(remote, local)

    const heard: string[] = []
    subscribeNode(local.doc.peers.at("alice")?.cursor, () =>
      heard.push("alice.cursor"),
    )
    subscribe(local.doc.peers.at("alice"), () => heard.push("alice"))
    subscribe(local.doc.outer.x, () => heard.push("outer.x"))
    subscribe(local.doc.outer.y, () => heard.push("outer.y"))

    remote.doc.peers.at("alice")?.cursor.set(5)
    remote.doc.outer.x.set(3)
    ship(remote, local)

    expect(local.doc.peers()).toEqual({
      alice: { cursor: 5 },
      bob: { cursor: 1 },
    })
    expect(heard.sort()).toEqual(["alice", "alice.cursor", "outer.x"])
  })

  it("a peer arriving is one map set at the roster, not a replace of it", () => {
    const local = peerOf(Presence)
    const remote = peerOf(Presence)
    remote.doc.peers.set("alice", { cursor: 1 })
    ship(remote, local)

    const changes: unknown[] = []
    subscribe(local.doc, cs => {
      for (const op of cs.changes) {
        changes.push([op.path.format(), op.change.type])
      }
    })
    remote.doc.peers.set("carol", { cursor: 0 })
    ship(remote, local)

    expect(changes).toEqual([["peers", "map"]])
  })
})

describe("refs across a merge", () => {
  it("a held entry stays alive, with its identity, while its key exists", () => {
    const local = peerOf(Presence)
    const remote = peerOf(Presence)
    remote.doc.peers.set("alice", { cursor: 1 })
    ship(remote, local)

    const alice = local.doc.peers.at("alice")
    const cursor = alice?.cursor

    remote.doc.peers.at("alice")?.cursor.set(2)
    ship(remote, local)
    expect(local.doc.peers.at("alice")).toBe(alice)
    expect(deleted(alice)).toBe(false)
    expect(cursor?.()).toBe(2)

    remote.doc.peers.set("bob", { cursor: 0 })
    ship(remote, local)
    expect(local.doc.peers.at("alice")).toBe(alice)
    expect(deleted(alice)).toBe(false)

    remote.doc.peers.delete("alice")
    ship(remote, local)
    expect(deleted(alice)).toBe(true)
    expect(deleted(cursor)).toBe(true)
    expect(local.doc.peers.at("alice")).toBeUndefined()
  })
})
