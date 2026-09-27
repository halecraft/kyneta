// stream — pure codec round-trip, tolerant parse, and a live egress→ingest
// round-trip proving the delivery-agnostic property over a two-peer bridge.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import type { ObsEvent } from "@kyneta/exchange"
import { Exchange } from "@kyneta/exchange"
import { loro } from "@kyneta/loro-schema"
import { batch, Schema } from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import {
  ingestObservations,
  parseObservation,
  serializeObservation,
  streamObservations,
} from "../stream.js"
import { attach, createWorldModel } from "../world.js"

// ---------------------------------------------------------------------------
// Pure codec
// ---------------------------------------------------------------------------

describe("stream — codec (pure)", () => {
  // Representative shapes across every layer the classifier cares about.
  const samples: Record<string, ObsEvent> = {
    "directory peer": {
      v: 1,
      seq: 0,
      t: 1,
      peerId: "alice",
      layer: "directory",
      kind: "peer",
      change: "peer-established",
      peer: "bob",
    } as ObsEvent,
    "directory doc": {
      v: 1,
      seq: 1,
      t: 2,
      peerId: "alice",
      layer: "directory",
      kind: "doc",
      change: "doc-created",
      docId: "d1",
    } as ObsEvent,
    "directory sync-state": {
      v: 1,
      seq: 2,
      t: 3,
      peerId: "alice",
      layer: "directory",
      kind: "sync-state",
      docId: "d1",
      peer: "bob",
      state: "pending",
    } as ObsEvent,
    "doc changeset": {
      v: 1,
      seq: 3,
      t: 4,
      peerId: "alice",
      layer: "doc",
      kind: "changeset",
      docId: "d1",
      origin: "local",
      replay: false,
      ops: [
        { type: "text", path: "/title" },
        { type: "replace", path: "/items/0/done" },
      ],
    } as ObsEvent,
    diagnostic: {
      v: 1,
      seq: 4,
      t: 5,
      peerId: "alice",
      layer: "diagnostic",
      kind: "diagnostic",
      code: "schema-hash-mismatch",
      severity: "error",
      peer: "bob",
      docId: "d1",
      local: "h1",
      remote: "h2",
      message: "hash mismatch",
    } as ObsEvent,
    engine: {
      v: 1,
      seq: 5,
      t: 6,
      peerId: "alice",
      layer: "engine",
      kind: "transition",
      program: "sync",
      summary: "idle→syncing",
    } as ObsEvent,
    wire: {
      v: 1,
      seq: 6,
      t: 7,
      peerId: "alice",
      layer: "wire",
      kind: "frame",
      dir: "send",
      frameSeq: 0,
      frameKind: "complete",
      size: 12,
    } as ObsEvent,
  }

  for (const [name, ev] of Object.entries(samples)) {
    // `toEqual` (not `toStrictEqual`): the producer emits explicit `undefined`
    // for some absent optionals, which `JSON.stringify` drops — `toEqual`
    // ignores undefined-valued keys; `toStrictEqual` would fail the round-trip.
    it(`round-trips a ${name} event`, () => {
      expect(parseObservation(serializeObservation(ev))).toEqual(ev)
    })
  }

  it("serializes to a single line (no embedded newline)", () => {
    for (const ev of Object.values(samples)) {
      expect(serializeObservation(ev)).not.toContain("\n")
    }
  })

  it("preserves the protocol version `v`", () => {
    const parsed = parseObservation(serializeObservation(samples.engine))
    expect(parsed?.v).toBe(1)
  })

  it("tolerant parse → undefined on blank/torn/scalar/identity-less input", () => {
    // Blank + torn JSON.
    expect(parseObservation("")).toBeUndefined()
    expect(parseObservation("   ")).toBeUndefined()
    expect(parseObservation("{")).toBeUndefined()
    expect(parseObservation("not json")).toBeUndefined()
    // Valid-JSON scalars — the regression the structural guard prevents.
    expect(parseObservation("null")).toBeUndefined()
    expect(parseObservation("42")).toBeUndefined()
    expect(parseObservation('"x"')).toBeUndefined()
    // Objects missing the envelope identity the key + classify depend on.
    expect(parseObservation("{}")).toBeUndefined()
    expect(parseObservation('{"peerId":"a"}')).toBeUndefined()
    expect(parseObservation('{"seq":0}')).toBeUndefined()
    // Minimal object carrying the identity → accepted (forward-compat layer).
    expect(parseObservation('{"peerId":"a","seq":0}')).toBeDefined()
  })

  it("ingestObservations skips malformed lines and never throws", () => {
    const model = createWorldModel()
    const lines = [
      serializeObservation(samples["directory peer"]),
      "torn {",
      "null",
      "",
      serializeObservation(samples["directory doc"]),
    ]
    expect(() => ingestObservations(lines, model)).not.toThrow()
    expect(model.peers.has("bob")).toBe(true)
    expect(model.documents.has("d1")).toBe(true)
    model.dispose()
  })
})

