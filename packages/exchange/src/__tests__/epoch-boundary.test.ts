// lineage-boundary — unit tests for the pure isLineageBoundaryOffer classifier.
//
// This is the explicit lineage-boundary signal that the Synchronizer gates
// on in `#executeImportDocData`, replacing the `isEntirety && hasEverSynced`
// heuristic for identity-discontinuity resets. Critically, this fires
// independent of payload shape — proven here by testing it directly as a
// pure function of two lineage strings, with no `kind` argument at all.

import { DEFAULT_LINEAGE } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { isLineageBoundaryOffer } from "../synchronizer.js"

describe("isLineageBoundaryOffer", () => {
  it("is false when both lineages match", () => {
    expect(isLineageBoundaryOffer("inc-a", "inc-a")).toBe(false)
  })

  it("is true when both lineages are REAL and differ — proves the check is independent of payload kind", () => {
    // The function signature itself has no `kind` parameter: this test
    // demonstrates the explicit lineage comparison triggers a boundary
    // determination without any payload-shape information at all — the
    // exact heuristic-bypass the plan requires (fires even for `kind:
    // "since"`, since the Synchronizer calls this before inspecting kind).
    expect(isLineageBoundaryOffer("inc-a", "inc-b")).toBe(true)
  })

  it("is false when local is DEFAULT_LINEAGE (normal lazy-mint/first-sync path)", () => {
    expect(isLineageBoundaryOffer(DEFAULT_LINEAGE, "inc-b")).toBe(false)
  })

  it("is false when remote is DEFAULT_LINEAGE", () => {
    expect(isLineageBoundaryOffer("inc-a", DEFAULT_LINEAGE)).toBe(false)
  })

  it("is false when both are DEFAULT_LINEAGE", () => {
    expect(isLineageBoundaryOffer(DEFAULT_LINEAGE, DEFAULT_LINEAGE)).toBe(false)
  })
})
