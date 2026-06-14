import { Exchange } from "@kyneta/exchange"
import { renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useExchangeSingleton } from "../use-exchange-singleton.js"

describe("useExchangeSingleton", () => {
  it("returns null if peerId is null", () => {
    const factory = () => new Exchange({ id: "test" })
    const { result } = renderHook(() => useExchangeSingleton(null, factory))
    expect(result.current).toBeNull()
  })

  it("returns null if peerId is undefined", () => {
    const factory = () => new Exchange({ id: "test" })
    const { result } = renderHook(() =>
      useExchangeSingleton(undefined, factory),
    )
    expect(result.current).toBeNull()
  })

  it("calls the factory exactly once per peerId and returns the same instance on rerender", () => {
    let callCount = 0
    const factory = () => {
      callCount++
      return new Exchange({ id: "test-peer" })
    }

    const { result, rerender } = renderHook(() =>
      useExchangeSingleton("test-peer", factory),
    )

    const firstInstance = result.current
    expect(firstInstance).toBeInstanceOf(Exchange)
    expect(callCount).toBe(1)

    // Rerender with the same peerId
    rerender()

    expect(result.current).toBe(firstInstance)
    expect(callCount).toBe(1) // Factory was not called again
  })

  it("calls the factory again if the peerId changes", () => {
    let callCount = 0
    const factory = (id: string) => {
      callCount++
      return new Exchange({ id })
    }

    const { result, rerender } = renderHook(
      ({ peerId }) => useExchangeSingleton(peerId, () => factory(peerId)),
      { initialProps: { peerId: "peer-1" } },
    )

    const firstInstance = result.current
    expect(firstInstance?.peerId).toBe("peer-1")
    expect(callCount).toBe(1)

    // Rerender with a new peerId
    rerender({ peerId: "peer-2" })

    const secondInstance = result.current
    expect(secondInstance?.peerId).toBe("peer-2")
    expect(secondInstance).not.toBe(firstInstance)
    expect(callCount).toBe(2) // Factory was called again for the new peerId
  })
})
