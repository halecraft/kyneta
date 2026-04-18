// change-commit-options — tests that CommitOptions.origin propagates
// through change() to Changeset.origin received by subscribers.

import type { Changeset } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import { json } from "../bind.js"
import { createDoc } from "../create-doc.js"
import { change } from "../facade/change.js"
import { subscribeNode } from "../facade/observe.js"
import { Schema } from "../schema.js"

// ===========================================================================
// Shared fixtures
// ===========================================================================

const TextDocSchema = Schema.struct({
  title: Schema.text(),
})

// ===========================================================================
// change(): CommitOptions.origin propagation
// ===========================================================================

describe("change: CommitOptions.origin propagation", () => {
  it("change() with { origin } propagates origin to Changeset received by subscribers", () => {
    const doc = createDoc(json.bind(TextDocSchema))

    const changesets: Changeset[] = []
    subscribeNode(doc.title, cs => changesets.push(cs))

    change(
      doc,
      d => {
        d.title.insert(0, "Hello")
      },
      { origin: "local" },
    )

    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.origin).toBe("local")
  })

  it("change() without options produces origin === undefined", () => {
    const doc = createDoc(json.bind(TextDocSchema))

    const changesets: Changeset[] = []
    subscribeNode(doc.title, cs => changesets.push(cs))

    change(doc, d => {
      d.title.insert(0, "World")
    })

    expect(changesets).toHaveLength(1)
    expect(changesets[0]?.origin).toBeUndefined()
  })
})