// re-exports — verify @kyneta/exchange re-exports are identical to @kyneta/transport.
//
// This refactoring extracted transport infrastructure into @kyneta/transport.
// The exchange barrel re-exports everything for backwards compatibility.
// This test ensures:
//   1. Every value export from @kyneta/transport is re-exported by @kyneta/exchange
//   2. Re-exported values are the *same reference* (not copies) — critical for instanceof

import * as transport from "@kyneta/transport"
import { describe, expect, it } from "vitest"
import * as exchange from "../index.js"

describe("@kyneta/exchange re-exports from @kyneta/transport", () => {
  // Value exports that must be reference-identical
  const sharedValues = [
    "Transport",
    "Bridge",
    "BridgeTransport",
    "createBridgeTransport",
    "ChannelDirectory",
    "computeBackoffDelay",
    "DEFAULT_RECONNECT",
    "isEstablished",
    "isEstablishmentMsg",
    "isExchangeMsg",
  ] as const

  for (const name of sharedValues) {
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
