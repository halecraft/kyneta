// Pure-helper unit tests for the changefeed layer's Functional Core.

import { describe, expect, it } from "vitest"
import { changesetMetadata } from "../interpreters/with-changefeed.js"

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
