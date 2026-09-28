// store-program — unit tests for the pure Mealy store coordination machine.
//
// Every test feeds StoreInput sequences into storeProgram.update() and
// asserts on the resulting [StoreModel, ...StoreEffect[]] tuples. No I/O,
// no mocks — pure state transitions.

import type { DocId } from "@kyneta/transport"
import { describe, expect, it } from "vitest"
import { WriterRefusedError } from "../seats.js"
import {
  allDocsSettled,
  confirmedVersion,
  type DocPhase,
  MAX_RETRY_MS,
  retryDelay,
  type StoreEffect,
  type StoreInput,
  type StoreModel,
  storeProgram,
  type Write,
} from "../store-program.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Feed a single input and return the result tuple. */
function step(
  model: StoreModel,
  msg: StoreInput,
): [StoreModel, ...StoreEffect[]] {
  return storeProgram.update(msg, model)
}

/** Feed inputs in order, returning the final model and the last effects. */
function run(
  model: StoreModel,
  ...msgs: StoreInput[]
): [StoreModel, ...StoreEffect[]] {
  let result: [StoreModel, ...StoreEffect[]] = [model]
  for (const msg of msgs) result = step(result[0], msg)
  return result
}

/** Extract the DocPhase for a given docId, asserting it exists. */
function getPhase(model: StoreModel, docId: DocId): DocPhase {
  const phase = model.docs.get(docId)
  if (!phase) throw new Error(`no phase found for ${docId}`)
  return phase
}

function persist(write: Write, docId: DocId = "doc-1"): StoreEffect {
  return { type: "persist", docId, write }
}

function persisted(version: string): StoreEffect {
  return { type: "persisted", docId: "doc-1", version }
}

function retry(afterMs: number): StoreEffect {
  return { type: "retry", docId: "doc-1", afterMs }
}

const init = storeProgram.init[0]
const hydrated = (version: string): StoreInput => ({
  type: "hydrated",
  docId: "doc-1",
  version,
})
const advanced: StoreInput = { type: "state-advanced", docId: "doc-1" }
const compact: StoreInput = { type: "compact", docId: "doc-1" }
const register: StoreInput = { type: "register", docId: "doc-1" }
const succeeded = (version: string): StoreInput => ({
  type: "write-succeeded",
  docId: "doc-1",
  version,
})
const failed = (error: unknown = new Error("io")): StoreInput => ({
  type: "write-failed",
  docId: "doc-1",
  error,
})

/**
 * `doc-1` idle at `version`: loaded, and the write loading owes has landed
 * with nothing new to store.
 */
function idleAt(version: string): StoreModel {
  return run(init, hydrated(version), succeeded(version))[0]
}

