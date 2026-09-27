import type { Exchange } from "@kyneta/exchange"
import { useEffect, useState } from "react"

type CacheEntry = {
  readonly promise: Promise<Exchange>
  exchange?: Exchange
}

// Module scope, so StrictMode's double effects and remounts find the entry the
// first run stored.
const exchangeCache = new Map<string, CacheEntry>()

function entryFor(
  principal: string,
  factory: () => Exchange | Promise<Exchange>,
): CacheEntry {
  const cached = exchangeCache.get(principal)
  if (cached) return cached
  // Stored before the factory's promise is awaited, so a second run in the
  // meantime reuses it. A synchronous throw becomes a rejection.
  const entry: CacheEntry = {
    promise: new Promise<Exchange>(resolve => resolve(factory())).then(
      exchange => {
        entry.exchange = exchange
        return exchange
      },
      (error: unknown) => {
        // Forget the failure, so a later mount calls the factory again.
        exchangeCache.delete(principal)
        throw error
      },
    ),
  }
  exchangeCache.set(principal, entry)
  return entry
}

type Resolved =
  | { readonly principal: string; readonly exchange: Exchange }
  | { readonly principal: string; readonly error: unknown }

/**
 * Creates an Exchange inside a React component tree, once per `principal`.
 *
 * StrictMode runs effects twice and remounts rerun them; the factory still
 * runs once per principal, because its promise is cached at module scope
 * before anything is awaited. The factory may be async, e.g. to open an
 * IndexedDB store first.
 *
 * Use this hook when you must wait for something (an auth token, a store)
 * before creating the Exchange. Otherwise, create the Exchange at module
 * scope.
 *
 * @param principal - Who the Exchange speaks for. If null/undefined, returns null.
 * @param factory - Builds the Exchange. Called once per principal.
 * @returns The Exchange, or `null` until the factory's promise resolves. A
 *   rejection is thrown during render, for an error boundary to catch.
 */
export function useExchangeSingleton(
  principal: string | null | undefined,
  factory: () => Exchange | Promise<Exchange>,
): Exchange | null {
  const [resolved, setResolved] = useState<Resolved | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: factory identity intentionally not tracked; singleton per principal
  useEffect(() => {
    if (!principal) return
    let live = true
    entryFor(principal, factory).promise.then(
      exchange => {
        if (live) setResolved({ principal, exchange })
      },
      (error: unknown) => {
        if (live) setResolved({ principal, error })
      },
    )
    return () => {
      live = false
    }
  }, [principal])

  if (!principal) return null
  if (resolved?.principal === principal) {
    if ("error" in resolved) throw resolved.error
    return resolved.exchange
  }
  // An Exchange an earlier mount already built is ready now.
  return exchangeCache.get(principal)?.exchange ?? null
}
