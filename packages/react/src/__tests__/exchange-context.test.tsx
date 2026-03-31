// exchange-context.test.tsx — Tier 2 React integration tests.
//
// Proves ExchangeProvider supplies Exchange via context, throws on
// missing provider, and calls reset() on unmount.

import { Exchange } from "@kyneta/exchange"
import { renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { ExchangeProvider, useExchange } from "../exchange-context.js"

// ---------------------------------------------------------------------------
// useExchange
// ---------------------------------------------------------------------------

describe("useExchange", () => {
  it("returns the Exchange from the provider", () => {
    const config = {}
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ExchangeProvider config={config}>{children}</ExchangeProvider>
    )

    const { result } = renderHook(() => useExchange(), { wrapper })
    expect(result.current).toBeInstanceOf(Exchange)
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
  it("calls exchange.reset() on unmount", () => {
    const resetSpy = vi.spyOn(Exchange.prototype, "reset")

    const config = {}
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ExchangeProvider config={config}>{children}</ExchangeProvider>
    )

    const { unmount } = renderHook(() => useExchange(), { wrapper })

    expect(resetSpy).not.toHaveBeenCalled()

    unmount()

    expect(resetSpy).toHaveBeenCalledTimes(1)

    resetSpy.mockRestore()
  })
})
