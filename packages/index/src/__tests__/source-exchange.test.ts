// source-exchange — `Source.fromExchange` against a real `Exchange`.
//
// The companion to `source-of.test.ts`, and the split is deliberate. That file
// drives a hand-built mock, which is the right instrument for the adapter's own
// ℤ-set algebra — delta shape, key mapping, entity extraction — because a mock
// makes those deterministic. But a mock cannot notice the contract it stands in
// for changing underneath it: it agrees with its own semantics forever.
//
// This file covers the other half — what an `Exchange` actually does across a
// document's lifecycle. Put a new test here if it is about the exchange
// contract, and there if it is about the algebra.
//
// Several assertions below fold the emitted deltas rather than reading
// `snapshot()`. That is not stylistic. `snapshot()` is backed by a `Map`, so it
// dedupes silently and will report the right answer while the emitted stream —
// which is what every downstream consumer integrates — reports the wrong one.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { Exchange } from "@kyneta/exchange"
import {
  Defer,
  json,
  plainReplicaFactory,
  Schema,
  SYNC_AUTHORITATIVE,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import type { Source } from "../source.js"
import { Source as SourceNS } from "../source.js"

const noteSchema = Schema.struct({ title: Schema.string() })
const NoteDoc = json.bind(noteSchema)

/**
 * Let bridged messages settle.
 *
 * Microtasks only, rather than a timer: this package compiles against
 * `lib: ["ESNext"]` with no host globals, so `setTimeout` is not in scope here
 * the way it is in `@kyneta/exchange`'s own tests. The bridge transport
 * delivers on the microtask queue, so this is sufficient — a generous round
 * count rather than a delay.
 */
async function drain(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/**
 * Accumulate every emitted delta into a weight map.
 *
 * The instrument for anything asking "what did downstream see?", as opposed to
 * "what does the source hold?". A key the source emitted twice integrates to 2
 * here while `snapshot()` still says one entry.
 */
function foldDeltas(source: Source<unknown>): Map<string, number> {
  const weights = new Map<string, number>()
  source.subscribe(event => {
    for (const [key, weight] of event.delta) {
      weights.set(key, (weights.get(key) ?? 0) + weight)
    }
  })
  return weights
}

/** Every document's phase, for asserting that indexing did not move any. */
function tiers(exchange: Exchange): Map<string, string> {
  const out = new Map<string, string>()
  for (const [docId, info] of exchange.documents()) out.set(docId, info.mode)
  return out
}

describe("replicate documents", () => {
  it("does not throw when registered after the source attached", () => {
    // Order matters, and this is the order that used to break. Registering
    // before the source attaches is harmless — the scan filtered on mode, so
    // it skipped the document. The crash needed the registration to arrive as
    // a `doc-created` event, because the subscriber applied no filter at all
    // and called `exchange.get()`, which refuses a replicate document.
    //
    // The throw then escaped into a changefeed dispatch, so it did not merely
    // skip one document — it aborted the dispatch feeding everything
    // downstream of the source.
    const exchange = new Exchange({ id: "relay" })
    const [source] = SourceNS.fromExchange(exchange, NoteDoc)

    expect(() => {
      exchange.replicate(
        "relayed",
        plainReplicaFactory,
        SYNC_AUTHORITATIVE,
        NoteDoc.schemaHash,
      )
    }).not.toThrow()

    expect(source.snapshot().size).toBe(0)
    expect(exchange.documents().get("relayed")?.mode).toBe("replicate")
  })

  it("does not index one that existed before the source attached", () => {
    const exchange = new Exchange({ id: "relay" })
    exchange.replicate(
      "relayed",
      plainReplicaFactory,
      SYNC_AUTHORITATIVE,
      NoteDoc.schemaHash,
    )

    const [source] = SourceNS.fromExchange(exchange, NoteDoc)

    expect(source.snapshot().size).toBe(0)
  })

  it("conserves tier across a full mixed sequence", () => {
    // The law, as one assertion rather than a list of cases: indexing may
    // change a document's readability, never its tier. Written as a
    // conservation check so that a phase added later, or a `get()` that learns
    // to upgrade a replicate document, is covered without editing this test.
    const exchange = new Exchange({ id: "relay" })
    exchange.replicate(
      "before-attach",
      plainReplicaFactory,
      SYNC_AUTHORITATIVE,
      NoteDoc.schemaHash,
    )
    exchange.get("local", NoteDoc)

    const before = tiers(exchange)

    const [, handle] = SourceNS.fromExchange(exchange, NoteDoc)
    exchange.replicate(
      "after-attach",
      plainReplicaFactory,
      SYNC_AUTHORITATIVE,
      NoteDoc.schemaHash,
    )
    handle.createDoc("made")
    exchange.suspend("local")
    exchange.resume("local")
    handle.delete("made")

    // Nothing that was replicate has become anything else. Asserted over the
    // whole map rather than per-docId so that a phase added later is covered
    // without editing this test.
    const after = tiers(exchange)
    for (const [docId, mode] of before) {
      if (mode === "replicate") expect(after.get(docId)).toBe("replicate")
    }
    expect(after.get("after-attach")).toBe("replicate")
  })
})

describe("the handle emits once per change", () => {
  it("createDoc emits a single +1, and delete returns it to zero", () => {
    const exchange = new Exchange({ id: "peer" })
    const [source, handle] = SourceNS.fromExchange(exchange, NoteDoc)
    const weights = foldDeltas(source)

    handle.createDoc("note-1")
    // The regression this guards integrates to 2. `doc-created` fires
    // synchronously inside `exchange.get()`, so a `createDoc` keeping its own
    // bookkeeping adds and emits after the subscriber already has.
    expect(weights.get("note-1")).toBe(1)

    handle.delete("note-1")
    // And its consequence: one `-1` against a weight of 2 leaves a phantom
    // entry in every derived view. Note that `snapshot()` is correct in both
    // worlds — only the fold can tell them apart, which is why membership
    // tests here assert on deltas.
    expect(weights.get("note-1")).toBe(0)
    expect(source.snapshot().size).toBe(0)
  })
})

describe("suspension is not a membership condition", () => {
  it("indexes a document that was already suspended when the source attached", () => {
    // The scan path, and the one that used to get this wrong: it tested
    // `info.suspended` and skipped. Suspension is sync-graph state — the
    // document is still interpreted, still present, still holds a live
    // readable ref — so it is still a member.
    const exchange = new Exchange({ id: "peer" })
    exchange.get("note-1", NoteDoc)
    exchange.suspend("note-1")

    const [source] = SourceNS.fromExchange(exchange, NoteDoc)

    expect(source.snapshot().has("note-1")).toBe(true)
  })

  it("suspend and resume leave the document indexed and emit nothing", () => {
    const exchange = new Exchange({ id: "peer" })
    const [source] = SourceNS.fromExchange(exchange, NoteDoc)
    exchange.get("note-1", NoteDoc)

    const emitted: unknown[] = []
    source.subscribe(event => emitted.push([...event.delta]))

    exchange.suspend("note-1")
    expect(source.snapshot().has("note-1")).toBe(true)

    exchange.resume("note-1")
    expect(source.snapshot().has("note-1")).toBe(true)

    // A -1/+1 pair here would reach downstream `Collection` subscribers as
    // removed + added for a document whose contents never changed — churn in
    // the UI because the network went quiet.
    expect(emitted).toEqual([])
  })
})

describe("deferred documents", () => {
  // Two cases that read alike and test different mechanisms. Keep them apart:
  // the first exercises `registerSchema`'s deferred sweep, which runs when the
  // source attaches; the second exercises `doc-promoted` reaching `reconcile`,
  // which is the transition the old subscriber ignored entirely.
  //
  // Both need two peers, because a document is only deferred when someone else
  // announces one this peer cannot read.
  const twoPeers = (): { alice: Exchange; bob: Exchange } => {
    const bridge = new Bridge()
    return {
      alice: new Exchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      }),
      bob: new Exchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
        resolve: () => Defer(),
      }),
    }
  }

  it("promotes and indexes one that was already deferred when the source attached", async () => {
    const { alice, bob } = twoPeers()
    alice.get("shared", NoteDoc)
    await drain()
    expect(bob.documents().get("shared")?.mode).toBe("deferred")

    const [source] = SourceNS.fromExchange(bob, NoteDoc)
    await drain()

    // Promotion here is the feature, not a leak: attaching a source declares
    // that this peer can now read this schema, and a deferred document is
    // precisely one it previously could not.
    expect(bob.documents().get("shared")?.mode).toBe("interpret")
    expect(source.snapshot().has("shared")).toBe(true)
  })

  it("indexes one announced after the source attached", async () => {
    const { alice, bob } = twoPeers()
    const [source] = SourceNS.fromExchange(bob, NoteDoc)
    await drain()

    // Announced after Bob's source is live, so Bob learns of it through the
    // changefeed rather than through the attach sweep.
    //
    // Measured: this document is never deferred. Attaching the source
    // registered its schema, so Bob can read the announcement on arrival and
    // it lands in `interpret` directly — the event is `doc-created`, not
    // `doc-promoted`, even though Bob is configured to `Defer()`. Which means
    // a deferred document only exists here in the window *before* a source for
    // its schema attaches, and that window is what the test above covers.
    alice.get("later", NoteDoc)
    await drain()

    expect(bob.documents().get("later")?.mode).toBe("interpret")
    expect(source.snapshot().has("later")).toBe(true)
  })
})

