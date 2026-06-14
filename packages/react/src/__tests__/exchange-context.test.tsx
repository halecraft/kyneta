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
    const exchange = new Exchange({ id: "test" })
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

describe("ExchangeProvider", () => {
  it("warns if the exchange identity changes but peerId remains the same", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const exchangeA = new Exchange({ id: "test" })
    const exchangeB = new Exchange({ id: "test" })

    // Use a stateful wrapper so we can update the exchange prop on rerender
    function StatefulWrapper({ children }: { children: ReactNode }) {
      const [ex, setEx] = useState(exchangeA)
      // Expose setter for the test
      ;(StatefulWrapper as any).setExchange = setEx
      return <ExchangeProvider exchange={ex}>{children}</ExchangeProvider>
    }

    renderHook(() => useExchange(), {
      wrapper: StatefulWrapper,
    })

    expect(errorSpy).not.toHaveBeenCalled()

    // Trigger a rerender with a new exchange for the same peerId
    act(() => {
      ;(StatefulWrapper as any).setExchange(exchangeB)
    })

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toContain(
      "CRITICAL: The `exchange` prop passed to <ExchangeProvider> changed identity",
    )

    errorSpy.mockRestore()
  })

  it("does not warn if the exchange identity changes and peerId changes", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const exchangeA = new Exchange({ id: "test1" })
    const exchangeB = new Exchange({ id: "test2" })

    function StatefulWrapper({ children }: { children: ReactNode }) {
      const [ex, setEx] = useState(exchangeA)
      ;(StatefulWrapper as any).setExchange = setEx
      return <ExchangeProvider exchange={ex}>{children}</ExchangeProvider>
    }

    renderHook(() => useExchange(), {
      wrapper: StatefulWrapper,
    })

    expect(errorSpy).not.toHaveBeenCalled()

    // Trigger a rerender with a new exchange for a DIFFERENT peerId
    act(() => {
      ;(StatefulWrapper as any).setExchange(exchangeB)
    })

    expect(errorSpy).not.toHaveBeenCalled()

    errorSpy.mockRestore()
  })
})