// ---------------------------------------------------------------------------
// Egress → ingest round-trip (integration, two peers)
// ---------------------------------------------------------------------------

const TodoDoc = loro.bind(
  Schema.struct({
    title: Schema.text(),
    items: Schema.list(
      Schema.struct({ text: Schema.string(), done: Schema.boolean() }),
    ),
  }),
)

async function drain(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

const active: Exchange[] = []
function peer(id: string, bridge: Bridge): Exchange {
  const ex = new Exchange({
    principal: id,
    transports: [createBridgeTransport({ transportId: id, bridge })],
    schemas: [TodoDoc],
  })
  active.push(ex)
  return ex
}
afterEach(async () => {
  for (const ex of active) {
    try {
      await ex.shutdown()
    } catch {
      /* ignore */
    }
  }
  active.length = 0
})

function sortedEntries(map: {
  current: ReadonlyMap<string, unknown>
}): [string, unknown][] {
  return [...map.current.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
}

describe("stream — egress → ingest round-trip (two peers)", () => {
  it("reconstructs the same peers/documents/syncStates a direct attach reaches", async () => {
    const bridge = new Bridge()
    const alice = peer("alice", bridge)
    const bob = peer("bob", bridge)

    // The reference: one merged model fed by direct `attach` on both peers.
    const direct = createWorldModel()
    const offDA = attach(alice, direct)
    const offDB = attach(bob, direct)

    // The proof: capture both peers' NDJSON egress (live bus → no replay, so
    // subscribe before any activity).
    const lines: string[] = []
    const offSA = streamObservations(alice, l => lines.push(l))
    const offSB = streamObservations(bob, l => lines.push(l))

    const aDoc = alice.get("d", TodoDoc)
    bob.get("d", TodoDoc)
    await drain()
    batch(aDoc, (d: { title: { insert: (i: number, s: string) => void } }) =>
      d.title.insert(0, "Hi"),
    )
    await drain()

    offDA()
    offDB()
    offSA()
    offSB()

    // Each captured element is exactly one record + "\n" — fold it back with no
    // Exchange into a fresh model.
    const ingested = createWorldModel()
    ingestObservations(lines, ingested)

    expect(sortedEntries(ingested.peers)).toEqual(sortedEntries(direct.peers))
    expect(sortedEntries(ingested.documents)).toEqual(
      sortedEntries(direct.documents),
    )
    expect(sortedEntries(ingested.syncStates)).toEqual(
      sortedEntries(direct.syncStates),
    )
    // Sanity: the run actually reached `synced` (otherwise the equality is vacuous).
    expect(
      [...ingested.syncStates.current.values()].some(
        s => s.docId === "d" && s.state === "synced",
      ),
    ).toBe(true)

    direct.dispose()
    ingested.dispose()
  })
})

// ---------------------------------------------------------------------------
// Detach (deterministic, via a fake bus)
// ---------------------------------------------------------------------------

function fakeBus(): {
  observe: (sink: (e: ObsEvent) => void) => () => void
  emit: (e: ObsEvent) => void
} {
  const sinks = new Set<(e: ObsEvent) => void>()
  return {
    observe(sink) {
      sinks.add(sink)
      return () => sinks.delete(sink)
    },
    emit(e) {
      for (const sink of sinks) sink(e)
    },
  }
}

describe("stream — detach", () => {
  it("streamObservations detach stops emission", () => {
    const bus = fakeBus()
    const lines: string[] = []
    const ev: ObsEvent = {
      v: 1,
      seq: 0,
      t: 0,
      peerId: "a",
      layer: "engine",
      kind: "transition",
      program: "sync",
      summary: "x",
    } as ObsEvent
    const off = streamObservations({ observe: bus.observe }, l => lines.push(l))
    bus.emit(ev)
    expect(lines).toHaveLength(1)
    off()
    bus.emit({ ...ev, seq: 1 })
    expect(lines).toHaveLength(1) // no new line after detach
  })
})