describe("every path agrees", () => {
  it("a fresh source matches a long-lived one, in contents and in deltas", () => {
    const exchange = new Exchange({ id: "peer" })
    exchange.replicate(
      "relayed",
      plainReplicaFactory,
      SYNC_AUTHORITATIVE,
      NoteDoc.schemaHash,
    )

    const [longLived, handle] = SourceNS.fromExchange(exchange, NoteDoc)
    const weights = foldDeltas(longLived)

    exchange.get("a", NoteDoc)
    handle.createDoc("b")
    exchange.suspend("a")
    exchange.resume("a")
    exchange.get("c", NoteDoc)
    handle.delete("b")
    exchange.destroy("c")

    const [fresh] = SourceNS.fromExchange(exchange, NoteDoc)

    // Contents agree: the subscription ends up where a fresh scan starts.
    expect([...longLived.snapshot().keys()].sort()).toEqual(
      [...fresh.snapshot().keys()].sort(),
    )

    // Deltas agree with contents. This is the half a `snapshot()`-only
    // assertion cannot see, and the half a double-emit breaks.
    const positive = [...weights.entries()]
      .filter(([, weight]) => weight > 0)
      .map(([key]) => key)
      .sort()
    expect(positive).toEqual([...longLived.snapshot().keys()].sort())
    for (const weight of weights.values()) {
      expect(weight === 0 || weight === 1).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

describe("Source.of infers its document and item types", () => {
  it("types the accessor's document and the key function's item", () => {
    // A type-level regression test: nothing here asserts at runtime beyond the
    // source existing. Its purpose is that `doc.tasks` and `item.id()` only
    // compile if both callbacks are typed.
    //
    // The shape being guarded against is a type parameter that appears ONLY in
    // a callback parameter position. TypeScript has nothing to infer such a
    // parameter from, so it silently resolves to its constraint and every
    // caller receives `unknown` — with no error anywhere in this package. The
    // damage lands entirely on consumers, which is why the guard lives here.
    const ProjectDoc = json.bind(
      Schema.struct({
        tasks: Schema.list(
          Schema.struct({ id: Schema.string(), ownerId: Schema.string() }),
        ),
      }),
    )
    const exchange = new Exchange({ id: "typing" })

    const source = SourceNS.of(
      exchange,
      ProjectDoc,
      doc => doc.tasks,
      item => item.id(),
    )

    expect(typeof source.subscribe).toBe("function")
    return exchange.shutdown()
  })
})
