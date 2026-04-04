// peer — leaderless unix socket topology negotiation.
//
// Thin imperative shell around the pure peer program (peer-program.ts).
// The program produces data effects; this module interprets them as I/O.
//
// FC/IS design:
// - peer-program.ts: pure Mealy machine (functional core)
// - peer.ts: effect executor (imperative shell)

import type { Exchange } from "@kyneta/exchange"
import type { Dispatch } from "@kyneta/machine"
import { createObservableProgram } from "@kyneta/machine"
import {
  type UnixSocketClientOptions,
  UnixSocketClientTransport,
} from "./client-transport.js"
import { connect } from "./connect.js"
import {
  createPeerProgram,
  type PeerEffect,
  type PeerMsg,
  type ProbeResult,
} from "./peer-program.js"
import { UnixSocketServerTransport } from "./server-transport.js"

// Re-export types from peer-program (canonical source)
export type { ProbeResult } from "./peer-program.js"

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
  readonly role: "listener" | "connector" | "negotiating" | "disposed"
  /** Dispose the peer — remove transport and clean up. */
  dispose(): Promise<void>
}

// ---------------------------------------------------------------------------
// Effect executor — interprets PeerEffect data as I/O
// ---------------------------------------------------------------------------

function createEffectExecutor(exchange: Exchange) {
  // Mutable state for transition subscriptions — the executor owns this
  // because it's an I/O concern, not a model concern.
  let unsubscribeTransitions: (() => void) | undefined

  return function executePeerEffect(
    effect: PeerEffect,
    dispatch: Dispatch<PeerMsg>,
  ): void {
    switch (effect.type) {
      case "probe": {
        void probe(effect.path).then(result => {
          dispatch({ type: "probe-result", result })
        })
        break
      }

      case "start-listener": {
        void (async () => {
          try {
            const transport = new UnixSocketServerTransport({
              path: effect.path,
              cleanup: true,
            })
            await exchange.addTransport(transport)
            dispatch({
              type: "transport-added",
              transportId: transport.transportId,
              role: "listener",
            })
          } catch {
            dispatch({ type: "listen-failed" })
          }
        })()
        break
      }

      case "start-connector": {
        void (async () => {
          const transport = new UnixSocketClientTransport({
            path: effect.path,
            reconnect: {
              ...effect.reconnect,
              // Use a finite maxAttempts so that when the listener dies,
              // the client eventually reaches "disconnected" and triggers
              // re-negotiation rather than retrying forever.
              maxAttempts: effect.reconnect?.maxAttempts ?? 5,
            },
          })

          // Watch for death — when max retries exhausted, re-negotiate
          if (unsubscribeTransitions) {
            unsubscribeTransitions()
          }
          unsubscribeTransitions = transport.subscribeToTransitions(
            transition => {
              if (transition.to.status === "disconnected") {
                // Client gave up reconnecting — re-negotiate
                dispatch({ type: "transport-disconnected" })
              }
            },
          )

          await exchange.addTransport(transport)
          dispatch({
            type: "transport-added",
            transportId: transport.transportId,
            role: "connector",
          })
        })()
        break
      }

      case "remove-transport": {
        if (unsubscribeTransitions) {
          unsubscribeTransitions()
          unsubscribeTransitions = undefined
        }
        void (async () => {
          try {
            await exchange.removeTransport(effect.transportId)
          } catch {
            // Ignore — transport may already be removed
          }
        })()
        break
      }

      case "delay-then-probe": {
        setTimeout(() => {
          void probe(effect.path).then(result => {
            dispatch({ type: "probe-result", result })
          })
        }, effect.ms)
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
 *
 * Internally, the peer is a `Program<PeerMsg, Model, PeerEffect>` —
 * a pure Mealy machine whose transitions are deterministically testable.
 * This function is the imperative shell that interprets data effects as I/O.
 */
export function createUnixSocketPeer(
  exchange: Exchange,
  options: UnixSocketPeerOptions,
): UnixSocketPeer {
  const program = createPeerProgram(options)
  const execute = createEffectExecutor(exchange)
  const handle = createObservableProgram(program, execute)

  // Dispose returns a promise for backward compatibility — the program's
  // dispose transition may produce remove-transport effects that are async.
  let disposePromise: Promise<void> | undefined

  return {
    get role() {
      return handle.getState().role
    },
    dispose() {
      if (disposePromise) return disposePromise
      handle.dispatch({ type: "dispose" })
      handle.dispose()
      // Give async effects (remove-transport) a moment to settle
      disposePromise = new Promise(resolve => setTimeout(resolve, 0))
      return disposePromise
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
