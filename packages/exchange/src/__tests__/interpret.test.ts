// interpret.test.ts — the phase classifier, as a truth table.
//
// Six rules, six tests, no Exchange and no Runtime. The classifier holds no
// policy, so what is interesting here is what it *refuses*: the one place
// callers legitimately differ lives in `#getImpl`, and is tested there against
// a real Exchange because that is the only place it is true.

import type { DocMetadata, ReadCapability } from "@kyneta/schema"
import { SYNC_AUTHORITATIVE, SYNC_COLLABORATIVE } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { planInterpretation } from "../interpret.js"

const base = {
  replicaType: ["plain", 1, 0] as const,
  syncMode: SYNC_AUTHORITATIVE,
}

const reader: ReadCapability = {
  ...base,
  schemaHash: "h1",
  supportedHashes: ["h1"],
}
const doc: DocMetadata = { ...base, schemaHash: "h1" }

describe("planInterpretation", () => {
  it("creates when nothing is cached", () => {
    expect(
      planInterpretation({
        phase: "absent",
        reader,
        doc: undefined,
        hydrated: true,
      }),
    ).toEqual({
      action: "create",
    })
  })

  it("returns the cached ref for an already-interpreted document", () => {
    expect(
      planInterpretation({
        phase: "interpret",
        reader,
        doc,
        hydrated: true,
      }),
    ).toEqual({
      action: "return-cached",
    })
  })

  it("promotes a hydrated replicate document the reader can interpret", () => {
    // The caller supplies the one thing a replicate document lacks — a
    // schema — so the transition is one this peer has the information to make.
    expect(
      planInterpretation({ phase: "replicate", reader, doc, hydrated: true }),
    ).toEqual({ action: "promote", from: "replicate" })
  })

  it("refuses a still-loading replicate document before checking the schema", () => {
    // Ordering, not just outcome. A caller whose document is mid-load should
    // be told to wait rather than told their schema is wrong — so this asserts
    // `not-hydrated` for a reader that would otherwise be a clean match.
    expect(
      planInterpretation({ phase: "replicate", reader, doc, hydrated: false }),
    ).toEqual({ action: "refuse", kind: "not-hydrated" })
  })

  it("refuses a replicate document on each mismatched axis", () => {
    for (const [axis, docMeta] of [
      ["replicaType", { ...doc, replicaType: ["loro", 1, 0] as const }],
      ["syncMode", { ...doc, syncMode: SYNC_COLLABORATIVE }],
      ["schemaHash", { ...doc, schemaHash: "h2" }],
    ] as const) {
      const action = planInterpretation({
        phase: "replicate",
        reader,
        doc: docMeta,
        hydrated: true,
      })
      expect(action).toMatchObject({ action: "refuse", kind: "mismatch" })
      expect(
        action.action === "refuse" &&
          action.kind === "mismatch" &&
          action.mismatch.axis,
      ).toBe(axis)
    }
  })

  it("promotes a deferred document the reader can interpret", () => {
    expect(
      planInterpretation({
        phase: "deferred",
        reader,
        doc,
        hydrated: true,
      }),
    ).toEqual({
      action: "promote",
      from: "deferred",
    })
  })

  it("promotes a deferred document we know nothing about", () => {
    // Nothing contradicts the request. A blanket sweep that has no metadata
    // keeps its own guard rather than relying on this.
    expect(
      planInterpretation({
        phase: "deferred",
        reader,
        doc: undefined,
        hydrated: true,
      }),
    ).toEqual({ action: "promote", from: "deferred" })
  })

  it("refuses a deferred document on any axis, naming which", () => {
    // Including schemaHash. The classifier has no local-schema-authoritative
    // override — that policy belongs to `#getImpl`, and putting it here would
    // make this function answer differently depending on who asked.
    const cases: Array<[Partial<DocMetadata>, string]> = [
      [{ replicaType: ["loro", 1, 0] }, "replicaType"],
      [
        { syncMode: { ...SYNC_AUTHORITATIVE, durability: "transient" } },
        "syncMode",
      ],
      [{ schemaHash: "h2" }, "schemaHash"],
    ]
    for (const [override, axis] of cases) {
      const action = planInterpretation({
        phase: "deferred",
        reader,
        doc: { ...doc, ...override },
        hydrated: true,
      })
      expect(action).toMatchObject({
        action: "refuse",
        kind: "mismatch",
        mismatch: { axis },
      })
    }
  })
})
