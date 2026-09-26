// ephemeral-projection: the pieces the projection is built from.
//
// The projection as a whole is pinned by `projection-conformance` (σ ≡ Π(λ))
// and by `ephemeral-decay`. These pin the two pure pieces its shell leans on:
// decay applied by the fold, and the plan of which root fields to announce.

import { describe, expect, it } from "vitest"
import {
  createMaterializeInterpreter,
  interpret,
  type MaterializeResolver,
  materializeContextFromResolver,
  Schema,
} from "../index.js"
import type { Path } from "../interpret.js"
import { withDecay } from "../interpreters/with-decay.js"
import { movedRootKeys } from "../substrates/state-tree.js"

describe("withDecay", () => {
  // A resolver that records every path it is asked about.
  const recording = () => {
    const asked: string[] = []
    const answer = <T>(path: Path, value: T): T => {
      asked.push(path.segments.map(segment => segment.resolve()).join("."))
      return value
    }
    const resolver: MaterializeResolver = {
      resolveValue: path => answer(path, "written"),
      resolveText: path => answer(path, undefined),
      resolveCounter: path => answer(path, undefined),
      resolveRichText: path => answer(path, undefined),
      resolveLength: path => answer(path, 0),
      resolveKeys: path => answer(path, []),
      resolveForest: path => answer(path, []),
    }
    return { asked, resolver }
  }

  const Doc = Schema.struct({
    user: Schema.struct({ name: Schema.string(), mood: Schema.string() }).decay(
      1000,
    ),
    other: Schema.string(),
  })

  const project = (newest: number, now: number) => {
    const { asked, resolver } = recording()
    const value = interpret(
      Doc,
      withDecay(createMaterializeInterpreter(resolver), () => newest, now),
      materializeContextFromResolver(resolver),
    )
    return { asked, value }
  }

  it("reads an expired container as its structural zero, without walking it", () => {
    const { asked, value } = project(1000, 2001)
    expect(value).toEqual({ user: { name: "", mood: "" }, other: "written" })
    expect(asked).toEqual(["other"])
  })

  it("leaves a container inside its window alone", () => {
    const { asked, value } = project(1500, 2001)
    expect(value).toEqual({
      user: { name: "written", mood: "written" },
      other: "written",
    })
    expect(asked).toEqual(["user.name", "user.mood", "other"])
  })

  it("does not decay a node nothing has been written to", () => {
    // `newestAt` answers 0 there. Treating that as a timestamp would call the
    // node expired from the first tick, which is harmless for the value, since
    // it is already the zero, but would skip walking what is there.
    const { asked } = project(0, 2001)
    expect(asked).toEqual(["user.name", "user.mood", "other"])
  })
})

describe("movedRootKeys", () => {
  it("names the root fields whose projection changed", () => {
    expect(
      movedRootKeys(
        { a: 1, b: { x: 1 }, c: "same" },
        { a: 2, b: { x: 1 }, c: "same" },
      ),
    ).toEqual(["a"])
  })

  it("compares by value, not by identity", () => {
    expect(movedRootKeys({ b: { x: [1, 2] } }, { b: { x: [1, 2] } })).toEqual(
      [],
    )
  })

  it("names a field the current state does not have yet", () => {
    expect(movedRootKeys({}, { a: undefined })).toEqual(["a"])
  })
})
