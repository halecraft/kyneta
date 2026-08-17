// store-program — unit tests for the pure Mealy store coordination machine.
//
// Every test feeds StoreInput sequences into storeProgram.update() and
// asserts on the resulting [StoreModel, ...StoreEffect[]] tuples. No I/O,
// no mocks — pure state transitions.

import type { SubstratePayload } from "@kyneta/schema"
import type { DocId } from "@kyneta/transport"
import { describe, expect, it } from "vitest"
import type { StoreMeta } from "../store.js"
import {
  allDocsIdle,
  type DocPhase,
  type StoreEffect,
  type StoreInput,
  type StoreModel,
  storeProgram,
} from "../store-program.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const plainMeta: StoreMeta = {
  replicaType: ["plain", 1, 0] as const,
  syncMode: {
    writerModel: "serialized" as const,
    delivery: "delta-capable" as const,
    durability: "persistent" as const,
  },
  schemaHash: "test-hash",
}

function fakePayload(label: string): SubstratePayload {
  return { kind: "entirety" as const, encoding: "json" as const, data: label }
}

function fakeDelta(label: string): SubstratePayload {
  return { kind: "since" as const, encoding: "json" as const, data: label }
}

/** Feed a single input and return the result tuple. */
function step(
  model: StoreModel,
  msg: StoreInput,
): [StoreModel, ...StoreEffect[]] {
  return storeProgram.update(msg, model)
}

