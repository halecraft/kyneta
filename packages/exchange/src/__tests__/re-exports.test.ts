// re-exports — verify @kyneta/exchange re-exports are identical to source.
//
// The exchange barrel re-exports symbols from @kyneta/transport and
// @kyneta/bridge-transport for backwards compatibility. This test
// ensures re-exported values are the *same reference* (not copies) —
// critical for instanceof checks.

import * as bridgeTransport from "@kyneta/bridge-transport"
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
  ] as const

  for (const name of transportValues) {
    it(`re-exports ${name} as the same reference`, () => {
      const fromTransport = (transport as Record<string, unknown>)[name]
      const fromExchange = (exchange as Record<string, unknown>)[name]
      expect(fromExchange).toBe(fromTransport)
    })
  }

  // Value exports re-exported from @kyneta/bridge-transport
  const bridgeValues = [
    "Bridge",
    "BridgeTransport",
    "createBridgeTransport",
  ] as const

  for (const name of bridgeValues) {
    it(`re-exports ${name} as the same reference`, () => {
      const fromBridge = (bridgeTransport as Record<string, unknown>)[name]
      const fromExchange = (exchange as Record<string, unknown>)[name]
      expect(fromExchange).toBe(fromBridge)
    })
  }

  it("every value export from @kyneta/transport is available in @kyneta/exchange", () => {
    const transportKeys = Object.keys(transport)
    const exchangeKeys = new Set(Object.keys(exchange))
    const missing = transportKeys.filter(k => !exchangeKeys.has(k))
    expect(missing).toEqual([])
  })
})
