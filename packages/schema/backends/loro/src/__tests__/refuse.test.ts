// refuse — a concurrent substrate has no single writer to refuse in favour
// of, so its hydration handle's `refuse` throws rather than pretend.

import { beginHydration, Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { loro } from "../bind-loro.js"

describe("loro refuse", () => {
  it("throws: only serialized documents are refused", () => {
    const bound = loro.bind(Schema.struct({ title: Schema.text() }))
    const factory = bound.factory({
      peerId: "alice",
      binding: bound.identityBinding,
    })
    const { refuse } = beginHydration(factory, bound.schema)
    expect(() => refuse("another seat writes it")).toThrow(
      "concurrent substrates have no single writer",
    )
  })
})
