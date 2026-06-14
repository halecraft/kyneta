// exchange-context — React context provider for @kyneta/exchange.
//
// ExchangeProvider provides an Exchange instance via React context.
//
// useExchange() retrieves the Exchange from context, throwing if
// called outside a provider.

import type { Exchange } from "@kyneta/exchange"
import { createContext, type ReactNode, useContext, useRef } from "react"

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
  /** The Exchange instance to provide to the React subtree. */
  exchange: Exchange
  children: ReactNode
}

/**
 * Provides an {@link Exchange} instance to the React subtree.
 *
 * The Exchange manages persistent network connections and should be
 * created outside of the React component tree (e.g., at module scope)
 * to ensure it survives React lifecycle events like StrictMode remounts.
 *
 * ```tsx
 * import { Exchange } from "@kyneta/exchange"
 * import { createWebsocketClient } from "@kyneta/websocket-transport/browser"
 *
 * // Create exactly once at module scope
 * const exchange = new Exchange({
 *   id: "my-peer",
 *   transports: [createWebsocketClient({ url: "ws://localhost:3000/ws", WebSocket })],
 * })
 *
 * function Root() {
 *   return (
 *     <ExchangeProvider exchange={exchange}>
 *       <App />
 *     </ExchangeProvider>
 *   )
 * }
 * ```
 */
export function ExchangeProvider({
  exchange,
  children,
}: ExchangeProviderProps) {
  const prev = useRef(exchange)

  if (prev.current !== exchange) {
    if (prev.current.peerId === exchange.peerId) {
      console.error(
        "🔴 [@kyneta/react] CRITICAL: The `exchange` prop passed to <ExchangeProvider> changed identity, " +
          "but the `peerId` is the same. An Exchange cannot be safely recreated for the same peer " +
          "during a session without corrupting distributed state or leaking connections.\n\n" +
          "Fix: Create the Exchange exactly once at module scope, or use `useExchangeSingleton`.",
      )
    }
    prev.current = exchange
  }

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
        "Wrap your component tree with <ExchangeProvider exchange={...}>.",
    )
  }
  return exchange
}
