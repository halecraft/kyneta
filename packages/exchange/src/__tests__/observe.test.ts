// observe — DevTools observation bus.
//
// Two tiers: pure-mapper units (no Exchange, no drain — the functional core)
// and two-peer integration over a real Bridge (the end-to-end coherence the
// prototype demonstrated, now through the bus). Context: jj:qpmkoryn.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { loro } from "@kyneta/loro-schema"
import { batch, json, Schema, unwrap } from "@kyneta/schema"
import { defined } from "@kyneta/schema/testing"
import { yjs } from "@kyneta/yjs-schema"
import { describe, expect, it } from "vitest"
import {
  createObservationBus,
  frameTraceToBody,
  type ObsEvent,
  observeInput,
  observeSessionEffect,
  observeSyncEffect,
  summarizeChangeset,
} from "../observe.js"
import type { SessionEffect, SessionInput } from "../session-program.js"
import type { SyncEffect, SyncInput } from "../sync-program.js"
import { drain, exchangesPerTest } from "./exchanges.js"

// ---------------------------------------------------------------------------
// Pure mappers — the functional core
// ---------------------------------------------------------------------------

describe("observe — pure mappers", () => {
  it("session send → protocol-out with channelId", () => {
    const fx: SessionEffect = {
      type: "send",
      to: 7,
      message: {
        type: "establish",
        identity: { peerId: "bob", principal: "bob", type: "user" },
        protocolVersion: { major: 1, minor: 0 },
      },
    }
    expect(observeSessionEffect(fx)).toEqual([
      {
        layer: "protocol",
        kind: "message",
        dir: "out",
        channelId: 7,
        msgType: "establish",
        docId: undefined,
        version: undefined,
        docs: undefined,
      },
    ])
  })

  it("emit-peer-events → one directory peer event per change", () => {
    const fx: SessionEffect = {
      type: "emit-peer-events",
      events: [
        {
          type: "peer-established",
          peer: { peerId: "bob", principal: "bob", type: "user" },
        },
        {
          type: "peer-departed",
          peer: { peerId: "carol", principal: "carol", type: "user" },
        },
      ],
    }
    expect(observeSessionEffect(fx)).toEqual([
      {
        layer: "directory",
        kind: "peer",
        change: "peer-established",
        peer: "bob",
      },
      {
        layer: "directory",
        kind: "peer",
        change: "peer-departed",
        peer: "carol",
      },
    ])
  })

  it("session + sync diagnostic effects → structured diagnostic bodies", () => {
    expect(
      observeSessionEffect({
        type: "diagnostic",
        code: "protocol-mismatch",
        severity: "error",
        peer: "bob",
        local: "v1.0",
        remote: "v2.0",
        message: "skew",
      }),
    ).toEqual([
      {
        layer: "diagnostic",
        kind: "diagnostic",
        code: "protocol-mismatch",
        severity: "error",
        peer: "bob",
        local: "v1.0",
        remote: "v2.0",
        message: "skew",
      },
    ])
    expect(
      observeSyncEffect({
        type: "diagnostic",
        code: "schema-hash-mismatch",
        severity: "error",
        peer: "bob",
        docId: "d1",
        local: "h1",
        remote: "h2",
        message: "hash mismatch",
      }),
    ).toEqual([
      {
        layer: "diagnostic",
        kind: "diagnostic",
        code: "schema-hash-mismatch",
        severity: "error",
        peer: "bob",
        docId: "d1",
        local: "h1",
        remote: "h2",
        message: "hash mismatch",
      },
    ])
  })

  it("send-to-peer → protocol-out with peer + docId", () => {
    const fx: SyncEffect = {
      type: "send-to-peer",
      to: "bob",
      message: { type: "interest", docId: "d1", version: "v1" },
    }
    expect(observeSyncEffect(fx)).toEqual([
      {
        layer: "protocol",
        kind: "message",
        dir: "out",
        peer: "bob",
        msgType: "interest",
        docId: "d1",
        version: "v1",
        docs: undefined,
      },
    ])
  })

  it("send-offers → one offer per target peer", () => {
    const fx: SyncEffect = {
      type: "send-offers",
      docId: "d1",
      to: [
        { peerId: "a", sinceVersion: "v9" },
        { peerId: "b", sinceVersion: "v8" },
      ],
    }
    expect(observeSyncEffect(fx)).toEqual([
      {
        layer: "protocol",
        kind: "message",
        dir: "out",
        peer: "a",
        msgType: "offer",
        docId: "d1",
        version: "v9",
      },
      {
        layer: "protocol",
        kind: "message",
        dir: "out",
        peer: "b",
        msgType: "offer",
        docId: "d1",
        version: "v8",
      },
    ])
  })

  it("emit-doc-events → directory doc events", () => {
    const fx: SyncEffect = {
      type: "emit-doc-events",
      events: [{ type: "doc-created", docId: "d1" }],
    }
    expect(observeSyncEffect(fx)).toEqual([
      { layer: "directory", kind: "doc", change: "doc-created", docId: "d1" },
    ])
  })

  it("inbound message-received → protocol-in", () => {
    const sess: SessionInput = {
      type: "sess/message-received",
      fromChannelId: 3,
      message: { type: "depart" },
    }
    expect(observeInput(sess)).toEqual([
      {
        layer: "protocol",
        kind: "message",
        dir: "in",
        channelId: 3,
        msgType: "depart",
        docId: undefined,
        version: undefined,
        docs: undefined,
      },
    ])

    const sync = {
      type: "sync/message-received",
      from: "bob",
      message: { type: "offer", docId: "d1", version: "v2", payload: {} },
    } as unknown as SyncInput
    expect(observeInput(sync)).toEqual([
      {
        layer: "protocol",
        kind: "message",
        dir: "in",
        peer: "bob",
        msgType: "offer",
        docId: "d1",
        version: "v2",
        docs: undefined,
      },
    ])
  })

  it("non-observable effects map to []", () => {
    expect(
      observeSyncEffect({ type: "emit-state-advanced", docIds: ["d1"] }),
    ).toEqual([])
    expect(
      observeSessionEffect({ type: "cancel-departure-timer", peerId: "bob" }),
    ).toEqual([])
    expect(observeInput({ type: "sync/tick-quiescent" })).toEqual([])
  })

  it("summarizeChangeset uses Path.format() and carries provenance", () => {
    const cs = {
      origin: "sync",
      replay: true,
      changes: [
        { path: { format: () => "/title" }, change: { type: "text" } },
        {
          path: { format: () => "/items/0/done" },
          change: { type: "replace" },
        },
      ],
    }
    expect(summarizeChangeset("d1", cs as never)).toEqual({
      layer: "doc",
      kind: "changeset",
      docId: "d1",
      origin: "sync",
      replay: true,
      aborted: undefined,
      ops: [
        { type: "text", path: "/title" },
        { type: "replace", path: "/items/0/done" },
      ],
    })
  })
})