/** `doc-1` idle at `v1`, with a `since v1` write in flight. */
function writingFromV1(): StoreModel {
  return step(idleAt("v1"), advanced)[0]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("storeProgram", () => {
  it("init — model has empty docs map, no effects", () => {
    const [model, ...effects] = storeProgram.init
    expect(model.docs.size).toBe(0)
    expect(effects).toHaveLength(0)
  })

  it("hydrated — writes since the loaded version, reverting to idle there", () => {
    // The document may be ahead of what the store holds, by writes made
    // while it loaded. When it is not, the executor touches no store.
    const [model, ...effects] = step(init, hydrated("v3"))
    expect(getPhase(model, "doc-1")).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v3" },
    })
    expect(effects).toEqual([persist({ kind: "since", version: "v3" })])
  })

  it("register — writes the whole document, reverting to unwritten", () => {
    const [model, ...effects] = step(init, register)
    expect(getPhase(model, "doc-1")).toEqual({
      status: "writing",
      revertTo: { status: "unwritten" },
    })
    expect(effects).toEqual([persist({ kind: "register" })])
  })

  // -----------------------------------------------------------------------
  // Requests
  // -----------------------------------------------------------------------

  it("state-advanced while idle — writes since the confirmed version", () => {
    const [model, ...effects] = step(idleAt("v1"), advanced)
    expect(getPhase(model, "doc-1")).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v1" },
    })
    expect(effects).toEqual([persist({ kind: "since", version: "v1" })])
  })

  it("compact while idle — writes a compaction", () => {
    const [model, ...effects] = step(idleAt("v1"), compact)
    expect(getPhase(model, "doc-1")).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v1" },
    })
    expect(effects).toEqual([persist({ kind: "compact" })])
  })

  it("state-advanced and compact for an unknown doc — model unchanged", () => {
    for (const msg of [advanced, compact]) {
      const [model, ...effects] = step(init, msg)
      expect(model).toBe(init)
      expect(effects).toEqual([])
    }
  })

  it("state-advanced while writing — owes an advance, emits nothing", () => {
    const [model, ...effects] = step(writingFromV1(), advanced)
    expect(getPhase(model, "doc-1")).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v1" },
      owed: "advance",
    })
    expect(effects).toEqual([])
  })

  it("many requests during one write collapse into one owed write", () => {
    const [once] = step(writingFromV1(), advanced)
    const [many] = run(writingFromV1(), advanced, advanced, advanced)
    expect(many.docs.get("doc-1")).toEqual(once.docs.get("doc-1"))
  })

  it("compact absorbs advance, in either order", () => {
    const [a] = run(writingFromV1(), advanced, compact)
    const [b] = run(writingFromV1(), compact, advanced)
    for (const model of [a, b]) {
      const phase = getPhase(model, "doc-1")
      expect(phase.status === "writing" && phase.owed).toBe("compact")
    }
  })

  // -----------------------------------------------------------------------
  // Writes landing
  // -----------------------------------------------------------------------

  it("write-succeeded with nothing owed — idle at the written version", () => {
    const [model, ...effects] = step(writingFromV1(), succeeded("v2"))
    expect(getPhase(model, "doc-1")).toEqual({ status: "idle", version: "v2" })
    expect(effects).toEqual([persisted("v2")])
  })

  it("write-succeeded with an advance owed — the next write diffs from the version just confirmed", () => {
    // The point of the program. A write owed behind another starts from what
    // that one confirmed, not from where it started, so the two records carry
    // disjoint operations.
    const [model, ...effects] = run(writingFromV1(), advanced, succeeded("v2"))
    expect(getPhase(model, "doc-1")).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v2" },
    })
    // Confirmed first, so the executor acts on it before the next write starts.
    expect(effects).toEqual([
      persisted("v2"),
      persist({ kind: "since", version: "v2" }),
    ])
  })

  it("write-succeeded with a compact owed — compacts", () => {
    const [model, ...effects] = run(writingFromV1(), compact, succeeded("v2"))
    expect(getPhase(model, "doc-1")).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v2" },
    })
    expect(effects).toEqual([persisted("v2"), persist({ kind: "compact" })])
  })

  it("an owed write starts in the same transition — never observably settled", () => {
    // `flush()` waits for `allDocsSettled`, and transition listeners run after
    // each update. A document that settled and then started its owed write in
    // a second step would let `flush()` resolve with a write still to come.
    const [owing] = step(writingFromV1(), advanced)
    const [model] = step(owing, succeeded("v2"))
    expect(allDocsSettled(model)).toBe(false)
  })

  it("write-failed with nothing owed — falls back, reports, and asks for a retry", () => {
    const error = new Error("disk full")
    const [model, ...effects] = step(writingFromV1(), failed(error))
    expect(getPhase(model, "doc-1")).toEqual({
      status: "idle",
      version: "v1",
      failures: 1,
    })
    expect(effects).toEqual([
      { type: "store-error", docId: "doc-1", operation: "write", error },
      retry(retryDelay(1)),
    ])
  })

  it("write-failed with an advance owed — the next write diffs from the fallback, covering the failed one", () => {
    const error = new Error("disk full")
    const [model, ...effects] = run(writingFromV1(), advanced, failed(error))
    expect(getPhase(model, "doc-1")).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v1", failures: 1 },
    })
    // The owed write is the retry, so no `retry` is asked for.
    expect(effects).toEqual([
      { type: "store-error", docId: "doc-1", operation: "write", error },
      persist({ kind: "since", version: "v1" }),
    ])
  })

  it("write-failed with a compact owed — reports, then compacts", () => {
    const [, ...effects] = run(writingFromV1(), compact, failed())
    expect(effects.map(e => e.type)).toEqual(["store-error", "persist"])
    expect(effects[1]).toEqual(persist({ kind: "compact" }))
  })

  it("write-succeeded / write-failed for an unknown or settled doc — unchanged", () => {
    const idle = idleAt("v1")
    for (const model of [init, idle]) {
      for (const msg of [succeeded("v9"), failed()]) {
        const [next, ...effects] = step(model, msg)
        expect(next).toBe(model)
        expect(effects).toEqual([])
      }
    }
  })

  // -----------------------------------------------------------------------
  // The first write, and what happens when it does not land
  // -----------------------------------------------------------------------
  //
  // A document's first write has nothing behind it. Every other write can
  // fall back to the last version the store confirmed; this one cannot, and
  // the phase says so with `unwritten`.

  const registered = (): StoreModel => step(init, register)[0]
  const unwritten = (): StoreModel => step(registered(), failed())[0]

  it("register → write-failed — falls back to unwritten, reports the error", () => {
    const [model, ...effects] = step(registered(), failed())
    expect(getPhase(model, "doc-1")).toEqual({
      status: "unwritten",
      failures: 1,
    })
    expect(effects.map(e => e.type)).toEqual(["store-error", "retry"])
  })

  it("register → write-succeeded — idle at the confirmed version", () => {
    const [model, ...effects] = step(registered(), succeeded("v1"))
    expect(getPhase(model, "doc-1")).toEqual({ status: "idle", version: "v1" })
    expect(effects).toEqual([persisted("v1")])
  })

  it("unwritten → state-advanced — retries the whole document", () => {
    // A delta needs a confirmed base and there is none, so an advance on an
    // unwritten document is a whole write. This is how a failed first write
    // recovers, whether the advance comes from the retry timer or from the
    // next mutation.
    const [model, ...effects] = step(unwritten(), advanced)
    expect(getPhase(model, "doc-1")).toEqual({
      status: "writing",
      revertTo: { status: "unwritten", failures: 1 },
    })
    expect(effects).toEqual([persist({ kind: "register" })])

    const [recovered] = step(model, succeeded("v2"))
    expect(getPhase(recovered, "doc-1")).toEqual({
      status: "idle",
      version: "v2",
    })
  })

  it("unwritten → compact — compacts", () => {
    const [, ...effects] = step(unwritten(), compact)
    expect(effects).toEqual([persist({ kind: "compact" })])
  })

  it("an advance owed behind a failed first write — retries the whole document", () => {
    const [, ...effects] = run(registered(), advanced, failed())
    expect(effects.map(e => e.type)).toEqual(["store-error", "persist"])
    expect(effects[1]).toEqual(persist({ kind: "register" }))
  })

  it("an advance owed behind a successful first write — diffs from it", () => {
    const [, ...effects] = run(registered(), advanced, succeeded("v1"))
    expect(effects).toEqual([
      persisted("v1"),
      persist({ kind: "since", version: "v1" }),
    ])
  })

  // -----------------------------------------------------------------------
  // Confirmation and retry
  // -----------------------------------------------------------------------

  it("a write that found nothing new is still reported persisted", () => {
    // The executor reports success at the confirmed version without touching
    // a store. The confirmation is what opens the gate, so it must not
    // depend on there having been something to write.
    const [, ...effects] = run(init, hydrated("v1"), succeeded("v1"))
    expect(effects).toEqual([persisted("v1")])
  })

  it("each failure in a row doubles the retry delay", () => {
    let model = writingFromV1()
    const delays: number[] = []
    for (let i = 0; i < 4; i++) {
      const [next, ...effects] = step(model, failed())
      for (const effect of effects) {
        if (effect.type === "retry") delays.push(effect.afterMs)
      }
      // The retry timer's `state-advanced` starts the next attempt.
      model = step(next, advanced)[0]
    }
    expect(delays).toEqual([250, 500, 1000, 2000])
  })

  it("a success clears the failure count", () => {
    const [failing] = run(writingFromV1(), failed(), advanced, failed())
    expect(getPhase(failing, "doc-1")).toMatchObject({ failures: 2 })

    const [recovered] = run(failing, advanced, succeeded("v2"))
    expect(getPhase(recovered, "doc-1")).toEqual({
      status: "idle",
      version: "v2",
    })

    // The next failure starts the backoff over.
    const [, ...effects] = run(recovered, advanced, failed())
    expect(effects).toContainEqual(retry(250))
  })

  it("a document waiting to retry is settled", () => {
    // `flush()` and `shutdown()` wait for `allDocsSettled`; they must not wait
    // on a store that keeps failing.
    const [model] = step(writingFromV1(), failed())
    expect(allDocsSettled(model)).toBe(true)
  })

  it("retryDelay doubles from 250 ms and stops at MAX_RETRY_MS", () => {
    expect([1, 2, 3, 4].map(retryDelay)).toEqual([250, 500, 1000, 2000])
    expect(retryDelay(8)).toBe(MAX_RETRY_MS)
    expect(retryDelay(50)).toBe(MAX_RETRY_MS)
  })

  it("confirmedVersion — what the store holds, including during a write", () => {
    expect(confirmedVersion({ status: "unwritten" })).toBeUndefined()
    expect(confirmedVersion({ status: "idle", version: "v1" })).toBe("v1")
    expect(getPhase(writingFromV1(), "doc-1").status).toBe("writing")
    expect(confirmedVersion(getPhase(writingFromV1(), "doc-1"))).toBe("v1")
    expect(
      confirmedVersion(getPhase(step(init, register)[0], "doc-1")),
    ).toBeUndefined()
  })

  // -----------------------------------------------------------------------
  // destroy, allDocsSettled, immutability
  // -----------------------------------------------------------------------

  it("destroy — removes the doc and deletes, idle or writing", () => {
    for (const model of [idleAt("v1"), writingFromV1()]) {
      const [next, ...effects] = step(model, {
        type: "destroy",
        docId: "doc-1",
      })
      expect(next.docs.has("doc-1")).toBe(false)
      expect(effects).toEqual([{ type: "persist-delete", docId: "doc-1" }])
    }
  })

  it("allDocsSettled — true unless some doc is writing", () => {
    expect(allDocsSettled(init)).toBe(true)
    expect(allDocsSettled(idleAt("v1"))).toBe(true)
    expect(allDocsSettled(unwritten())).toBe(true)
    expect(allDocsSettled(registered())).toBe(false)
    expect(allDocsSettled(writingFromV1())).toBe(false)
  })

  it("model immutability — the input model is not mutated", () => {
    const before = writingFromV1()
    const snapshot = new Map(before.docs)
    run(before, advanced, compact, succeeded("v2"), failed(), advanced)
    expect(before.docs).toEqual(snapshot)
  })

  // -----------------------------------------------------------------------
  // The invariant, under arbitrary interleavings
  // -----------------------------------------------------------------------

  it("every landed write starts exactly where the store's confirmed state ends", () => {
    // A document whose version is an integer, and a store that appends
    // `[from, to)` ranges. Mutations, landings and failures interleave in a
    // seeded random order. Every write that lands must start exactly at the
    // last confirmed version — no overlap, no gap — and once everything has
    // drained the store must hold every mutation.
    let seed = 0x2545f491
    const random = (): number => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) / 2 ** 32
    }

    for (let trial = 0; trial < 200; trial++) {
      let model = idleAt("0")
      let current = 0
      let confirmed = 0
      let inFlight: { from: number; to: number } | null = null

      const apply = (msg: StoreInput): void => {
        const [next, ...effects] = step(model, msg)
        model = next
        for (const effect of effects) {
          if (effect.type !== "persist") continue
          if (effect.write.kind !== "since") {
            throw new Error(`unexpected ${effect.write.kind} write`)
          }
          inFlight = { from: Number(effect.write.version), to: current }
        }
      }

      for (let i = 0; i < 60; i++) {
        const r = random()
        if (r < 0.5) {
          current++
          apply(advanced)
        } else if (inFlight !== null) {
          const write: { from: number; to: number } = inFlight
          inFlight = null
          if (r < 0.85) {
            expect(write.from).toBe(confirmed)
            confirmed = write.to
            apply(succeeded(String(write.to)))
          } else {
            apply(failed())
          }
        }
      }

      // Drain: land everything still in flight or owed.
      while (inFlight !== null) {
        const write: { from: number; to: number } = inFlight
        inFlight = null
        expect(write.from).toBe(confirmed)
        confirmed = write.to
        apply(succeeded(String(write.to)))
      }
      // A failure with nothing owed asks for a retry, which the executor
      // dispatches as a `state-advanced`.
      if (confirmed !== current) {
        apply(advanced)
        const write = inFlight as { from: number; to: number } | null
        if (write === null) throw new Error("expected a write")
        expect(write.from).toBe(confirmed)
        confirmed = write.to
        apply(succeeded(String(write.to)))
      }

      expect(confirmed).toBe(current)
      expect(allDocsSettled(model)).toBe(true)
    }
  })
})

