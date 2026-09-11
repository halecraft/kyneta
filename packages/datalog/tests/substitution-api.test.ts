// === The substitution vocabulary, as a consumer reaches it ===
//
// A consumer that produces bindings by its own means — a game engine's effect
// layer matching an event against a pattern, say — then has to turn them into
// a ground head this engine would accept. That is one operation, and these are
// the five names it needs.
//
// Everything here imports from `../src/index.js` rather than `../src/unify.js`
// on purpose. The point of the file is the *barrel*: these names are a
// compatibility promise, and a relative import would pass while the promise
// was quietly broken.

import { describe, expect, it } from "vitest"
import type { Substitution } from "../src/index.js"
import {
  _,
  varTerm as $,
  atom,
  constTerm,
  EMPTY_SUBSTITUTION,
  extendSubstitution,
  groundAtom,
  resolveTerm,
} from "../src/index.js"

describe("substitutions through the barrel", () => {
  it("turns bindings a consumer made itself into a ground head", () => {
    // The whole use case, in four lines.
    const head = atom("damaged", [$("Target"), $("Amount")])
    const sub = extendSubstitution(
      extendSubstitution(EMPTY_SUBSTITUTION, "Target", "goblin"),
      "Amount",
      7,
    )

    expect(groundAtom(head, sub)).toEqual(["goblin", 7])
  })

  it("leaves the empty substitution alone when extending it", () => {
    // `EMPTY_SUBSTITUTION` is a shared module-level singleton, so a consumer
    // extending it in a loop must not be able to contaminate the next caller.
    extendSubstitution(EMPTY_SUBSTITUTION, "X", "dirt")

    expect(EMPTY_SUBSTITUTION.bindings.size).toBe(0)
    expect(EMPTY_SUBSTITUTION.weight).toBe(1)
  })

  it("starts at weight 1 and preserves it across extension", () => {
    // The weight is Z-set provenance. A consumer building its own bindings
    // should see it stay at 1 rather than have to reason about it.
    const sub = extendSubstitution(EMPTY_SUBSTITUTION, "X", 1)
    expect(sub.weight).toBe(1)
  })

  it("resolves constants, bound variables and neither", () => {
    const sub = extendSubstitution(EMPTY_SUBSTITUTION, "Bound", "yes")

    expect(resolveTerm(constTerm("lit"), sub)).toBe("lit")
    expect(resolveTerm($("Bound"), sub)).toBe("yes")
    expect(resolveTerm($("Free"), sub)).toBeUndefined()
    expect(resolveTerm(_, sub)).toBeUndefined()
  })

  it("distinguishes bound-to-null from unbound only via `bindings`", () => {
    // The trap the barrel documents: `null` is a legitimate Value, so
    // `resolveTerm` returning it is a *binding*, while `undefined` is not.
    const sub = extendSubstitution(EMPTY_SUBSTITUTION, "Nothing", null)

    expect(resolveTerm($("Nothing"), sub)).toBeNull()
    expect(sub.bindings.has("Nothing")).toBe(true)
    expect(sub.bindings.has("Absent")).toBe(false)
    // And it grounds, rather than being mistaken for an unbound variable.
    expect(groundAtom(atom("h", [$("Nothing")]), sub)).toEqual([null])
  })

  it("returns null from groundAtom rather than throwing on a partial head", () => {
    const sub = extendSubstitution(EMPTY_SUBSTITUTION, "X", 1)

    expect(groundAtom(atom("h", [$("X"), $("Y")]), sub)).toBeNull()
    // A wildcard in head position is a logical error, not a hole to fill.
    expect(groundAtom(atom("h", [$("X"), _]), sub)).toBeNull()
  })

  it("accepts a Substitution a consumer built structurally", () => {
    // The type is exported, so a consumer may assemble one directly instead of
    // folding `extendSubstitution`. That has to work.
    const sub: Substitution = {
      bindings: new Map([["Target", "goblin"]]),
      weight: 1,
    }

    expect(groundAtom(atom("hit", [$("Target")]), sub)).toEqual(["goblin"])
  })
})
