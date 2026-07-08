// PlainVersion as a version vector — characterizes that compare/meet reduce
// to the shared versionVectorCompare/versionVectorMeet over a single-entry
// lineage projection, with genesis (DEFAULT_EPOCH) as the empty vector ⊥.
// Context: jj:kxswmuzx.

import { describe, expect, it } from "vitest"
import { DEFAULT_EPOCH, PlainVersion } from "../substrates/plain.js"
import { versionVectorCompare, versionVectorMeet } from "../version-vector.js"

const A = "aaaa1111"
const B = "bbbb2222"
const genesis = () => new PlainVersion(0, DEFAULT_EPOCH)
const authored = (key: string, n: number) => new PlainVersion(n, key)

// The reference projection compare/meet are expected to agree with.
const toVec = (v: PlainVersion) =>
  v.epoch === DEFAULT_EPOCH
    ? new Map<string, number>()
    : new Map([[v.epoch, v.value]])

describe("PlainVersion is a single-entry version vector", () => {
  it("compare agrees with versionVectorCompare across the matrix", () => {
    const xs = [genesis(), authored(A, 1), authored(A, 5), authored(B, 7)]
    for (const a of xs) {
      for (const b of xs) {
        expect(a.compare(b)).toBe(versionVectorCompare(toVec(a), toVec(b)))
      }
    }
  })

  it("two genesis peers are equal; genesis is behind any REAL lineage", () => {
    expect(genesis().compare(genesis())).toBe("equal")
    expect(genesis().compare(authored(A, 5))).toBe("behind")
    expect(authored(A, 5).compare(genesis())).toBe("ahead")
  })

  it("same lineage is a total order; divergent lineages are concurrent", () => {
    expect(authored(A, 3).compare(authored(A, 5))).toBe("behind")
    expect(authored(A, 5).compare(authored(A, 3))).toBe("ahead")
    expect(authored(A, 4).compare(authored(A, 4))).toBe("equal")
    expect(authored(A, 3).compare(authored(B, 3))).toBe("concurrent")
    expect(authored(A, 5).compare(authored(B, 3))).toBe("concurrent")
  })

  it("meet of a shared lineage is the min; of divergent lineages is genesis", () => {
    const same = authored(A, 5).meet(authored(A, 3)) as PlainVersion
    expect(same.epoch).toBe(A)
    expect(same.value).toBe(3)

    const divergent = authored(A, 5).meet(authored(B, 7)) as PlainVersion
    expect(divergent.epoch).toBe(DEFAULT_EPOCH)
    expect(divergent.value).toBe(0)

    // Reconstruction agrees with the raw versionVectorMeet.
    expect([
      ...versionVectorMeet(toVec(authored(A, 5)), toVec(authored(B, 7))),
    ]).toEqual([])
  })
})