describe("storeProgram — a lost seat", () => {
  const lost = new Error("seat lost")
  const seatLost: StoreInput = {
    type: "seat-lost",
    docId: "doc-1",
    error: lost,
  }

  it("is reported once, and makes every document settled", () => {
    // doc-1 has a write in flight and another owed; doc-2 is loading.
    const writing = run(writingFromV1(), advanced, {
      type: "register",
      docId: "doc-2",
    })[0]
    expect(allDocsSettled(writing)).toBe(false)

    const [model, ...effects] = step(writing, seatLost)
    expect(model.seatLost).toBe(lost)
    expect(allDocsSettled(model)).toBe(true)
    expect(effects).toEqual([
      { type: "seat-lost" },
      { type: "store-error", docId: "doc-1", operation: "write", error: lost },
    ])
  })

  it("is terminal: every later input emits nothing", () => {
    const [model] = step(writingFromV1(), seatLost)
    const later: StoreInput[] = [
      succeeded("v2"),
      failed(),
      advanced,
      compact,
      register,
      hydrated("v1"),
      { type: "destroy", docId: "doc-1" },
      { type: "seat-lost", docId: "doc-2", error: new Error("again") },
    ]
    for (const msg of later) {
      const [next, ...effects] = step(model, msg)
      expect(next).toBe(model)
      expect(effects).toEqual([])
    }
  })
})

