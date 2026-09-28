// begin-hydration.test.ts — the substrate a caller gets while it imports a
// document's own history, and what `adopt` grants once the import is done.
//
// `beginHydration` falls back to `create()` plus a no-op `adopt` for a factory
// that declares no `createForHydration`. That graceful absence is the reason
// the factory method is optional, so it is pinned here on the ephemeral
// factory, which needs nothing. Plain declares it: a plain document refuses
// authored writes until its history has loaded, and from `refuse` on.

import { describe, expect, it } from "vitest"
import { batch, createRef, Schema } from "../index.js"
import { beginHydration, beginUpgrade } from "../substrate.js"
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

    expect(() => batch(doc, d => d.title.set("early"))).toThrow("still loading")
    expect(doc.title()).toBe("")

    adopt()
    batch(doc, d => d.title.set("after"))
    expect(doc.title()).toBe("after")
  })
})

describe("refuse", () => {
  const REASON = "another seat writes this document"

  it("plain: after adopt, authored writes throw the reason", () => {
    const { substrate, adopt, refuse } = beginHydration(
      plainSubstrateFactory,
      schema,
    )
    const doc = createRef(schema, substrate)
    adopt()
    batch(doc, d => d.title.set("mine"))
    refuse(REASON)
    expect(() => batch(doc, d => d.title.set("again"))).toThrow(REASON)
    expect(doc.title()).toBe("mine")
  })

  it("plain: before adopt, the reason wins over still loading, and adopt does not lift it", () => {
    const { substrate, adopt, refuse } = beginHydration(
      plainSubstrateFactory,
      schema,
    )
    const doc = createRef(schema, substrate)
    refuse(REASON)
    expect(() => batch(doc, d => d.title.set("early"))).toThrow(REASON)
    adopt()
    expect(() => batch(doc, d => d.title.set("after"))).toThrow(REASON)
  })

  it("plain: merges and resets still reach a refused document", () => {
    const source = plainSubstrateFactory.create(schema)
    const writer = createRef(schema, source)
    batch(writer, d => d.title.set("one"))
    const afterOne = source.version()

    const { substrate, adopt, refuse } = beginHydration(
      plainSubstrateFactory,
      schema,
    )
    const doc = createRef(schema, substrate)
    adopt()
    refuse(REASON)
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

  it("beginUpgrade gives plain a refusable substrate over a loaded replica", () => {
    const replica = plainSubstrateFactory.createReplica()
    const source = plainSubstrateFactory.create(schema)
    batch(createRef(schema, source), d => d.title.set("relayed"))
    replica.merge(source.exportEntirety())

    const { substrate, adopt, refuse } = beginUpgrade(
      plainSubstrateFactory,
      replica,
      schema,
    )
    const doc = createRef(schema, substrate)
    expect(doc.title()).toBe("relayed")
    // Already loaded: it may author before adopt.
    batch(doc, d => d.title.set("promoted"))
    adopt()
    refuse(REASON)
    expect(() => batch(doc, d => d.title.set("again"))).toThrow(REASON)
  })

  it("a factory with neither hook cannot refuse", () => {
    const hydrating = beginHydration(ephemeralSubstrateFactory, schema)
    expect(() => hydrating.refuse(REASON)).toThrow("cannot refuse")
    const upgrading = beginUpgrade(
      ephemeralSubstrateFactory,
      ephemeralSubstrateFactory.createReplica(),
      schema,
    )
    expect(() => upgrading.refuse(REASON)).toThrow("cannot refuse")
  })
})
