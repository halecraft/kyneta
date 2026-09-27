// version-lattice — the `Version` laws for the versions this package owns,
// and `reaches`, the one test of holding a version.

import { describe, expect, it } from "vitest"
import { reaches } from "../substrate.js"
import { StateVersion } from "../substrates/ephemeral.js"
import {
  DEFAULT_LINEAGE,
  PlainVersion,
  plainReplicaFactory,
} from "../substrates/plain.js"
import { versionConformance } from "../testing/version-conformance.js"

const genesis = new PlainVersion(0, DEFAULT_LINEAGE)

describe("PlainVersion", () => {
  // Within one lineage the order is total. Two real lineages are concurrent
  // and have no join, so they are tested on their own below.
  versionConformance({
    label: "plain",
    order: "total",
    samples: () => [
      genesis,
      new PlainVersion(2, "L"),
      new PlainVersion(5, "L"),
    ],
    parse: s => plainReplicaFactory.parseVersion(s),
  })

  it("orders two real lineages as concurrent, and has no join for them", () => {
    const a = new PlainVersion(2, "L")
    const b = new PlainVersion(3, "M")
    expect(a.compare(b)).toBe("concurrent")
    expect(a.meet(b).compare(genesis)).toBe("equal")
    expect(() => a.join(b)).toThrow("different lineages have no join")
  })

  it("joins genesis as the identity", () => {
    const a = new PlainVersion(4, "L")
    expect(genesis.join(a).compare(a)).toBe("equal")
    expect(a.join(genesis).compare(a)).toBe("equal")
  })
})

describe("StateVersion.join", () => {
  it("is the larger count within one incarnation", () => {
    const a = new StateVersion("i", 2)
    const b = new StateVersion("i", 5)
    expect(a.join(b).installSeq).toBe(5)
    expect(b.join(a).installSeq).toBe(5)
  })

  it("throws for two incarnations", () => {
    expect(() =>
      new StateVersion("i", 2).join(new StateVersion("j", 2)),
    ).toThrow("no join")
  })
})

describe("reaches", () => {
  it("is true for ahead and equal, false for behind and concurrent", () => {
    const low = new PlainVersion(1, "L")
    const high = new PlainVersion(3, "L")
    expect(reaches(high, low)).toBe(true)
    expect(reaches(high, high)).toBe(true)
    expect(reaches(low, high)).toBe(false)
    expect(reaches(low, new PlainVersion(1, "M"))).toBe(false)
  })
})
