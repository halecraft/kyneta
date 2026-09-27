// begin-hydration.test.ts — the substrate a caller gets while it imports a
// document's own history, and what `adopt` grants once the import is done.
//
// `beginHydration` falls back to `create()` plus a no-op `adopt` for a factory
// that declares no `createForHydration`. That graceful absence is the reason
// the factory method is optional, so it is pinned here on the ephemeral
// factory, which needs nothing. Plain declares it: a plain document refuses
// authored writes until its history has loaded.

import { describe, expect, it } from "vitest"
import { batch, createRef, Schema } from "../index.js"
import { beginHydration } from "../substrate.js"
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
