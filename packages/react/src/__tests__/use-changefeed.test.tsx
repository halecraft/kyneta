// use-changefeed.test.tsx — Tier 2 React integration tests.
//
// Proves useChangefeed returns the current value from a Changefeed
// and re-renders when the feed emits.

import { type Changefeed, createChangefeed } from "@kyneta/changefeed"
import { Exchange } from "@kyneta/exchange"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useChangefeed } from "../use-changefeed.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestFeed(): [Changefeed<number, any>, (n: number) => void] {
  let current = 0
  const [feed, emit] = createChangefeed<number, any>(() => current)
  return [
    feed,
    (n: number) => {
      current = n
      emit({ changes: [{ type: "set", key: "value" }] })
    },
  ]
}

// ---------------------------------------------------------------------------
// useChangefeed
// ---------------------------------------------------------------------------

describe("useChangefeed", () => {
  it("returns the initial value", () => {
    const [feed] = createTestFeed()
    const { result } = renderHook(() => useChangefeed(feed))
    expect(result.current).toBe(0)
  })

  it("updates when the feed emits", () => {
    const [feed, set] = createTestFeed()
    const { result } = renderHook(() => useChangefeed(feed))

    expect(result.current).toBe(0)

    act(() => set(42))

    expect(result.current).toBe(42)
  })

  it("works with exchange.peers (ReactiveMap)", () => {
    const exchange = new Exchange({ id: "test" })

    const { result } = renderHook(() => useChangefeed(exchange.peers))

    // exchange.peers is a ReactiveMap implementing [CHANGEFEED]
    const peers = result.current
    expect(peers).toBeInstanceOf(Map)
    expect(peers.size).toBe(0)
  })
})
