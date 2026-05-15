// re-exports — verify @kyneta/exchange re-exports transport infrastructure
// as the same reference (not copies) — critical for instanceof checks.
//
// The exchange barrel re-exports symbols from @kyneta/transport as a user
// convenience so consumers don't need a second import for common types and
// values (identity types, message vocabulary, channel types, Transport
// base class, reconnection utilities). The "every value export" assertion
// serves as a forward-looking guardrail: if a new value export is added to
// @kyneta/transport, this test catches the gap.

import * as transport from "@kyneta/transport"
import { describe, expect, it } from "vitest"
import * as exchange from "../index.js"

describe("@kyneta/exchange re-exports from @kyneta/transport", () => {
  // Value exports re-exported from @kyneta/transport
  const transportValues = [
    "Transport",
    "ChannelDirectory",
    "computeBackoffDelay",
    "DEFAULT_RECONNECT",
    "isEstablished",
    "isLifecycleMsg",
    "isSyncMsg",
    "randomPeerId",
  ] as const

  for (const name of transportValues) {
    it(`re-exports ${name} as the same reference`, () => {
      const fromTransport = (transport as Record<string, unknown>)[name]
      const fromExchange = (exchange as Record<string, unknown>)[name]
      expect(fromExchange).toBe(fromTransport)
    })
  }

  it("every value export from @kyneta/transport is available in @kyneta/exchange", () => {
    const transportKeys = Object.keys(transport)
    const exchangeKeys = new Set(Object.keys(exchange))
    const missing = transportKeys.filter(k => !exchangeKeys.has(k))
    expect(missing).toEqual([])
  })
})
