import { Exchange } from "@kyneta/exchange"
import { renderHook, waitFor } from "@testing-library/react"
import { StrictMode } from "react"
import { describe, expect, it } from "vitest"
import { useExchangeSingleton } from "../use-exchange-singleton.js"

describe("useExchangeSingleton", () => {
  it("returns null if principal is null", () => {
    const factory = () => new Exchange({ principal: "test" })
    const { result } = renderHook(() => useExchangeSingleton(null, factory))
    expect(result.current).toBeNull()
  })

  it("returns null if principal is undefined", () => {
    const factory = () => new Exchange({ principal: "test" })
    const { result } = renderHook(() =>
      useExchangeSingleton(undefined, factory),
    )
    expect(result.current).toBeNull()
  })

  it("runs an async factory once per principal under StrictMode", async () => {
    let callCount = 0
    const factory = async () => {
      callCount++
      await Promise.resolve()
      return new Exchange({ principal: "strict-user" })
    }

    const { result, rerender } = renderHook(
      () => useExchangeSingleton("strict-user", factory),
      { wrapper: StrictMode },
    )
    expect(result.current).toBeNull()

    await waitFor(() => expect(result.current).toBeInstanceOf(Exchange))
    const first = result.current
    expect(first?.principal).toBe("strict-user")
    expect(callCount).toBe(1)

    rerender()
    expect(result.current).toBe(first)
    expect(callCount).toBe(1)
  })

  it("a later mount for the same principal gets the built Exchange at once", async () => {
    let callCount = 0
    const factory = () => {
      callCount++
      return new Exchange({ principal: "remount-user" })
    }

    const first = renderHook(() =>
      useExchangeSingleton("remount-user", factory),
    )
    await waitFor(() => expect(first.result.current).toBeInstanceOf(Exchange))
    first.unmount()

    const second = renderHook(() =>
      useExchangeSingleton("remount-user", factory),
    )
    expect(second.result.current).toBe(first.result.current)
    expect(callCount).toBe(1)
  })

  it("different principals get different Exchanges", async () => {
    let callCount = 0
    const factory = async (principal: string) => {
      callCount++
      return new Exchange({ principal })
    }

    const { result, rerender } = renderHook(
      ({ principal }) =>
        useExchangeSingleton(principal, () => factory(principal)),
      { initialProps: { principal: "principal-1" } },
    )

    await waitFor(() => expect(result.current?.principal).toBe("principal-1"))
    const first = result.current

    rerender({ principal: "principal-2" })
    expect(result.current).toBeNull()

    await waitFor(() => expect(result.current?.principal).toBe("principal-2"))
    expect(result.current).not.toBe(first)
    expect(result.current?.peerId).not.toBe(first?.peerId)
    expect(callCount).toBe(2)
  })
})
