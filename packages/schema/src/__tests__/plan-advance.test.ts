// planAdvance — what `advance(to)` must do under the `Replica` contract,
// decided once for every replica: throw only beyond the current version, and
// trim only to a version after the base that the replica can place.

import { describe, expect, it } from "vitest"
import { planAdvance, type Version } from "../substrate.js"
import { versionVectorCompare, versionVectorMeet } from "../version-vector.js"

/** A version vector on `lineage`, the order CRDT versions have. */
function vv(entries: Record<string, number>, lineage = "vv"): Version {
  const vector = new Map(Object.entries(entries))
  const version: Version & { vector: Map<string, number> } = {
    lineage,
    vector,
    serialize: () => JSON.stringify([lineage, entries]),
    compare: other =>
      versionVectorCompare(vector, (other as typeof version).vector),
    meet: other =>
      vv(
        Object.fromEntries(
          versionVectorMeet(vector, (other as typeof version).vector),
        ),
        lineage,
      ),
    join: () => {
      throw new Error("unused")
    },
  }
  return version
}

describe("planAdvance", () => {
  const base = vv({ a: 2 })
  const current = vv({ a: 5, b: 3 })

  it("trims to a version after the base and at or before the current one", () => {
    expect(planAdvance({ base, current, to: vv({ a: 4, b: 1 }) })).toBe("trim")
    expect(planAdvance({ base, current, to: current })).toBe("trim")
  })

  it("throws for a version beyond the current one", () => {
    expect(planAdvance({ base, current, to: vv({ a: 6, b: 3 }) })).toBe(
      "beyond",
    )
  })

  it("trims nothing for a version concurrent with the current one: not beyond it, and not placeable", () => {
    expect(planAdvance({ base, current, to: vv({ a: 4, c: 1 }) })).toBe(
      "nothing",
    )
  })

  it("trims nothing for a version the base has reached", () => {
    expect(planAdvance({ base, current, to: base })).toBe("nothing")
    expect(planAdvance({ base, current, to: vv({ a: 1 }) })).toBe("nothing")
    expect(planAdvance({ base, current, to: vv({}) })).toBe("nothing")
  })

  it("trims nothing for a version concurrent with the base", () => {
    const branched = { base: vv({ a: 2 }), current: vv({ a: 5, b: 3 }) }
    expect(planAdvance({ ...branched, to: vv({ a: 1, b: 2 }) })).toBe("nothing")
  })

  it("trims nothing for a version of another lineage", () => {
    expect(planAdvance({ base, current, to: vv({ a: 9 }, "elsewhere") })).toBe(
      "nothing",
    )
  })
})
