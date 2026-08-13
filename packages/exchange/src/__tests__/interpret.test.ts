// interpret.test.ts — the phase classifier, as a truth table.
//
// Six rules, six tests, no Exchange and no Runtime. The classifier holds no
// policy, so what is interesting here is what it *refuses*: the one place
// callers legitimately differ lives in `#getImpl`, and is tested there against
// a real Exchange because that is the only place it is true.

import type { DocMetadata, ReadCapability } from "@kyneta/schema"
import { SYNC_AUTHORITATIVE } from "@kyneta/schema"
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
      planInterpretation({ phase: "absent", reader, doc: undefined }),
    ).toEqual({
      action: "create",
    })
  })

  it("returns the cached ref for an already-interpreted document", () => {
    expect(planInterpretation({ phase: "interpret", reader, doc })).toEqual({
      action: "return-cached",
    })
  })

  it("refuses a replicate document as unsupported, not as a mismatch", () => {
    // The distinction is the point: "not built yet" and "can never work" are
    // different answers, and a caller should be able to tell them apart
    // without parsing an error message.
    expect(planInterpretation({ phase: "replicate", reader, doc })).toEqual({
      action: "refuse",
      kind: "unsupported",
      from: "replicate",
    })
  })

  it("promotes a deferred document the reader can interpret", () => {
    expect(planInterpretation({ phase: "deferred", reader, doc })).toEqual({
      action: "promote",
      from: "deferred",
    })
  })

  it("promotes a deferred document we know nothing about", () => {
    // Nothing contradicts the request. A blanket sweep that has no metadata
    // keeps its own guard rather than relying on this.
    expect(
      planInterpretation({ phase: "deferred", reader, doc: undefined }),
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
      })
      expect(action).toMatchObject({
        action: "refuse",
        kind: "mismatch",
        mismatch: { axis },
      })
    }
  })
})
