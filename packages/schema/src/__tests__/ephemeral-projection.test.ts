// ephemeral-projection: the pieces the projection is built from.
//
// The projection as a whole is pinned by `projection-conformance` (σ ≡ Π(λ))
// and by `ephemeral-decay`. These pin the pure piece its shell leans on:
// decay applied by the fold. What a re-projection announces is `diffOps`,
// pinned in `diff-ops.test.ts`.

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
import { RawPath } from "../path.js"
import {
  createStateTreeResolver,
  type StateTree,
} from "../substrates/state-tree.js"
import { hz, tup } from "./ephemeral-fixtures.js"

describe("withDecay", () => {
  // A resolver that records every path it is asked about.
  const recording = () => {
    const asked: string[] = []
    const answer = <T>(path: Path, value: T): T => {
      asked.push(path.segments.map(segment => segment.coord()).join("."))
      return value
    }
    const resolver: MaterializeResolver = {
      resolveValue: path => answer(path, "written"),
      resolveText: path => answer(path, undefined),
      resolveCounter: path => answer(path, undefined),
      resolveRichText: path => answer(path, undefined),
      resolveLength: path => answer(path, 0),
      resolveKeys: path => answer(path, []),
      resolveHasKey: path => answer(path, false),
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

describe("createStateTreeResolver.resolveHasKey", () => {
  it("agrees with resolveKeys: live, deleted, re-written, emptied and never-seen entries", () => {
    // `alice` live, `bob` deleted, `carol` written after a horizon, `dave` a
    // container whose only entry was deleted, and `erin` never seen.
    const tree: StateTree = {
      peers: {
        alice: tup(1, 10),
        bob: tup(null, 20, true),
        carol: hz({ x: tup(3, 40) }, 30, true),
        dave: { x: tup(null, 50, true) },
      },
      blob: tup({ frank: 1 }, 60),
    }
    const resolver = createStateTreeResolver(tree)
    for (const field of ["peers", "blob"]) {
      const path = RawPath.empty.field(field)
      for (const key of ["alice", "bob", "carol", "dave", "erin", "frank"]) {
        expect(resolver.resolveHasKey(path, key)).toBe(
          resolver.resolveKeys(path).includes(key),
        )
      }
    }
    expect(resolver.resolveKeys(RawPath.empty.field("peers"))).toEqual([
      "alice",
      "carol",
    ])
  })
})