/** Extract the DocPhase for a given docId, asserting it exists. */
function getPhase(model: StoreModel, docId: DocId): DocPhase {
  const phase = model.docs.get(docId)
  if (!phase) throw new Error(`no phase found for ${docId}`)
  return phase
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("storeProgram", () => {
  // -----------------------------------------------------------------------
  // 1. init
  // -----------------------------------------------------------------------
  it("init — model has empty docs map, no effects", () => {
    const [model, ...effects] = storeProgram.init
    expect(model.docs.size).toBe(0)
    expect(effects).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // 2. register
  // -----------------------------------------------------------------------
  it("register — emits persist-append with meta + entry, doc transitions to writing", () => {
    const [initModel] = storeProgram.init
    const [model, ...effects] = step(initModel, {
      type: "register",
      docId: "doc-1",
      meta: plainMeta,
      entirety: fakePayload("initial-state"),
      version: "v1",
    })

    const phase = getPhase(model, "doc-1")
    expect(phase).toEqual({
      status: "writing",
      revertTo: { status: "unwritten" },
      pendingVersion: "v1",
    })

    expect(effects).toHaveLength(1)
    const fx = effects[0]
    if (!fx) throw new Error("expected effect")
    expect(fx.type).toBe("persist-append")
    expect(fx.docId).toBe("doc-1")

    const records = (fx as Extract<StoreEffect, { type: "persist-append" }>)
      .records
    expect(records).toHaveLength(2)
    expect(records[0]).toEqual({ kind: "meta", meta: plainMeta })
    expect(records[1]).toEqual({
      kind: "entry",
      payload: fakePayload("initial-state"),
      version: "v1",
    })
  })

  // -----------------------------------------------------------------------
  // 3. hydrated
  // -----------------------------------------------------------------------
  it("hydrated — doc transitions to idle, no effects", () => {
    const [initModel] = storeProgram.init
    const [model, ...effects] = step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v3",
    })

    const phase = getPhase(model, "doc-1")
    expect(phase).toEqual({ status: "idle", version: "v3" })
    expect(effects).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // 4. state-advanced while idle
  // -----------------------------------------------------------------------
  it("state-advanced while idle — emits persist-append with entry, transitions to writing", () => {
    const [initModel] = storeProgram.init
    // Set up an idle doc
    const [idleModel] = step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v1",
    })

    const [model, ...effects] = step(idleModel, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("delta-1"),
      newVersion: "v2",
    })

    const phase = getPhase(model, "doc-1")
    expect(phase).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v1" },
      pendingVersion: "v2",
    })

    expect(effects).toHaveLength(1)
    const fx = effects[0]
    if (!fx) throw new Error("expected effect")
    expect(fx.type).toBe("persist-append")
    expect(fx.docId).toBe("doc-1")

    const records = (fx as Extract<StoreEffect, { type: "persist-append" }>)
      .records
    expect(records).toEqual([
      { kind: "entry", payload: fakeDelta("delta-1"), version: "v2" },
    ])
  })

  // -----------------------------------------------------------------------
  // 5. state-advanced while writing
  // -----------------------------------------------------------------------
  it("state-advanced while writing — queues, no effects, pendingVersion updated", () => {
    const [initModel] = storeProgram.init
    const [idleModel] = step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v1",
    })
    // Transition to writing
    const [writingModel] = step(idleModel, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("delta-1"),
      newVersion: "v2",
    })

    // Now another state-advanced arrives while writing
    const [model, ...effects] = step(writingModel, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("delta-2"),
      newVersion: "v3",
    })

    const phase = getPhase(model, "doc-1")
    expect(phase.status).toBe("writing")
    expect(phase).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v1" },
      pendingVersion: "v2",
      queued: [
        {
          type: "state-advanced",
          delta: fakeDelta("delta-2"),
          newVersion: "v3",
        },
      ],
    })
    expect(effects).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // 6. write-succeeded
  // -----------------------------------------------------------------------
  it("write-succeeded — version advances to pendingVersion, transitions to idle", () => {
    const [initModel] = storeProgram.init
    const [idleModel] = step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v1",
    })
    const [writingModel] = step(idleModel, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("delta-1"),
      newVersion: "v2",
    })

    const [model, ...effects] = step(writingModel, {
      type: "write-succeeded",
      docId: "doc-1",
      version: "v2",
    })

    const phase = getPhase(model, "doc-1")
    expect(phase).toEqual({ status: "idle", version: "v2" })
    expect(effects).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // 7. write-succeeded with queued state-advanced
  // -----------------------------------------------------------------------
  it("write-succeeded with queued state-advanced — processes queued, emits persist-append", () => {
    const [initModel] = storeProgram.init
    const [idleModel] = step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v1",
    })
    const [writingModel] = step(idleModel, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("delta-1"),
      newVersion: "v2",
    })
    // Queue a second state-advanced
    const [queuedModel] = step(writingModel, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("delta-2"),
      newVersion: "v3",
    })

    const [model, ...effects] = step(queuedModel, {
      type: "write-succeeded",
      docId: "doc-1",
      version: "v2",
    })

    // Should now be writing again with the queued input
    const phase = getPhase(model, "doc-1")
    expect(phase).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v2" }, // advanced to pendingVersion from previous write
      pendingVersion: "v3",
    })

    expect(effects).toHaveLength(1)
    const fx = effects[0]
    if (!fx) throw new Error("expected effect")
    expect(fx.type).toBe("persist-append")
    expect(fx.docId).toBe("doc-1")
    expect(
      (fx as Extract<StoreEffect, { type: "persist-append" }>).records,
    ).toEqual([{ kind: "entry", payload: fakeDelta("delta-2"), version: "v3" }])
  })

  // -----------------------------------------------------------------------
  // 8. write-succeeded with queued compact
  // -----------------------------------------------------------------------
  it("write-succeeded with queued compact — processes queued, emits persist-replace", () => {
    const [initModel] = storeProgram.init
    const [idleModel] = step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v1",
    })
    const [writingModel] = step(idleModel, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("delta-1"),
      newVersion: "v2",
    })
    // Queue a compact while writing
    const [queuedModel] = step(writingModel, {
      type: "compact",
      docId: "doc-1",
      meta: plainMeta,
      entirety: fakePayload("compacted-state"),
      newVersion: "v3",
    })

    const [model, ...effects] = step(queuedModel, {
      type: "write-succeeded",
      docId: "doc-1",
      version: "v2",
    })

    const phase = getPhase(model, "doc-1")
    expect(phase).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v2" },
      pendingVersion: "v3",
    })

    expect(effects).toHaveLength(1)
    const fx = effects[0]
    if (!fx) throw new Error("expected effect")
    expect(fx.type).toBe("persist-replace")
    expect(fx.docId).toBe("doc-1")
    expect(
      (fx as Extract<StoreEffect, { type: "persist-replace" }>).records,
    ).toEqual([
      { kind: "meta", meta: plainMeta },
      {
        kind: "entry",
        payload: fakePayload("compacted-state"),
        version: "v3",
      },
    ])
  })

  // -----------------------------------------------------------------------
  // 9. write-failed
  // -----------------------------------------------------------------------
  it("write-failed — version does NOT advance (self-healing), emits store-error, transitions to idle", () => {
    const [initModel] = storeProgram.init
    const [idleModel] = step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v1",
    })
    const [writingModel] = step(idleModel, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("delta-1"),
      newVersion: "v2",
    })

    const testError = new Error("disk full")
    const [model, ...effects] = step(writingModel, {
      type: "write-failed",
      docId: "doc-1",
      error: testError,
    })

    // Version does NOT advance — stays at v1
    const phase = getPhase(model, "doc-1")
    expect(phase).toEqual({ status: "idle", version: "v1" })

    expect(effects).toHaveLength(1)
    const fx = effects[0]
    if (!fx) throw new Error("expected effect")
    expect(fx.type).toBe("store-error")
    expect(fx.docId).toBe("doc-1")
    expect(
      (fx as Extract<StoreEffect, { type: "store-error" }>).operation,
    ).toBe("write")
    expect((fx as Extract<StoreEffect, { type: "store-error" }>).error).toBe(
      testError,
    )
  })

  // -----------------------------------------------------------------------
  // 10. write-failed with queued input
  // -----------------------------------------------------------------------
  it("write-failed with queued input — processes queued at old version", () => {
    const [initModel] = storeProgram.init
    const [idleModel] = step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v1",
    })
    const [writingModel] = step(idleModel, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("delta-1"),
      newVersion: "v2",
    })
    // Queue another state-advanced
    const [queuedModel] = step(writingModel, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("delta-2"),
      newVersion: "v3",
    })

    const testError = new Error("transient failure")
    const [model, ...effects] = step(queuedModel, {
      type: "write-failed",
      docId: "doc-1",
      error: testError,
    })

    // Queued input processed at old version (v1, not v2)
    const phase = getPhase(model, "doc-1")
    expect(phase.status).toBe("writing")
    expect(phase).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v1" }, // old version — write-failed does NOT advance
      pendingVersion: "v3",
    })

    // First effect is the store-error, second is the queued persist-append
    expect(effects).toHaveLength(2)
    expect(effects[0]?.type).toBe("store-error")
    expect(effects[1]?.type).toBe("persist-append")
    expect(effects[1]?.docId).toBe("doc-1")
    expect(
      (effects[1] as Extract<StoreEffect, { type: "persist-append" }>).records,
    ).toEqual([{ kind: "entry", payload: fakeDelta("delta-2"), version: "v3" }])
  })

  // -----------------------------------------------------------------------
  // 11. compact while idle
  // -----------------------------------------------------------------------
  it("compact while idle — emits persist-replace, transitions to writing", () => {
    const [initModel] = storeProgram.init
    const [idleModel] = step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v5",
    })

    const [model, ...effects] = step(idleModel, {
      type: "compact",
      docId: "doc-1",
      meta: plainMeta,
      entirety: fakePayload("compacted"),
      newVersion: "v6",
    })

    const phase = getPhase(model, "doc-1")
    expect(phase).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v5" },
      pendingVersion: "v6",
    })

    expect(effects).toHaveLength(1)
    const fx = effects[0]
    if (!fx) throw new Error("expected effect")
    expect(fx.type).toBe("persist-replace")
    expect(fx.docId).toBe("doc-1")
    expect(
      (fx as Extract<StoreEffect, { type: "persist-replace" }>).records,
    ).toEqual([
      { kind: "meta", meta: plainMeta },
      { kind: "entry", payload: fakePayload("compacted"), version: "v6" },
    ])
  })

  // -----------------------------------------------------------------------
  // 12. compact while writing
  // -----------------------------------------------------------------------
  it("compact while writing — queues, no effects", () => {
    const [initModel] = storeProgram.init
    const [idleModel] = step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v1",
    })
    const [writingModel] = step(idleModel, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("delta-1"),
      newVersion: "v2",
    })

    const [model, ...effects] = step(writingModel, {
      type: "compact",
      docId: "doc-1",
      meta: plainMeta,
      entirety: fakePayload("compacted"),
      newVersion: "v3",
    })

    const phase = getPhase(model, "doc-1")
    expect(phase).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v1" },
      pendingVersion: "v2",
      queued: [
        {
          type: "compact",
          meta: plainMeta,
          entirety: fakePayload("compacted"),
          newVersion: "v3",
        },
      ],
    })
    expect(effects).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // 13. destroy
  // -----------------------------------------------------------------------
  it("destroy — removes doc from model, emits persist-delete", () => {
    const [initModel] = storeProgram.init
    const [idleModel] = step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v1",
    })

    const [model, ...effects] = step(idleModel, {
      type: "destroy",
      docId: "doc-1",
    })

    expect(model.docs.has("doc-1")).toBe(false)
    expect(model.docs.size).toBe(0)

    expect(effects).toHaveLength(1)
    expect(effects[0]).toEqual({ type: "persist-delete", docId: "doc-1" })
  })

  // -----------------------------------------------------------------------
  // 14. destroy while writing
  // -----------------------------------------------------------------------
  it("destroy while writing — removes doc, emits persist-delete", () => {
    const [initModel] = storeProgram.init
    const [idleModel] = step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v1",
    })
    const [writingModel] = step(idleModel, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("delta-1"),
      newVersion: "v2",
    })

    const [model, ...effects] = step(writingModel, {
      type: "destroy",
      docId: "doc-1",
    })

    expect(model.docs.has("doc-1")).toBe(false)
    expect(effects).toHaveLength(1)
    expect(effects[0]).toEqual({ type: "persist-delete", docId: "doc-1" })
  })

  // -----------------------------------------------------------------------
  // 15. allDocsIdle
  // -----------------------------------------------------------------------
  describe("allDocsIdle", () => {
    it("true when docs map is empty", () => {
      const [initModel] = storeProgram.init
      expect(allDocsIdle(initModel)).toBe(true)
    })

    it("true when all docs are idle", () => {
      const [initModel] = storeProgram.init
      const [m1] = step(initModel, {
        type: "hydrated",
        docId: "doc-1",
        version: "v1",
      })
      const [m2] = step(m1, {
        type: "hydrated",
        docId: "doc-2",
        version: "v2",
      })

      expect(allDocsIdle(m2)).toBe(true)
    })

    it("false when any doc is writing", () => {
      const [initModel] = storeProgram.init
      const [m1] = step(initModel, {
        type: "hydrated",
        docId: "doc-1",
        version: "v1",
      })
      const [m2] = step(m1, {
        type: "hydrated",
        docId: "doc-2",
        version: "v2",
      })
      // Transition doc-1 to writing
      const [m3] = step(m2, {
        type: "state-advanced",
        docId: "doc-1",
        delta: fakeDelta("delta"),
        newVersion: "v3",
      })

      expect(allDocsIdle(m3)).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // 16. unknown doc for write-succeeded
  // -----------------------------------------------------------------------
  it("write-succeeded for unknown doc — returns model unchanged", () => {
    const [initModel] = storeProgram.init
    const [model, ...effects] = step(initModel, {
      type: "write-succeeded",
      docId: "nonexistent",
      version: "v1",
    })

    expect(model).toBe(initModel)
    expect(effects).toHaveLength(0)
  })

  it("write-succeeded for idle doc — returns model unchanged", () => {
    const [initModel] = storeProgram.init
    const [idleModel] = step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v1",
    })

    const [model, ...effects] = step(idleModel, {
      type: "write-succeeded",
      docId: "doc-1",
      version: "v1",
    })

    expect(model).toBe(idleModel)
    expect(effects).toHaveLength(0)
  })

  // -----------------------------------------------------------------------
  // Additional edge cases
  // -----------------------------------------------------------------------

  it("write-failed for unknown doc — returns model unchanged", () => {
    const [initModel] = storeProgram.init
    const [model, ...effects] = step(initModel, {
      type: "write-failed",
      docId: "nonexistent",
      error: new Error("nope"),
    })

    expect(model).toBe(initModel)
    expect(effects).toHaveLength(0)
  })

  it("state-advanced for unknown doc — returns model unchanged", () => {
    const [initModel] = storeProgram.init
    const [model, ...effects] = step(initModel, {
      type: "state-advanced",
      docId: "nonexistent",
      delta: fakeDelta("orphan"),
      newVersion: "v1",
    })

    expect(model).toBe(initModel)
    expect(effects).toHaveLength(0)
  })

  it("compact for unknown doc — returns model unchanged", () => {
    const [initModel] = storeProgram.init
    const [model, ...effects] = step(initModel, {
      type: "compact",
      docId: "nonexistent",
      meta: plainMeta,
      entirety: fakePayload("orphan"),
      newVersion: "v1",
    })

    expect(model).toBe(initModel)
    expect(effects).toHaveLength(0)
  })

  it("queued compact appends to queued state-advanced", () => {
    const [initModel] = storeProgram.init
    const [idleModel] = step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v1",
    })
    const [writingModel] = step(idleModel, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("delta-1"),
      newVersion: "v2",
    })
    // Queue a state-advanced
    const [queuedDelta] = step(writingModel, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("delta-2"),
      newVersion: "v3",
    })
    // Append queue with a compact
    const [queuedCompact] = step(queuedDelta, {
      type: "compact",
      docId: "doc-1",
      meta: plainMeta,
      entirety: fakePayload("compacted"),
      newVersion: "v4",
    })

    const phase = getPhase(queuedCompact, "doc-1")
    expect(phase.status).toBe("writing")
    if (phase.status === "writing") {
      expect(phase.queued).toEqual([
        {
          type: "state-advanced",
          delta: fakeDelta("delta-2"),
          newVersion: "v3",
        },
        {
          type: "compact",
          meta: plainMeta,
          entirety: fakePayload("compacted"),
          newVersion: "v4",
        },
      ])
      expect(phase.pendingVersion).toBe("v2")
    }
  })

  it("model immutability — original model is not mutated", () => {
    const [initModel] = storeProgram.init
    const originalSize = initModel.docs.size

    step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v1",
    })

    // Original model is untouched
    expect(initModel.docs.size).toBe(originalSize)
    expect(initModel.docs.has("doc-1")).toBe(false)
  })

  it("register then write-succeeded — full lifecycle to idle", () => {
    const [initModel] = storeProgram.init

    const [registered] = step(initModel, {
      type: "register",
      docId: "doc-1",
      meta: plainMeta,
      entirety: fakePayload("initial"),
      version: "v1",
    })

    expect(getPhase(registered, "doc-1").status).toBe("writing")

    const [succeeded] = step(registered, {
      type: "write-succeeded",
      docId: "doc-1",
      version: "v1",
    })

    const phase = getPhase(succeeded, "doc-1")
    expect(phase).toEqual({ status: "idle", version: "v1" })
  })

  it("write-failed with queued compact — error + persist-replace emitted", () => {
    const [initModel] = storeProgram.init
    const [idleModel] = step(initModel, {
      type: "hydrated",
      docId: "doc-1",
      version: "v1",
    })
    const [writingModel] = step(idleModel, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("delta-1"),
      newVersion: "v2",
    })
    // Queue a compact
    const [queuedModel] = step(writingModel, {
      type: "compact",
      docId: "doc-1",
      meta: plainMeta,
      entirety: fakePayload("compacted"),
      newVersion: "v3",
    })

    const testError = new Error("io error")
    const [model, ...effects] = step(queuedModel, {
      type: "write-failed",
      docId: "doc-1",
      error: testError,
    })

    // Should be writing again from old version
    const phase = getPhase(model, "doc-1")
    expect(phase).toEqual({
      status: "writing",
      revertTo: { status: "idle", version: "v1" },
      pendingVersion: "v3",
    })

    // store-error first, then persist-replace for the queued compact
    expect(effects).toHaveLength(2)
    expect(effects[0]?.type).toBe("store-error")
    expect(effects[1]?.type).toBe("persist-replace")
    expect(
      (effects[1] as Extract<StoreEffect, { type: "persist-replace" }>).records,
    ).toEqual([
      { kind: "meta", meta: plainMeta },
      { kind: "entry", payload: fakePayload("compacted"), version: "v3" },
    ])
  })

  // -----------------------------------------------------------------------
  // The first write, and what happens when it does not land
  // -----------------------------------------------------------------------
  //
  // A document's first write is the one with nothing behind it. Every other
  // write can fall back to the last version the store confirmed; this one has
  // no such version, and the phase says so with `unwritten` rather than with
  // an empty string.

  /** Register `doc-1` and return the model with its first write in flight. */
  function registered(): StoreModel {
    const [model] = step(storeProgram.init[0], {
      type: "register",
      docId: "doc-1",
      meta: plainMeta,
      entirety: fakePayload("initial"),
      version: "v1",
    })
    return model
  }

  it("register → write-failed — falls back to unwritten, still reports the error", () => {
    const [model, ...effects] = step(registered(), {
      type: "write-failed",
      docId: "doc-1",
      error: new Error("disk full"),
    })

    // Not `{ status: "idle", version: "" }`. There is no confirmed version to
    // be idle at, and saying so is what lets the runtime tell "never written"
    // apart from "written, and here is where from".
    expect(getPhase(model, "doc-1")).toEqual({ status: "unwritten" })
    expect(effects).toHaveLength(1)
    expect(effects[0].type).toBe("store-error")
  })

  it("register → write-succeeded — reaches idle at the confirmed version", () => {
    const [model, ...effects] = step(registered(), {
      type: "write-succeeded",
      docId: "doc-1",
      version: "v1",
    })

    // The happy path through the first write. Cheap, but it guards the case
    // that would hang every `flush()`: if a successful write ever stopped
    // being acknowledged, the document would sit in `writing` forever and
    // `allDocsIdle` would never come true.
    expect(getPhase(model, "doc-1")).toEqual({ status: "idle", version: "v1" })
    expect(effects).toHaveLength(0)
  })

  it("allDocsIdle — true for unwritten, false while writing", () => {
    // `flush()` and `shutdown()` block on this predicate, so it has to mean
    // "no I/O outstanding" rather than "status is literally idle". An
    // unwritten document has nothing in flight; treating it as busy would
    // hang every teardown.
    expect(allDocsIdle(registered())).toBe(false)

    const [failed] = step(registered(), {
      type: "write-failed",
      docId: "doc-1",
      error: new Error("disk full"),
    })
    expect(allDocsIdle(failed)).toBe(true)
  })

  it("unwritten → register → write-succeeded — recovers to idle", () => {
    // The recovery path, and that `unwritten` is not a dead end. The runtime
    // answers a mutation on an unwritten document by dispatching a fresh
    // `register` carrying the whole document; this is the program's half.
    const [unwritten] = step(registered(), {
      type: "write-failed",
      docId: "doc-1",
      error: new Error("disk full"),
    })
    expect(getPhase(unwritten, "doc-1")).toEqual({ status: "unwritten" })

    const [retrying, ...retryEffects] = step(unwritten, {
      type: "register",
      docId: "doc-1",
      meta: plainMeta,
      entirety: fakePayload("whole"),
      version: "v2",
    })
    expect(retryEffects).toHaveLength(1)
    expect(retryEffects[0].type).toBe("persist-append")

    const [recovered] = step(retrying, {
      type: "write-succeeded",
      docId: "doc-1",
      version: "v2",
    })
    expect(getPhase(recovered, "doc-1")).toEqual({
      status: "idle",
      version: "v2",
    })
  })

  it("on an unwritten doc, compact writes but state-advanced does not", () => {
    // The asymmetry is the point, and it follows from what each input
    // carries. A compaction is a whole document plus its own meta, so it can
    // be written with nothing behind it. A state advance is a *delta* — it is
    // defined relative to a version the store confirmed, and there is none, so
    // there is nothing coherent to append it to.
    const [unwritten] = step(registered(), {
      type: "write-failed",
      docId: "doc-1",
      error: new Error("disk full"),
    })

    const [advancedModel, ...advancedEffects] = step(unwritten, {
      type: "state-advanced",
      docId: "doc-1",
      delta: fakeDelta("d1"),
      newVersion: "v2",
    })
    expect(advancedEffects).toHaveLength(0)
    expect(getPhase(advancedModel, "doc-1")).toEqual({ status: "unwritten" })

    const [compactedModel, ...compactEffects] = step(unwritten, {
      type: "compact",
      docId: "doc-1",
      meta: plainMeta,
      entirety: fakePayload("whole"),
      newVersion: "v2",
    })
    expect(compactEffects).toHaveLength(1)
    expect(compactEffects[0].type).toBe("persist-replace")
    expect(getPhase(compactedModel, "doc-1")).toEqual({
      status: "writing",
      revertTo: { status: "unwritten" },
      pendingVersion: "v2",
    })
  })
})
