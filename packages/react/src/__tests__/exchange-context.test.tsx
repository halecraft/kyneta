// exchange-context.test.tsx — Tier 2 React integration tests.
//
// Proves ExchangeProvider supplies Exchange via context, throws on
// missing provider, and warns on inline instantiation.

import { Exchange } from "@kyneta/exchange"
import { act, renderHook } from "@testing-library/react"
import { type ReactNode, useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { ExchangeProvider, useExchange } from "../exchange-context.js"

// ---------------------------------------------------------------------------
// useExchange
// ---------------------------------------------------------------------------

describe("useExchange", () => {
  it("returns the Exchange from the provider", () => {
    const exchange = new Exchange({ principal: "test" })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ExchangeProvider exchange={exchange}>{children}</ExchangeProvider>
    )

    const { result } = renderHook(() => useExchange(), { wrapper })
    expect(result.current).toBe(exchange)
  })

  it("throws when called outside a provider", () => {
    // Suppress React error boundary console noise
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})

    expect(() => {
      renderHook(() => useExchange())
    }).toThrow("useExchange() must be used within an <ExchangeProvider>")

    spy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// ExchangeProvider lifecycle
// ---------------------------------------------------------------------------

/** A provider whose exchange the test swaps, returning the swap. */
function swappable(initial: Exchange): {
  wrapper: (props: { children: ReactNode }) => ReactNode
  swap: (next: Exchange) => void
} {
  const handle: { set?: (next: Exchange) => void } = {}
  function Wrapper({ children }: { children: ReactNode }) {
    const [ex, setEx] = useState(initial)
    handle.set = setEx
    return <ExchangeProvider exchange={ex}>{children}</ExchangeProvider>
  }
  return {
    wrapper: Wrapper,
    swap: next => {
      act(() => handle.set?.(next))
    },
  }
}

describe("ExchangeProvider", () => {
  it("warns if the exchange identity changes but the principal stays the same", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const exchangeA = new Exchange({ principal: "test" })
    const exchangeB = new Exchange({ principal: "test" })
    const { wrapper, swap } = swappable(exchangeA)
    renderHook(() => useExchange(), { wrapper })
    expect(warnSpy).not.toHaveBeenCalled()

    swap(exchangeB)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
      "The `exchange` prop passed to <ExchangeProvider> changed identity",
    )

    warnSpy.mockRestore()
  })

  it("does not warn if the exchange identity changes and the principal changes", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    const exchangeA = new Exchange({ principal: "test1" })
    const exchangeB = new Exchange({ principal: "test2" })
    const { wrapper, swap } = swappable(exchangeA)
    renderHook(() => useExchange(), { wrapper })

    swap(exchangeB)

    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})
