// version-conformance — the `Version` lattice laws, as a shared suite.
//
// Every version type that claims to be a lattice runs this against a handful
// of its own versions, chosen to include equal, ordered and concurrent pairs.
// Equality throughout is `compare(...) === "equal"`, the only equality a
// `Version` offers.

import { describe, expect, it } from "vitest"
import { reaches, type Version } from "../substrate.js"

export interface VersionConformanceOptions {
  /** Appended to the suite name, so a failure names its version type. */
  readonly label: string
  /**
   * Versions of one lineage, with ordered pairs and, for a partial order,
   * concurrent ones.
   */
  readonly samples: () => readonly Version[]
  /** `"total"` when no two versions of one lineage are ever concurrent. */
  readonly order: "total" | "partial"
  /** The type's parser, to check that `serialize` round-trips. */
  readonly parse: (serialized: string) => Version
}

export function versionConformance(options: VersionConformanceOptions): void {
  const same = (a: Version, b: Version) => a.compare(b) === "equal"
  const pairs = () => {
    const vs = options.samples()
    return vs.flatMap(a => vs.map(b => [a, b] as const))
  }
  const triples = () => {
    const vs = options.samples()
    return vs.flatMap(a => vs.flatMap(b => vs.map(c => [a, b, c] as const)))
  }

  describe(`version lattice (${options.label})`, () => {
    it("has the samples the laws need, so they are not vacuous", () => {
      const orders = new Set(pairs().map(([a, b]) => a.compare(b)))
      expect(orders).toEqual(
        new Set(
          options.order === "partial"
            ? ["equal", "behind", "ahead", "concurrent"]
            : ["equal", "behind", "ahead"],
        ),
      )
    })

    it("compare is reflexive and antisymmetric", () => {
      const flip = {
        equal: "equal",
        behind: "ahead",
        ahead: "behind",
        concurrent: "concurrent",
      } as const
      for (const [a, b] of pairs()) {
        expect(a.compare(a)).toBe("equal")
        expect(b.compare(a)).toBe(flip[a.compare(b)])
      }
    })

    it("meet and join are commutative and idempotent", () => {
      for (const [a, b] of pairs()) {
        expect(same(a.meet(b), b.meet(a))).toBe(true)
        expect(same(a.join(b), b.join(a))).toBe(true)
        expect(same(a.meet(a), a)).toBe(true)
        expect(same(a.join(a), a)).toBe(true)
      }
    })

    it("meet and join are associative", () => {
      for (const [a, b, c] of triples()) {
        expect(same(a.meet(b.meet(c)), a.meet(b).meet(c))).toBe(true)
        expect(same(a.join(b.join(c)), a.join(b).join(c))).toBe(true)
      }
    })

    it("the meet is a lower bound and the join an upper bound", () => {
      for (const [a, b] of pairs()) {
        expect(reaches(a, a.meet(b))).toBe(true)
        expect(reaches(b, a.meet(b))).toBe(true)
        expect(reaches(a.join(b), a)).toBe(true)
        expect(reaches(a.join(b), b)).toBe(true)
      }
    })

    it("meet and join absorb each other", () => {
      for (const [a, b] of pairs()) {
        expect(same(a.meet(a.join(b)), a)).toBe(true)
        expect(same(a.join(a.meet(b)), a)).toBe(true)
      }
    })

    it("reaching a version is joining it without moving", () => {
      for (const [a, b] of pairs()) {
        expect(reaches(a, b)).toBe(same(a.join(b), a))
      }
    })

    it("serialize round-trips", () => {
      for (const a of options.samples()) {
        expect(same(options.parse(a.serialize()), a)).toBe(true)
      }
    })
  })
}
