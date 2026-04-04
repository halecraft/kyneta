// peer-program — pure Mealy machine for leaderless unix socket topology negotiation.
//
// The peer program encodes every state transition and effect as data.
// The imperative shell (peer.ts) interprets effects as I/O. Tests assert
// on data — no sockets, no timing, never flaky.
//
// Algebra: Program<PeerMsg, PeerModel, PeerEffect>
// Interpreter: peer.ts executePeerEffect()

import type { Program } from "@kyneta/machine"
import type { UnixSocketClientOptions } from "./client-transport.js"

// ---------------------------------------------------------------------------
// Probe result — moved here from peer.ts as the canonical source
// ---------------------------------------------------------------------------

export type ProbeResult = "connected" | "enoent" | "econnrefused" | "eaddrinuse"

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type PeerModel = {
  role: "negotiating" | "listener" | "connector" | "disposed"
  transportId: string | undefined
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type PeerMsg =
  | { type: "probe-result"; result: ProbeResult }
  | {
      type: "transport-added"
      transportId: string
      role: "listener" | "connector"
    }
  | { type: "listen-failed" }
  | { type: "transport-disconnected" }
  | { type: "dispose" }

// ---------------------------------------------------------------------------
// Effects (data — interpreted by the imperative shell)
// ---------------------------------------------------------------------------

export type PeerEffect =
  | { type: "probe"; path: string }
  | { type: "start-listener"; path: string }
  | {
      type: "start-connector"
      path: string
      reconnect?: UnixSocketClientOptions["reconnect"]
    }
  | { type: "remove-transport"; transportId: string }
  | { type: "delay-then-probe"; ms: number; path: string }

// ---------------------------------------------------------------------------
// Program factory
// ---------------------------------------------------------------------------

export interface PeerProgramOptions {
  path: string
  reconnect?: UnixSocketClientOptions["reconnect"]
  retryDelayMs?: number
}

const DEFAULT_RETRY_DELAY_MS = 200

/**
 * Create the peer negotiation program — a pure Mealy machine.
 *
 * The returned `Program<PeerMsg, PeerModel, PeerEffect>` encodes
 * every state transition and effect as inspectable data. The imperative
 * shell interprets `PeerEffect` as actual I/O.
 */
export function createPeerProgram(
  options: PeerProgramOptions,
): Program<PeerMsg, PeerModel, PeerEffect> {
  const { path, reconnect, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = options

  return {
    init: [
      { role: "negotiating", transportId: undefined },
      { type: "probe", path },
    ],

    update(msg, model): [PeerModel, ...PeerEffect[]] {
      // Disposed state absorbs all messages
      if (model.role === "disposed") {
        return [model]
      }

      switch (msg.type) {
        case "probe-result": {
          if (model.role !== "negotiating") return [model]

          switch (msg.result) {
            case "connected":
              return [model, { type: "start-connector", path, reconnect }]
            case "enoent":
            case "econnrefused":
              return [model, { type: "start-listener", path }]
            case "eaddrinuse":
              return [
                model,
                { type: "delay-then-probe", ms: retryDelayMs, path },
              ]
          }
          // Unreachable — inner switch is exhaustive over ProbeResult
          return [model]
        }

        case "transport-added":
          return [{ role: msg.role, transportId: msg.transportId }]

        case "listen-failed":
          return [
            { role: "negotiating", transportId: undefined },
            { type: "delay-then-probe", ms: retryDelayMs, path },
          ]

        case "transport-disconnected": {
          if (model.role === "negotiating") return [model]

          const effects: PeerEffect[] = []
          if (model.transportId) {
            effects.push({
              type: "remove-transport",
              transportId: model.transportId,
            })
          }
          effects.push({ type: "probe", path })

          return [{ role: "negotiating", transportId: undefined }, ...effects]
        }

        case "dispose": {
          const effects: PeerEffect[] = []
          if (model.transportId) {
            effects.push({
              type: "remove-transport",
              transportId: model.transportId,
            })
          }
          return [{ role: "disposed", transportId: undefined }, ...effects]
        }
      }
    },
  }
}
