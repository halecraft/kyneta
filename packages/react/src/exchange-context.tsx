// exchange-context — React context provider for @kyneta/exchange.
//
// ExchangeProvider creates an Exchange from config and provides it via
// React context. Cleanup calls exchange.reset() on unmount.
//
// useExchange() retrieves the Exchange from context, throwing if
// called outside a provider.

import { Exchange, type ExchangeParams } from "@kyneta/exchange"
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
} from "react"

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ExchangeContext = createContext<Exchange | null>(null)

// ---------------------------------------------------------------------------
// ExchangeProvider
// ---------------------------------------------------------------------------

/**
 * Props for {@link ExchangeProvider}.
 */
export interface ExchangeProviderProps {
  /** Exchange configuration — identity, adapters, permissions. */
  config: ExchangeParams
  children: ReactNode
}

/**
 * Provides an {@link Exchange} instance to the React subtree.
 *
 * Creates the Exchange lazily from `config` and tears it down via
 * `exchange.reset()` on unmount. If async shutdown (flushing pending
 * storage writes) is needed, call `exchange.shutdown()` before
 * unmounting.
 *
 * ```tsx
 * import { createWebsocketClient } from "@kyneta/websocket-transport/browser"
 *
 * const config = {
 *   id: "my-peer",
 *   transports: [createWebsocketClient({ url: "ws://localhost:3000/ws", WebSocket })],
 * }
 *
 * <ExchangeProvider config={config}>
 *   <App />
 * </ExchangeProvider>
 * ```
 *
 * Transport factories ensure StrictMode safety: each mount creates a fresh
 * Exchange with fresh transport instances. The config object (containing
 * factory closures) is stable across renders.
 */
export function ExchangeProvider({ config, children }: ExchangeProviderProps) {
  const exchange = useMemo(() => new Exchange(config), [config])

  useEffect(() => {
    return () => {
      exchange.reset()
    }
  }, [exchange])

  return (
    <ExchangeContext.Provider value={exchange}>
      {children}
    </ExchangeContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// useExchange
// ---------------------------------------------------------------------------

/**
 * Retrieve the {@link Exchange} from the nearest {@link ExchangeProvider}.
 *
 * @throws If called outside an ExchangeProvider.
 */
export function useExchange(): Exchange {
  const exchange = useContext(ExchangeContext)
  if (!exchange) {
    throw new Error(
      "useExchange() must be used within an <ExchangeProvider>. " +
        "Wrap your component tree with <ExchangeProvider config={...}>.",
    )
  }
  return exchange
}
