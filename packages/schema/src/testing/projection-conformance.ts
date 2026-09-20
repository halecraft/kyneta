// projection-conformance — shared, re-exportable suite for the projection law.
//
// A substrate that keeps a shadow holds the same document twice: σ, the
// `PlainState` every read is served from, and λ, the native store that
// replicates. Three do — `ephemeral`, `loro` and `yjs` — and each advances the
// two independently on a local write. The law is that they agree:
//
//   σ ≡ Π(λ)
//
// Π is the substrate's own materialiser: `extractPlainState`,
// `materializeLoroShadow`, `materializeYjsShadow`. The suite applies each write
// and compares the two derivations.
//
// **Why this is not a function compared with itself.** On the write path σ is
// advanced by `applyChange` and λ by `applyChangeToStateTree` or
// `changeToDiff` — different code, reading the same change. A substrate uses
// its materialiser only on the *replay* path, so reprojecting after a local
// write crosses from one derivation to the other.
//
// **Why `plain` does not run it.** There σ *is* the document and Π is the
// identity, so the comparison holds for a reason unrelated to any substrate
// behaviour.
//
// The env supplies the schema and the writes, and the suite supplies only the
// law, because the admissible schema differs per substrate: `ephemeral` has no
// representation for a sequence, set, text or counter, so a shared fixture
// would have to be the narrowest one and would stop exercising the backends
// where those kinds are native.

import { describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Factory interface
// ---------------------------------------------------------------------------

export interface ProjectionWrite {
  /** Names the step, so a parity failure names where it broke. */
  readonly name: string
  /** One `batch()` against the document under test. */
  apply(): void
}

export interface ProjectionTestEnv {
  /** Mutations to apply in order. */
  readonly writes: ReadonlyArray<ProjectionWrite>
  /** σ — the shadow the substrate's `Reader` serves. */
  shadow(): unknown
  /** Π(λ) — σ re-derived from the native store by the substrate's materialiser. */
  reproject(): unknown
}

export type ProjectionConformanceFactory = () => ProjectionTestEnv

export interface ProjectionConformanceOptions {
  /** Appended to the suite name, so a failure names its substrate. */
  readonly label?: string
}

// ---------------------------------------------------------------------------
// Conformance suite
// ---------------------------------------------------------------------------

export function projectionConformance(
  factory: ProjectionConformanceFactory,
  options?: ProjectionConformanceOptions,
): void {
  const suffix = options?.label ? ` (${options.label})` : ""
  const steps = factory().writes.map(w => w.name)

  describe(`projection conformance${suffix}`, () => {
    steps.forEach((name, index) => {
      it(`σ ≡ Π(λ) after: ${name}`, () => {
        // A fresh document per step, replaying the prefix, so the failing
        // assertion names the write that broke parity rather than the last
        // one in the sequence.
        const env = factory()
        for (let i = 0; i <= index; i++) {
          const write = env.writes[i]
          if (!write) throw new Error(`write ${i} missing`)
          write.apply()
        }

        expect(env.shadow()).toEqual(env.reproject())
      })
    })

    it("has writes to check", () => {
      // A factory that returns nothing would make every assertion above
      // vacuous by producing no tests at all.
      expect(steps.length).toBeGreaterThan(0)
    })
  })
}