// ---------------------------------------------------------------------------
// Bus mechanics
// ---------------------------------------------------------------------------

describe("observe — bus", () => {
  it("is disabled until subscribed, live (no replay), and re-disables", () => {
    const bus = createObservationBus("alice")
    expect(bus.enabled).toBe(false)

    bus.publish({
      layer: "diagnostic",
      kind: "diagnostic",
      code: "self-connection",
      severity: "warning",
      peer: "bob",
      message: "dropped",
    })

    const seen: ObsEvent[] = []
    const off = bus.subscribe(e => seen.push(e))
    expect(bus.enabled).toBe(true)
    expect(seen).toHaveLength(0) // live stream — the pre-subscribe event is not replayed

    bus.publish({
      layer: "diagnostic",
      kind: "diagnostic",
      code: "self-connection",
      severity: "error",
      peer: "bob",
      message: "boom",
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      v: 1,
      seq: 0,
      peerId: "alice",
      layer: "diagnostic",
      message: "boom",
    })
    expect(typeof seen[0]?.t).toBe("number")

    off()
    expect(bus.enabled).toBe(false)
  })

  it("swallows sink errors (fire-and-forget)", () => {
    const bus = createObservationBus("alice")
    const seen: ObsEvent[] = []
    bus.subscribe(() => {
      throw new Error("bad sink")
    })
    bus.subscribe(e => seen.push(e))
    expect(() =>
      bus.publish({
        layer: "engine",
        kind: "transition",
        program: "sync",
        summary: "x",
      }),
    ).not.toThrow()
    expect(seen).toHaveLength(1) // the throwing sink does not block the other
  })

  it("stamps a monotonic, unique envelope seq across mixed layers", () => {
    // Regression (jj:qpmkoryn): a wire body once declared `seq`, which the
    // publish spread let shadow the envelope's monotonic id — breaking ordering
    // and colliding the `${peerId}:${seq}` event-log key (silent drops
    // downstream). The frame id now lives in its own `frameSeq` field.
    const bus = createObservationBus("alice")
    const seen: ObsEvent[] = []
    bus.subscribe(e => seen.push(e))

    // Frame seqs deliberately collide (both 0); they must NOT leak into seq.
    bus.publish(
      frameTraceToBody({ dir: "send", seq: 0, kind: "complete", size: 12 }),
    )
    bus.publish({
      layer: "protocol",
      kind: "message",
      dir: "out",
      msgType: "present",
    })
    bus.publish(
      frameTraceToBody({ dir: "receive", seq: 0, kind: "complete", size: 8 }),
    )

    // Envelope seq is the bus counter: strictly increasing and unique.
    expect(seen.map(e => e.seq)).toEqual([0, 1, 2])
    expect(new Set(seen.map(e => e.seq)).size).toBe(seen.length)

    // The frame id survives in its own field; repeats there are fine.
    const wire = seen.filter(e => e.layer === "wire")
    expect(wire).toHaveLength(2)
    expect(wire.map(e => (e.layer === "wire" ? e.frameSeq : -1))).toEqual([
      0, 0,
    ])
    expect(wire.map(e => e.seq)).toEqual([0, 2])
  })
})

