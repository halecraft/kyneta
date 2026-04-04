// peer — leaderless unix socket topology negotiation.
//
// `createUnixSocketPeer` encapsulates the connect-or-listen-then-heal
// pattern. The first peer to start becomes the listener; subsequent
// peers become connectors. If the listener dies, a connector takes
// over. The Exchange's addTransport/removeTransport API enables
// transport swaps without destroying documents or CRDT state.
//
// FC/IS design:
// - decideRole(probeResult) is a pure decision function
// - The imperative shell probes, decides, and executes

import type { Exchange } from "@kyneta/exchange"
import { connect } from "./connect.js"
import {
  UnixSocketClientTransport,
  type UnixSocketClientOptions,
} from "./client-transport.js"
import { UnixSocketServerTransport } from "./server-transport.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnixSocketPeerOptions {
  /** Path to the unix socket file. */
  path: string
  /** Reconnection options for client transport. */
  reconnect?: UnixSocketClientOptions["reconnect"]
}

export interface UnixSocketPeer {
  /** Current role — changes over time as healing occurs. */
  readonly role: "listener" | "connector" | "negotiating"
  /** Dispose the peer — remove transport and clean up. */
  dispose(): Promise<void>
}

// ---------------------------------------------------------------------------
// Pure decision function
// ---------------------------------------------------------------------------

export type ProbeResult = "connected" | "enoent" | "econnrefused" | "eaddrinuse"

export type NegotiationDecision =
  | { action: "connect" }
  | { action: "listen" }
  | { action: "retry" }

/**
 * Pure decision: given the result of probing the socket path,
 * decide whether to connect, listen, or retry.
 */
export function decideRole(probe: ProbeResult): NegotiationDecision {
  switch (probe) {
    case "connected":
      return { action: "connect" }
    case "enoent":
    case "econnrefused":
      return { action: "listen" }
    case "eaddrinuse":
      return { action: "retry" }
  }
}

// ---------------------------------------------------------------------------
// Imperative shell
// ---------------------------------------------------------------------------

const RETRY_DELAY_MS = 200

/**
 * Create a unix socket peer that manages leaderless topology negotiation.
 *
 * The first peer to start becomes the listener; subsequent peers become
 * connectors. If the listener dies, a connector re-negotiates and becomes
 * the new listener.
 *
 * Uses `exchange.addTransport()` / `exchange.removeTransport()` to swap
 * transports at runtime — the Exchange, all documents, and all CRDT state
 * survive across transport swaps.
 */
export function createUnixSocketPeer(
  exchange: Exchange,
  options: UnixSocketPeerOptions,
): UnixSocketPeer {
  let role: "listener" | "connector" | "negotiating" = "negotiating"
  let disposed = false
  let currentTransportId: string | undefined
  let unsubscribeTransitions: (() => void) | undefined

  // Start negotiation immediately
  void negotiate()

  async function negotiate(): Promise<void> {
    // Clean up previous transport if any
    if (currentTransportId) {
      if (unsubscribeTransitions) {
        unsubscribeTransitions()
        unsubscribeTransitions = undefined
      }
      try {
        await exchange.removeTransport(currentTransportId)
      } catch {
        // Ignore — transport may already be removed
      }
      currentTransportId = undefined
    }

    role = "negotiating"

    while (!disposed) {
      const probeResult = await probe(options.path)
      if (disposed) return

      const decision = decideRole(probeResult)

      switch (decision.action) {
        case "connect": {
          const transport = new UnixSocketClientTransport({
            path: options.path,
            reconnect: {
              ...options.reconnect,
              // Use a finite maxAttempts so that when the listener dies,
              // the client eventually reaches "disconnected" and triggers
              // re-negotiation rather than retrying forever.
              maxAttempts: options.reconnect?.maxAttempts ?? 5,
            },
          })
          currentTransportId = transport.transportId
          role = "connector"

          // Watch for death — when max retries exhausted, re-negotiate
          unsubscribeTransitions = transport.subscribeToTransitions(
            (transition) => {
              if (transition.to.status === "disconnected" && !disposed) {
                // Client gave up reconnecting — re-negotiate
                void negotiate()
              }
            },
          )

          await exchange.addTransport(transport)
          return
        }

        case "listen": {
          try {
            const transport = new UnixSocketServerTransport({
              path: options.path,
              cleanup: true,
            })
            currentTransportId = transport.transportId
            role = "listener"
            await exchange.addTransport(transport)
            return
          } catch {
            // Listen failed (e.g. EADDRINUSE race) — retry
            if (disposed) return
            await delay(RETRY_DELAY_MS)
            continue
          }
        }

        case "retry": {
          await delay(RETRY_DELAY_MS)
          continue
        }
      }
    }
  }

  return {
    get role() {
      return role
    },
    async dispose() {
      disposed = true
      if (unsubscribeTransitions) {
        unsubscribeTransitions()
        unsubscribeTransitions = undefined
      }
      if (currentTransportId) {
        try {
          await exchange.removeTransport(currentTransportId)
        } catch {
          // Ignore — transport may already be removed
        }
        currentTransportId = undefined
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function probe(path: string): Promise<ProbeResult> {
  try {
    const socket = await connect(path)
    // Successfully connected — close the probe socket immediately.
    // UnixSocket exposes `end()` for graceful stream termination.
    socket.end()
    return "connected"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    switch (code) {
      case "ENOENT":
        return "enoent"
      case "ECONNREFUSED":
        return "econnrefused"
      case "EADDRINUSE":
        return "eaddrinuse"
      default:
        // Unknown error — treat as "no server" → try to listen
        return "enoent"
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}