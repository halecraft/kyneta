// symbol-slot-descriptors — the framework symbols on a ref are non-enumerable,
// and that is load-bearing.
//
// `[TRANSACT]`, `[PATH]` and `[CHANGEFEED]` are attached with
// `Object.defineProperty` rather than by assignment. An assigned symbol is
// *enumerable*, and object spread copies enumerable own symbols — so
// `{...ref}` would produce a plain object carrying a live writable context, a
// path, and a changefeed that belong to a different value.
//
// Nothing else in the suite covers this. Swapping `defineProperty` for
// assignment leaves every other test green, which is precisely why it is
// pinned here: the next person to simplify that code gets a failure instead of
// a subtle leak.
//
// The comments on those helpers used to give a different reason — bypassing
// Proxy `set` traps on map refs. That reason was not real (map refs are plain
// carriers, and the package's only Proxy never reaches them), and it is the
// kind of mistake a test makes harder to repeat.

import { CHANGEFEED } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import { batch, createDoc, Schema } from "../basic/index.js"
import { PATH, TRANSACT } from "../interpreters/writable.js"

const Doc = Schema.struct({
  title: Schema.string(),
  items: Schema.list(Schema.struct({ label: Schema.string() })),
  entries: Schema.record(Schema.number()),
})

const frameworkSlots = [
  ["TRANSACT", TRANSACT],
  ["PATH", PATH],
  ["CHANGEFEED", CHANGEFEED],
] as const

describe("framework symbol slots are non-enumerable", () => {
  it("does not leak them into an object spread", () => {
    const doc: any = createDoc(Doc)
    const copy = { ...doc }

    for (const [name, slot] of frameworkSlots) {
      expect(
        Object.getOwnPropertySymbols(copy).includes(slot as symbol),
        `${name} leaked into a spread copy`,
      ).toBe(false)
    }
  })

  it("carries the correct descriptor on every kind of ref", () => {
    const doc: any = createDoc(Doc)
    batch(doc, (d: any) => {
      d.items.push({ label: "a" })
      d.entries.set("k", 1)
    })

    const refs: ReadonlyArray<readonly [string, unknown]> = [
      ["root", doc],
      ["scalar field", doc.title],
      ["list", doc.items],
      ["list item", doc.items.at(0)],
      ["record", doc.entries],
      ["record entry", doc.entries.at("k")],
    ]

    for (const [where, ref] of refs) {
      for (const [name, slot] of frameworkSlots) {
        const descriptor = Object.getOwnPropertyDescriptor(
          ref as object,
          slot as symbol,
        )
        if (!descriptor) continue // not every slot is on every ref kind
        expect(descriptor.enumerable, `${name} on ${where}`).toBe(false)
      }
    }
  })

  it("keeps the slots reachable — non-enumerable is not hidden", () => {
    // The other half of the contract: making them non-enumerable must not
    // make them unreadable, or every consumer that looks one up breaks.
    const doc: any = createDoc(Doc)
    expect(doc[TRANSACT]).toBeDefined()
    expect(doc[PATH]).toBeDefined()
    expect(doc[CHANGEFEED]).toBeDefined()
    expect(TRANSACT in doc).toBe(true)
  })
})
