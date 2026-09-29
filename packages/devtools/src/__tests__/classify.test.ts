// classify — pure functional-core tests. No Exchange, no index.

import type { ObsEvent } from "@kyneta/exchange"
import { describe, expect, it } from "vitest"
import { classify } from "../classify.js"

/** Wrap a body in an envelope to form an ObsEvent. */
function ev(body: object, peerId = "alice", seq = 0): ObsEvent {
  return { v: 1, seq, t: 0, peerId, ...body } as ObsEvent
}

describe("classify", () => {
  it("routes every event into `events`, keyed peerId:seq", () => {
    const r = classify(
      ev(
        { layer: "engine", kind: "transition", program: "sync", summary: "x" },
        "bob",
        7,
      ),
    )
    expect(r).toContainEqual({
      stream: "events",
      op: "set",
      key: "bob:7",
      value: expect.anything(),
    })
  })

  it("peer established → set, departed → delete", () => {
    expect(
      classify(
        ev({
          layer: "directory",
          kind: "peer",
          change: "peer-established",
          peer: "bob",
        }),
      ),
    ).toContainEqual({
      stream: "peers",
      op: "set",
      key: "bob",
      value: { peerId: "bob", status: "peer-established" },
    })
    expect(
      classify(
        ev({
          layer: "directory",
          kind: "peer",
          change: "peer-departed",
          peer: "bob",
        }),
      ),
    ).toContainEqual({ stream: "peers", op: "delete", key: "bob" })
  })

  it("doc lifecycle → documents; removed → delete", () => {
    expect(
      classify(
        ev({
          layer: "directory",
          kind: "doc",
          change: "doc-created",
          docId: "d",
        }),
      ),
    ).toContainEqual({
      stream: "documents",
      op: "set",
      key: "d",
      value: { docId: "d", lastChange: "doc-created" },
    })
    expect(
      classify(
        ev({
          layer: "directory",
          kind: "doc",
          change: "doc-removed",
          docId: "d",
        }),
      ),
    ).toContainEqual({ stream: "documents", op: "delete", key: "d" })
  })

  it("sync-state → syncStates, keyed docId:peer", () => {
    expect(
      classify(
        ev({
          layer: "directory",
          kind: "sync-state",
          docId: "d",
          peer: "bob",
          state: "synced",
        }),
      ),
    ).toContainEqual({
      stream: "syncStates",
      op: "set",
      key: "d:bob",
      value: { docId: "d", peer: "bob", state: "synced" },
    })
  })

  it("diagnostic → diagnostics, keyed peerId:seq", () => {
    const r = classify(
      ev(
        {
          layer: "diagnostic",
          kind: "diagnostic",
          severity: "error",
          message: "boom",
        },
        "alice",
        3,
      ),
    )
    expect(r).toContainEqual({
      stream: "diagnostics",
      op: "set",
      key: "alice:3",
      value: {
        peerId: "alice",
        seq: 3,
        severity: "error",
        message: "boom",
        docId: undefined,
      },
    })
  })

  it("is total — an unknown layer routes only to `events` and never throws", () => {
    const r = classify(ev({ layer: "future-layer", kind: "mystery" }))
    expect(r).toHaveLength(1)
    expect(r[0]?.stream).toBe("events")
  })
})