describe("storeProgram — a refused writer", () => {
  const refused = new WriterRefusedError("doc-1", "other-seat")
  const writerRefused: StoreInput = {
    type: "writer-refused",
    docId: "doc-1",
    error: refused,
  }

  it("stops tracking the document, owed write included, and asks for a rebuild", () => {
    // A write in flight with another owed behind it.
    const writing = step(writingFromV1(), advanced)[0]
    const [model, ...effects] = step(writing, writerRefused)
    expect(model.docs.has("doc-1")).toBe(false)
    expect(allDocsSettled(model)).toBe(true)
    expect(effects).toEqual([
      { type: "rebuild", docId: "doc-1", error: refused },
      {
        type: "store-error",
        docId: "doc-1",
        operation: "write",
        error: refused,
      },
    ])
  })

  it("ignores what the refused write's siblings report, until the rebuild hands it back", () => {
    const [model] = step(writingFromV1(), writerRefused)
    for (const msg of [succeeded("v2"), failed(), advanced, compact]) {
      const [next, ...effects] = step(model, msg)
      expect(next).toBe(model)
      expect(effects).toEqual([])
    }
    const [tracked, ...effects] = step(model, hydrated("v3"))
    expect(getPhase(tracked, "doc-1")).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v3" },
    })
    expect(effects).toEqual([persist({ kind: "since", version: "v3" })])
  })

  it("does nothing once the seat is lost", () => {
    const [lost] = step(writingFromV1(), {
      type: "seat-lost",
      docId: "doc-1",
      error: new Error("lost"),
    })
    const [next, ...effects] = step(lost, writerRefused)
    expect(next).toBe(lost)
    expect(effects).toEqual([])
  })
})
