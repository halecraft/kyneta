// projection-conformance — shared, re-exportable suite for the projection law.
//
// A substrate that keeps a shadow holds the same document twice: σ, the
// `PlainState` every read is served from, and λ, the native store that
// replicates. Three do — `ephemeral`, `loro` and `yjs` — and each advances the
// two independently on a local write. The law is that they agree:
//
//   σ ≡ Π(λ)
//
// Π is the substrate's own materialiser: `projectStateTree`,
// `materializeLoroShadow`, `materializeYjsShadow`. The suite applies each write
// and compares the two derivations.
//
// **Why this is not a function compared with itself.** On the write path σ is
// advanced by `applyChange` and λ by `applyChangeToStateTree` or
// `changeToDiff` — different code, reading the same change. A substrate uses
// its materialiser only on the *replay* path, so reprojecting after a local
// write crosses from one derivation to the other.
//
// **Why `plain` does not run it.** There σ *is* the document, Π is
// completion, and an authored op is logged exactly as σ applied it, so the
// comparison holds for a reason unrelated to any substrate behaviour.
//
// **The frozen invariant.** A read freezes σ in place, and a write copies the
// frozen nodes on its path. The suite also runs the writes with σ frozen
// before each, as a whole-document read would leave it, and checks that the
// law still holds and that no unfrozen node sits below a frozen one: that
// everything each write put into σ was owned or new.
//
// The env supplies the schema and the writes, and the suite supplies only the
// law, because the admissible schema differs per substrate: `ephemeral` has no
// representation for a sequence, set, text or counter, so a shared fixture
// would have to be the narrowest one and would stop exercising the backends
// where those kinds are native.

import { describe, expect, it } from "vitest"
import { freezeTree } from "../clone.js"
import { frozenInvariantViolations } from "./frozen-invariant.js"

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

    it("σ ≡ Π(λ), and the frozen invariant holds, when every write follows a read", () => {
      const env = factory()
      for (const write of env.writes) {
        freezeTree(env.shadow())
        write.apply()
      }
      expect(frozenInvariantViolations(env.shadow())).toEqual([])
      expect(env.shadow()).toEqual(env.reproject())
    })

    it("has writes to check", () => {
      // A factory that returns nothing would make every assertion above
      // vacuous by producing no tests at all.
      expect(steps.length).toBeGreaterThan(0)
    })
  })
}
