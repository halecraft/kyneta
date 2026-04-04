// peer.test — unit tests for decideRole + integration tests for createUnixSocketPeer.
//
// Unit tests verify the pure decision function mapping probe results → actions.
// Integration tests use real unix sockets to verify leaderless negotiation:
// 1. First peer becomes listener, second becomes connector
// 2. Dispose cleans up socket file and transport
// 3. Dispose during negotiation exits cleanly

import { afterEach, describe, expect, it } from "vitest"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import * as crypto from "node:crypto"

import { Exchange } from "@kyneta/exchange"

import { createUnixSocketPeer, decideRole } from "../peer.js"
import type { UnixSocketPeer } from "../peer.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpSocketPath(): string {
  const id = crypto.randomBytes(8).toString("hex")
  return path.join(os.tmpdir(), `kyneta-peer-test-${id}.sock`)
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5000, intervalMs = 50 } = {},
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

// ---------------------------------------------------------------------------
// Unit tests — decideRole (pure function)
// ---------------------------------------------------------------------------

describe("decideRole", () => {
  it('"connected" → connect', () => {
    expect(decideRole("connected")).toEqual({ action: "connect" })
  })

  it('"enoent" → listen', () => {
    expect(decideRole("enoent")).toEqual({ action: "listen" })
  })

  it('"econnrefused" → listen', () => {
    expect(decideRole("econnrefused")).toEqual({ action: "listen" })
  })

  it('"eaddrinuse" → retry', () => {
    expect(decideRole("eaddrinuse")).toEqual({ action: "retry" })
  })
})

// ---------------------------------------------------------------------------
// Integration tests — createUnixSocketPeer
// ---------------------------------------------------------------------------

describe("createUnixSocketPeer — integration", () => {
  const exchanges: Exchange[] = []
  const peers: UnixSocketPeer[] = []

  afterEach(async () => {
    for (const peer of peers) {
      try {
        await peer.dispose()
      } catch {
        // ignore
      }
    }
    peers.length = 0

    for (const ex of exchanges) {
      try {
        await ex.shutdown()
      } catch {
        // ignore
      }
    }
    exchanges.length = 0
  })

  it("first peer becomes listener, second becomes connector", async () => {
    const socketPath = tmpSocketPath()

    const exchange1 = new Exchange({ identity: { peerId: "peer-1" } })
    exchanges.push(exchange1)
    const peer1 = createUnixSocketPeer(exchange1, { path: socketPath })
    peers.push(peer1)

    // Wait for peer1 to become listener (no existing socket → listen)
    await waitFor(() => peer1.role === "listener")
    expect(peer1.role).toBe("listener")

    const exchange2 = new Exchange({ identity: { peerId: "peer-2" } })
    exchanges.push(exchange2)
    const peer2 = createUnixSocketPeer(exchange2, { path: socketPath })
    peers.push(peer2)

    // Wait for peer2 to become connector (probes existing listener → connect)
    await waitFor(() => peer2.role === "connector")
    expect(peer2.role).toBe("connector")

    // Both should discover each other via Exchange peer awareness
    await waitFor(() => exchange1.peers().size > 0)
    await waitFor(() => exchange2.peers().size > 0)

    expect(exchange1.peers().size).toBe(1)
    expect(exchange2.peers().size).toBe(1)
  })

  it("dispose removes transport and cleans up socket file", async () => {
    const socketPath = tmpSocketPath()

    const exchange = new Exchange({ identity: { peerId: "peer-1" } })
    exchanges.push(exchange)
    const peer = createUnixSocketPeer(exchange, { path: socketPath })
    // Don't push to peers — we dispose manually

    await waitFor(() => peer.role === "listener")
    expect(fs.existsSync(socketPath)).toBe(true)

    await peer.dispose()

    // Socket file should be cleaned up after dispose
    // The server transport with cleanup: true unlinks on stop.
    // Allow a moment for async cleanup to settle.
    await new Promise(r => setTimeout(r, 200))
    expect(fs.existsSync(socketPath)).toBe(false)
  })

  it("connector re-negotiates to listener after listener dies", async () => {
    const socketPath = tmpSocketPath()

    // Start peer1 as listener
    const exchange1 = new Exchange({ identity: { peerId: "peer-1" } })
    exchanges.push(exchange1)
    const peer1 = createUnixSocketPeer(exchange1, { path: socketPath })
    peers.push(peer1)

    await waitFor(() => peer1.role === "listener")

    // Start peer2 as connector, with fast reconnect so healing is quick
    const exchange2 = new Exchange({ identity: { peerId: "peer-2" } })
    exchanges.push(exchange2)
    const peer2 = createUnixSocketPeer(exchange2, {
      path: socketPath,
      reconnect: { maxAttempts: 3, baseDelay: 50, maxDelay: 100 },
    })
    peers.push(peer2)

    await waitFor(() => peer2.role === "connector")
    await waitFor(() => exchange1.peers().size > 0)

    // Kill the listener — peer2 should re-negotiate and become listener
    await peer1.dispose()

    // peer2 transitions: connector → (reconnect fails) → negotiating → listener
    await waitFor(() => peer2.role === "listener", { timeoutMs: 10000 })
    expect(peer2.role).toBe("listener")

    // Verify the new listener is functional — a third peer can connect
    const exchange3 = new Exchange({ identity: { peerId: "peer-3" } })
    exchanges.push(exchange3)
    const peer3 = createUnixSocketPeer(exchange3, { path: socketPath })
    peers.push(peer3)

    await waitFor(() => peer3.role === "connector")
    await waitFor(() => exchange2.peers().size > 0)
    await waitFor(() => exchange3.peers().size > 0)

    expect(exchange2.peers().size).toBeGreaterThanOrEqual(1)
    expect(exchange3.peers().size).toBe(1)
  })

  it("dispose during negotiation exits cleanly", async () => {
    const socketPath = tmpSocketPath()

    const exchange = new Exchange({ identity: { peerId: "peer-1" } })
    exchanges.push(exchange)
    const peer = createUnixSocketPeer(exchange, { path: socketPath })

    // Dispose immediately — before negotiation completes
    await peer.dispose()

    // Should exit cleanly without error.
    // Socket file should not exist (either never created, or cleaned up).
    await new Promise(r => setTimeout(r, 200))
    expect(fs.existsSync(socketPath)).toBe(false)
  })
})