// ---------------------------------------------------------------------------
// Integration — two peers over a Bridge
// ---------------------------------------------------------------------------

const TodoDoc = loro.bind(
  Schema.struct({
    title: Schema.text(),
    items: Schema.list(
      Schema.struct({ text: Schema.string(), done: Schema.boolean() }),
    ),
  }),
)

const createExchange = exchangesPerTest()

describe("observe — integration (two peers, one bridge)", () => {
  it("threads a local batch end-to-end across all Phase-1 layers", async () => {
    const bridge = new Bridge()
    const alice = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [TodoDoc],
    })
    const bob = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [TodoDoc],
    })

    const a: ObsEvent[] = []
    const b: ObsEvent[] = []
    alice.observe(e => a.push(e))
    bob.observe(e => b.push(e))

    const aDoc = alice.get("d", TodoDoc)
    bob.get("d", TodoDoc)
    await drain()

    batch(
      aDoc,
      (d: {
        title: { insert: (i: number, s: string) => void }
        items: { push: (v: unknown) => void }
      }) => {
        d.title.insert(0, "Hi")
        d.items.push({ text: "one", done: false })
      },
    )
    await drain()

    // doc: local on alice, replay on bob
    expect(
      a.some(e => e.layer === "doc" && e.kind === "changeset" && !e.replay),
    ).toBe(true)
    expect(
      b.some(e => e.layer === "doc" && e.kind === "changeset" && e.replay),
    ).toBe(true)
    // protocol: present + offer flow out from alice
    expect(
      a.some(
        e =>
          e.layer === "protocol" && e.dir === "out" && e.msgType === "present",
      ),
    ).toBe(true)
    expect(
      a.some(
        e => e.layer === "protocol" && e.dir === "out" && e.msgType === "offer",
      ),
    ).toBe(true)
    // protocol: bob received messages
    expect(b.some(e => e.layer === "protocol" && e.dir === "in")).toBe(true)
    // directory: both saw the other establish
    expect(
      a.some(
        e =>
          e.layer === "directory" &&
          e.kind === "peer" &&
          e.change === "peer-established",
      ),
    ).toBe(true)
    expect(b.some(e => e.layer === "directory" && e.kind === "doc")).toBe(true)
    // engine: both programs transitioned
    expect(a.some(e => e.layer === "engine" && e.program === "session")).toBe(
      true,
    )
    expect(a.some(e => e.layer === "engine" && e.program === "sync")).toBe(true)
    // directory: authoritative per-peer-doc sync-state reaches `synced` on both
    const syncedOn = (evs: ObsEvent[]) =>
      evs.some(
        e =>
          e.layer === "directory" &&
          e.kind === "sync-state" &&
          e.docId === "d" &&
          e.state === "synced",
      )
    expect(syncedOn(a)).toBe(true)
    expect(syncedOn(b)).toBe(true)
  })

  it("reports a native write as local where it was made, and a replay where it arrived", async () => {
    // An editor binding writes on the native document, not through `batch`.
    const NoteDoc = yjs.bind(Schema.struct({ title: Schema.text() }))
    const bridge = new Bridge()
    const alice = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })
    const bob = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })
    const aDoc = alice.get("note", NoteDoc)
    bob.get("note", NoteDoc)
    await drain()
    const a: ObsEvent[] = []
    const b: ObsEvent[] = []
    alice.observe(e => a.push(e))
    bob.observe(e => b.push(e))

    unwrap(aDoc.title).insert(0, "native")
    await drain()

    const replays = (events: ObsEvent[]) =>
      events.flatMap(e =>
        e.layer === "doc" && e.kind === "changeset" ? [e.replay] : [],
      )
    expect(replays(a)).toEqual([false])
    expect(replays(b)).toEqual([true])
  })

  it("covers a doc obtained only via remote auto-resolve", async () => {
    const bridge = new Bridge()
    const alice = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [TodoDoc],
    })
    // bob registers the schema but never calls get() — auto-resolve builds it.
    const bob = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [TodoDoc],
    })

    const b: ObsEvent[] = []
    bob.observe(e => b.push(e))

    const aDoc = alice.get("auto", TodoDoc)
    batch(aDoc, (d: { title: { insert: (i: number, s: string) => void } }) =>
      d.title.insert(0, "X"),
    )
    await drain()

    // bob never called get("auto"), yet doc-layer changesets arrive: an
    // auto-interpreted document is wired like one bob asked for.
    expect(
      b.some(
        e => e.layer === "doc" && e.kind === "changeset" && e.docId === "auto",
      ),
    ).toBe(true)
  })

  it("emits a structured diagnostic on schema-hash mismatch", async () => {
    const bridge = new Bridge()
    // Same docId, different schema → schema-hash mismatch on present/interest.
    const AliceDoc = json.bind(Schema.struct({ a: Schema.string() }))
    const BobDoc = json.bind(Schema.struct({ b: Schema.number() }))

    const alice = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [AliceDoc],
    })
    const bob = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [BobDoc],
    })

    const events: ObsEvent[] = []
    alice.observe(e => events.push(e))
    bob.observe(e => events.push(e))

    alice.get("clash", AliceDoc)
    bob.get("clash", BobDoc)
    await drain()

    const diag = events.find(
      e => e.layer === "diagnostic" && e.code === "schema-hash-mismatch",
    )
    // Structured + attributable — code/severity/docId/peer/local/remote,
    // not just a `layer === "diagnostic"` event. Context: jj:nztkqwpm
    expect(diag).toMatchObject({
      layer: "diagnostic",
      kind: "diagnostic",
      code: "schema-hash-mismatch",
      severity: "error",
      docId: "clash",
      peer: expect.any(String),
      local: expect.any(String),
      remote: expect.any(String),
    })
  })

  it("emits wire frames whose send-seq matches the peer's receive-seq", async () => {
    const bridge = new Bridge()
    const alice = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [TodoDoc],
    })
    const bob = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [TodoDoc],
    })

    const a: ObsEvent[] = []
    const b: ObsEvent[] = []
    alice.observe(e => a.push(e))
    bob.observe(e => b.push(e))

    const aDoc = alice.get("d", TodoDoc)
    bob.get("d", TodoDoc)
    await drain()
    batch(aDoc, (d: { title: { insert: (i: number, s: string) => void } }) =>
      d.title.insert(0, "Hi"),
    )
    await drain()

    const aSends = a.filter(e => e.layer === "wire" && e.dir === "send")
    const bRecvs = b.filter(e => e.layer === "wire" && e.dir === "receive")
    expect(aSends.length).toBeGreaterThan(0)
    expect(bRecvs.length).toBeGreaterThan(0)
    // Cross-peer correlation: a frame alice sent shares its frameSeq with the
    // frame bob received. (frameSeq is the wire-header id, NOT the envelope seq.)
    const aSendFrameSeqs = new Set(
      aSends.map(e => (e.layer === "wire" ? e.frameSeq : -1)),
    )
    const matched = bRecvs.some(
      e => e.layer === "wire" && aSendFrameSeqs.has(e.frameSeq),
    )
    expect(matched).toBe(true)
    // Frame bodies carry size + frameKind.
    expect(
      aSends.every(e => e.layer === "wire" && typeof e.size === "number"),
    ).toBe(true)
  })

  it("Loro exposes a history summary + safe valueAt time-travel; plain does not", async () => {
    const ex = createExchange({ principal: "solo", schemas: [TodoDoc] })
    const doc = ex.get("h", TodoDoc)
    batch(
      doc,
      (d: {
        title: { insert: (i: number, s: string) => void }
        items: { push: (v: unknown) => void }
      }) => {
        d.title.insert(0, "v1")
        d.items.push({ text: "a", done: false })
      },
    )
    await drain()

    const hist = ex.docHistory("h")
    expect(hist).toBeDefined()
    const s1 = defined(hist?.summary(), "the history summary")
    expect(s1.opCount).toBeGreaterThan(0)
    expect(s1.version.length).toBeGreaterThan(0)
    expect(Object.keys(s1.actors ?? {}).length).toBeGreaterThan(0)
    const pastVersion = s1.version

    // A second edit advances the doc; valueAt(pastVersion) reflects the
    // earlier state without disturbing the live doc.
    batch(doc, (d: { items: { push: (v: unknown) => void } }) =>
      d.items.push({ text: "b", done: false }),
    )
    await drain()

    const past = hist?.valueAt?.(pastVersion)
    const now = hist?.valueAt?.(ex.docHistory("h")?.summary().version ?? "")
    expect(JSON.stringify(past)).not.toEqual(JSON.stringify(now))
    // The live doc is untouched by time-travel (fork-based).
    expect((doc as { items: () => unknown[] }).items()).toHaveLength(2)

    // Yjs: summary only (no `valueAt` — needs gc:false).
    const YDoc = yjs.bind(Schema.struct({ text: Schema.text() }))
    const yd = ex.get("y", YDoc)
    batch(yd, (d: { text: { insert: (i: number, s: string) => void } }) =>
      d.text.insert(0, "hello"),
    )
    await drain()
    const yHist = ex.docHistory("y")
    expect(yHist?.summary().opCount).toBeGreaterThan(0)
    expect(yHist?.valueAt).toBeUndefined()

    // Plain (json) substrate: graceful absence.
    const JsonDoc = json.bind(Schema.struct({ a: Schema.string() }))
    ex.get("plain", JsonDoc)
    expect(ex.docHistory("plain")).toBeUndefined()
    expect(ex.docHistory("missing")).toBeUndefined()
  })

  it("a throwing sink does not break convergence", async () => {
    const bridge = new Bridge()
    const alice = createExchange({
      principal: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [TodoDoc],
    })
    const bob = createExchange({
      principal: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [TodoDoc],
    })

    alice.observe(() => {
      throw new Error("hostile sink")
    })
    bob.observe(() => {
      throw new Error("hostile sink")
    })

    const aDoc = alice.get("d", TodoDoc)
    const bDoc = bob.get("d", TodoDoc)
    await drain()
    batch(aDoc, (d: { title: { insert: (i: number, s: string) => void } }) =>
      d.title.insert(0, "Hi"),
    )
    await drain()

    expect((bDoc as { title: () => string }).title()).toBe("Hi")
  })
})
