// epoch-boundary — unit tests for the pure isEpochBoundaryOffer classifier.
//
// This is the explicit epoch-boundary signal that the Synchronizer gates
// on in `#executeImportDocData`, replacing the `isEntirety && hasEverSynced`
// heuristic for identity-discontinuity resets. Critically, this fires
// independent of payload shape — proven here by testing it directly as a
// pure function of two epoch strings, with no `kind` argument at all.

import { DEFAULT_EPOCH, LEGACY_EPOCH } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { isEpochBoundaryOffer } from "../synchronizer.js"

describe("isEpochBoundaryOffer", () => {
  it("is false when both epochs match", () => {
    expect(isEpochBoundaryOffer("inc-a", "inc-a")).toBe(false)
  })

  it("is true when both epochs are REAL and differ — proves the check is independent of payload kind", () => {
    // The function signature itself has no `kind` parameter: this test
    // demonstrates the explicit epoch comparison triggers a boundary
    // determination without any payload-shape information at all — the
    // exact heuristic-bypass the plan requires (fires even for `kind:
    // "since"`, since the Synchronizer calls this before inspecting kind).
    expect(isEpochBoundaryOffer("inc-a", "inc-b")).toBe(true)
  })

  it("is false when local is DEFAULT_EPOCH (normal lazy-mint/first-sync path)", () => {
    expect(isEpochBoundaryOffer(DEFAULT_EPOCH, "inc-b")).toBe(false)
  })

  it("is false when remote is DEFAULT_EPOCH", () => {
    expect(isEpochBoundaryOffer("inc-a", DEFAULT_EPOCH)).toBe(false)
  })

  it("is false when both are DEFAULT_EPOCH", () => {
    expect(isEpochBoundaryOffer(DEFAULT_EPOCH, DEFAULT_EPOCH)).toBe(false)
  })

  it("is false when local is LEGACY_EPOCH (uninformative signal)", () => {
    expect(isEpochBoundaryOffer(LEGACY_EPOCH, "inc-b")).toBe(false)
  })

  it("is false when remote is LEGACY_EPOCH", () => {
    expect(isEpochBoundaryOffer("inc-a", LEGACY_EPOCH)).toBe(false)
  })

  it("is false when both are LEGACY_EPOCH", () => {
    expect(isEpochBoundaryOffer(LEGACY_EPOCH, LEGACY_EPOCH)).toBe(false)
  })
})
