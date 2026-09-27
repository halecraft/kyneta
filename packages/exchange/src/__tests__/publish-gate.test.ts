// publish-gate — may a document's live state leave the process?

import { PlainVersion } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { gateOpen } from "../publish-gate.js"

const at = (n: number, lineage = "L") => new PlainVersion(n, lineage)

describe("gateOpen", () => {
  it("is open with no own write held", () => {
    expect(
      gateOpen({ ownHigh: undefined, confirmed: undefined, current: at(3) }),
    ).toBe(true)
  })

  it("is shut until the store confirms a version reaching the own writes", () => {
    expect(
      gateOpen({ ownHigh: at(3), confirmed: undefined, current: at(3) }),
    ).toBe(false)
    expect(gateOpen({ ownHigh: at(3), confirmed: at(2), current: at(3) })).toBe(
      false,
    )
    expect(gateOpen({ ownHigh: at(3), confirmed: at(3), current: at(4) })).toBe(
      true,
    )
  })

  it("is open once a reset has discarded the own writes", () => {
    // The replica no longer holds them, so there is nothing to confirm, and
    // the store confirms only versions of the new lineage.
    expect(
      gateOpen({
        ownHigh: at(3, "old"),
        confirmed: at(1, "old"),
        current: at(5, "new"),
      }),
    ).toBe(true)
  })
})
