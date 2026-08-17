// begin-hydration.test.ts — the default path for backends that need no
// identity deferral.
//
// Most substrates have nothing to adopt: plain and ephemeral carry no identity
// at all. `beginHydration` is what lets them say nothing and still be handled,
// so this pins that graceful absence — the entire reason the factory method is
// optional rather than required.

import { describe, expect, it } from "vitest"
import { Schema } from "../index.js"
import { beginHydration } from "../substrate.js"
import { plainSubstrateFactory } from "../substrates/plain.js"

const schema = Schema.struct({ title: Schema.string() })

describe("beginHydration", () => {
  it("yields a usable substrate for a factory that declares no deferral", () => {
    expect(plainSubstrateFactory.createForHydration).toBeUndefined()

    const { substrate, adopt } = beginHydration(plainSubstrateFactory, schema)

    expect(substrate).toBeDefined()
    // Calling `adopt` must be safe rather than merely tolerated: the Runtime
    // invokes it unconditionally once hydration resolves, without asking which
    // backend it is talking to.
    expect(() => {
      adopt()
      adopt()
    }).not.toThrow()
  })
})
