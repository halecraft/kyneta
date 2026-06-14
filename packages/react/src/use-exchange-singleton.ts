import type { Exchange } from "@kyneta/exchange"
import { useEffect, useState } from "react"

// Hidden from the developer, but necessary to survive StrictMode
const exchangeCache = new Map<string, Exchange>()

/**
 * Safely instantiates an Exchange inside a React component tree.
 *
 * This hook guarantees that the Exchange is created exactly once per `peerId`,
 * making it immune to React 18 StrictMode double-invocations.
 *
 * Use this hook when you must wait for an async dependency (like an auth token)
 * before creating the Exchange. For all other cases, prefer creating the Exchange
 * at module scope.
 *
 * @param peerId - The unique identity of the peer. If null/undefined, returns null.
 * @param factory - A function that returns a new Exchange. Only called once per peerId.
 */
export function useExchangeSingleton(
  peerId: string | null | undefined,
  factory: () => Exchange,
): Exchange | null {
  const [exchange, setExchange] = useState<Exchange | null>(() => {
    if (!peerId) return null
    let ex = exchangeCache.get(peerId)
    if (!ex) {
      ex = factory()
      exchangeCache.set(peerId, ex)
    }
    return ex
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: factory identity intentionally not tracked; singleton per peerId
  useEffect(() => {
    if (!peerId) {
      setExchange(null)
      return
    }

    let ex = exchangeCache.get(peerId)
    if (!ex) {
      ex = factory()
      exchangeCache.set(peerId, ex)
    }
    setExchange(ex)
  }, [peerId])

  return exchange
}
