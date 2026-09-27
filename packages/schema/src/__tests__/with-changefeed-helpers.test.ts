// Pure-helper unit tests for the tree-changefeed factory's Functional Core.
//
// `planTreeMembershipUpdate` and `synthesizeTreeDeleteTerminal` are
// extracted as exported pure helpers in `with-changefeed.ts` precisely
// so they can be table-tested without spinning up a doc.

import { describe, expect, it } from "vitest"
import {
  changesetMetadata,
  synthesizeTreeDeleteTerminal,
} from "../interpreters/with-changefeed.js"

// ---------------------------------------------------------------------------
// changesetMetadata — table tests
// ---------------------------------------------------------------------------

describe("changesetMetadata", () => {
  const source = Symbol("writer")
  it.each([
    [
      "author",
      { ingress: "author", origin: "o", source } as const,
      { origin: "o", replay: false, aborted: undefined, source },
    ],
    [
      "aborted author",
      { ingress: "author", origin: "o", source, aborted: true } as const,
      { origin: "o", replay: false, aborted: true, source },
    ],
    [
      "announce, not authored here",
      { ingress: "announce", origin: "sync", local: false } as const,
      { origin: "sync", replay: true, aborted: undefined, source: undefined },
    ],
    [
      "announce, a native local write",
      { ingress: "announce", origin: "binding", local: true } as const,
      {
        origin: "binding",
        replay: false,
        aborted: undefined,
        source: undefined,
      },
    ],
  ])("%s", (_name, options, expected) => {
    expect(changesetMetadata(options)).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// planTreeMembershipUpdate — table tests
// ---------------------------------------------------------------------------

describe("synthesizeTreeDeleteTerminal", () => {
  it("returns a Changeset with one tree-delete change carrying the id", () => {
    const result = synthesizeTreeDeleteTerminal("n1")

    expect(result.changes).toHaveLength(1)
    const change = result.changes[0]
    expect(change.type).toBe("tree")
    const insts = (
      change as unknown as {
        instructions: { action: string; target: string }[]
      }
    ).instructions
    expect(insts).toHaveLength(1)
    expect(insts[0].action).toBe("delete")
    expect(insts[0].target).toBe("n1")
  })

  it("does not carry origin / source / replay markers (terminal is synthetic)", () => {
    const result = synthesizeTreeDeleteTerminal("nX")
    expect(result.origin).toBeUndefined()
    expect(result.source).toBeUndefined()
    expect(result.replay).toBeUndefined()
    expect(result.aborted).toBeUndefined()
  })
})
