// peer-role-flip — the leaderless peer's in-place connector→listener heal.
//
// This is the one behavior with no precedent elsewhere: a single
// `UnixSocketPeerTransport` swaps its socket MODE in place when the listener
// dies, keeping its `transportId`, with the Exchange seeing only channel
// add/remove and documents surviving. End-to-end over real unix sockets.

import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Exchange } from "@kyneta/exchange"
import { batch, json, Schema } from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import { createUnixSocketPeer } from "../peer.js"
import { UnixSocketPeerTransport } from "../peer-transport.js"
import { probe } from "../probe.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpSocketPath(): string {
  const id = crypto.randomBytes(8).toString("hex")
  return path.join(os.tmpdir(), `kyneta-flip-${id}.sock`)
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 8000, intervalMs = 25 } = {},
): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise(r => setTimeout(r, intervalMs))
  }
}

const Doc = json.bind(Schema.struct({ n: Schema.number() }))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UnixSocketPeerTransport — leaderless healing", () => {
  const exchanges: Exchange[] = []
  let socketPath: string

  afterEach(async () => {
    for (const ex of exchanges) {
      try {
        await ex.shutdown()
      } catch {
        // ignore
      }
    }
    exchanges.length = 0
    try {
      fs.unlinkSync(socketPath)
    } catch {
      // ignore
    }
  })

  it("connector→listener flips in place, keeps transportId, and docs survive", async () => {
    socketPath = tmpSocketPath()

    // --- A: first peer → listener (probe enoent → bind) -------------------
    const peerA = createUnixSocketPeer({ path: socketPath })
    const exA = new Exchange({
      id: { peerId: "A", name: "A" },
      transports: [peerA],
    })
    exchanges.push(exA)
    await waitFor(() => peerA.role === "listener")

    // probe silence: a bare probe is accepted but never sends `establish`,
    // so it must NOT register as a peer on A.
    const peersBefore = [...exA.peers.keys()].length
    await probe(socketPath)
    await new Promise(r => setTimeout(r, 150))
    expect([...exA.peers.keys()].length).toBe(peersBefore)

    // --- B: second peer → connector (probe connected → connect) -----------
    // Use the raw transport so we can assert transportId stability.
    const peerB = new UnixSocketPeerTransport({ path: socketPath })
    const exB = new Exchange({
      id: { peerId: "B", name: "B" },
      transports: [peerB],
    })
    exchanges.push(exB)
    await waitFor(() => peerB.role === "connector")
    const bIdBefore = peerB.transportId

    // doc sync A → B over the established channel
    const docA = exA.get("room", Doc)
    const docB = exB.get("room", Doc)
    batch(docA, (d: any) => d.n.set(1))
    await waitFor(() => docB.n() === 1)

    // --- kill the listener (A); B re-negotiates -> binds ------------------
    await exA.shutdown()
    exchanges.splice(exchanges.indexOf(exA), 1)

    // THE CRITICAL ASSERTION: B flips to listener IN PLACE, same object.
    await waitFor(() => peerB.role === "listener")
    expect(peerB.role).toBe("listener")
    expect(peerB.transportId).toBe(bIdBefore)

    // --- C: new peer connects to the freshly-flipped listener B -----------
    const peerC = createUnixSocketPeer({ path: socketPath })
    const exC = new Exchange({
      id: { peerId: "C", name: "C" },
      transports: [peerC],
    })
    exchanges.push(exC)
    await waitFor(() => peerC.role === "connector")

    // C must receive B's pre-flip doc state (n=1) through the flipped
    // listener — proving B's doc state survived and the new channels sync.
    const docC = exC.get("room", Doc)
    await waitFor(() => docC.n() === 1)
    expect(docC.n()).toBe(1)
  }, 40000)

  it("a connector's departure leaves the listener intact and able to accept a new peer", async () => {
    socketPath = tmpSocketPath()

    const peerA = createUnixSocketPeer({ path: socketPath })
    const exA = new Exchange({
      id: { peerId: "A", name: "A" },
      transports: [peerA],
    })
    exchanges.push(exA)
    await waitFor(() => peerA.role === "listener")

    const peerB = createUnixSocketPeer({ path: socketPath })
    const exB = new Exchange({
      id: { peerId: "B", name: "B" },
      transports: [peerB],
    })
    exchanges.push(exB)
    await waitFor(() => peerB.role === "connector")

    const docA = exA.get("room", Doc)
    const docB = exB.get("room", Doc)
    batch(docA, (d: any) => d.n.set(1))
    await waitFor(() => docB.n() === 1)

    // The connector leaves. Only connectors re-negotiate on losing the
    // listener — a listener must NOT re-negotiate on losing a connector.
    await exB.shutdown()
    exchanges.splice(exchanges.indexOf(exB), 1)
    await new Promise(r => setTimeout(r, 250))
    expect(peerA.role).toBe("listener")

    // A fresh connector can still join the surviving listener and sync.
    const peerC = createUnixSocketPeer({ path: socketPath })
    const exC = new Exchange({
      id: { peerId: "C", name: "C" },
      transports: [peerC],
    })
    exchanges.push(exC)
    await waitFor(() => peerC.role === "connector")

    const docC = exC.get("room", Doc)
    await waitFor(() => docC.n() === 1)
    expect(docC.n()).toBe(1)
  }, 40000)
})
