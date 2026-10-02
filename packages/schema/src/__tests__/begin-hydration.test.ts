// begin-hydration.test.ts — the substrate a caller gets while it imports a
// document's own history, and what `adopt` grants once the import is done.
//
// `beginHydration` falls back to `create()` plus a no-op `adopt` for a factory
// that declares no `createForHydration`. That graceful absence is the reason
// the factory method is optional, so it is pinned here on the ephemeral
// factory, which needs nothing. Plain declares it: a plain document refuses
// authored writes until its history has loaded. Who else refuses them is the
// owner's decision, which `createRef` attaches to the context.

import { CHANGEFEED, settableFeed } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import {
  batch,
  createRef,
  DocumentLoadingError,
  Schema,
  TRANSACT,
  unwrap,
  WriteRefusal,
} from "../index.js"
import { beginHydration, createSubstrate } from "../substrate.js"
import { ephemeralSubstrateFactory } from "../substrates/ephemeral.js"
import { plainSubstrateFactory } from "../substrates/plain.js"

const schema = Schema.struct({ title: Schema.string() })

describe("beginHydration", () => {
  it("yields a usable substrate for a factory that declares no deferral", () => {
    expect(ephemeralSubstrateFactory.createForHydration).toBeUndefined()

    const { substrate, adopt } = beginHydration(
      ephemeralSubstrateFactory,
      schema,
    )

    expect(substrate).toBeDefined()
    // Calling `adopt` must be safe rather than merely tolerated: the Runtime
    // invokes it unconditionally once hydration resolves, without asking which
    // backend it is talking to.
    expect(() => {
      adopt()
      adopt()
    }).not.toThrow()
  })

  it("plain refuses authored writes until adopt, and accepts them after", () => {
    const { substrate, adopt } = beginHydration(plainSubstrateFactory, schema)
    const doc = createRef(schema, substrate)

    expect(() => batch(doc, d => d.title.set("early"))).toThrow(
      DocumentLoadingError,
    )
    expect(doc.title()).toBe("")

    adopt()
    batch(doc, d => d.title.set("after"))
    expect(doc.title()).toBe("after")
  })
})

describe("the owner's refusal", () => {
  class Refused extends WriteRefusal {}
  const refused = new Refused("another seat writes this document")

  it("authored writes throw the owner's refusal, which createRef attaches", () => {
    const { substrate, adopt } = beginHydration(plainSubstrateFactory, schema)
    const owner = settableFeed<WriteRefusal | undefined>(undefined)
    const doc = createRef(schema, substrate, { refusal: owner })
    adopt()
    batch(doc, d => d.title.set("mine"))
    owner.set(refused)
    expect(() => batch(doc, d => d.title.set("again"))).toThrow(refused)
    expect(doc.title()).toBe("mine")
    expect(doc[TRANSACT].refusal()).toBe(refused)
  })

  it("the substrate answers first: a loading document refuses with DocumentLoadingError", () => {
    const { substrate, adopt } = beginHydration(plainSubstrateFactory, schema)
    const doc = createRef(schema, substrate, {
      refusal: settableFeed<WriteRefusal | undefined>(refused),
    })
    expect(() => batch(doc, d => d.title.set("early"))).toThrow(
      DocumentLoadingError,
    )
    let heard = 0
    doc[TRANSACT].refusal[CHANGEFEED].subscribe(() => heard++)
    adopt()
    expect(heard).toBe(1)
    expect(() => batch(doc, d => d.title.set("after"))).toThrow(refused)
  })

  it("[NATIVE] throws the context's refusal, whoever refuses", () => {
    const { substrate, adopt } = beginHydration(plainSubstrateFactory, schema)
    const owner = settableFeed<WriteRefusal | undefined>(undefined)
    const doc = createRef(schema, substrate, { refusal: owner })
    expect(() => unwrap(doc)).toThrow(DocumentLoadingError)
    adopt()
    expect(unwrap(doc)).toEqual({ title: "" })
    owner.set(refused)
    expect(() => unwrap(doc)).toThrow(refused)
    expect(() => unwrap(doc.title)).toThrow(refused)
    owner.set(undefined)
    expect(unwrap(doc)).toEqual({ title: "" })
  })

  it("merges and resets still reach a refused document", () => {
    const source = createSubstrate(plainSubstrateFactory, schema)
    const writer = createRef(schema, source)
    batch(writer, d => d.title.set("one"))
    const afterOne = source.version()

    const { substrate, adopt } = beginHydration(plainSubstrateFactory, schema)
    const doc = createRef(schema, substrate, {
      refusal: settableFeed<WriteRefusal | undefined>(refused),
    })
    adopt()
    substrate.merge(source.exportEntirety())
    expect(doc.title()).toBe("one")

    batch(writer, d => d.title.set("two"))
    const delta = source.exportSince(afterOne)
    if (delta === null) throw new Error("expected a delta")
    substrate.merge(delta)
    expect(doc.title()).toBe("two")

    batch(writer, d => d.title.set("three"))
    substrate.resetFromEntirety(source.exportEntirety())
    expect(doc.title()).toBe("three")
  })
})
