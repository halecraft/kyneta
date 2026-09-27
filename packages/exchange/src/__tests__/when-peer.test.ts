import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import type { PeerIdentityDetails } from "@kyneta/transport"
import { afterEach, describe, expect, it } from "vitest"
import { Exchange } from "../exchange.js"
import { whenPeer } from "../when-peer.js"

async function drain(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

const active: Exchange[] = []
afterEach(async () => {
  for (const ex of active) await ex.shutdown()
  active.length = 0
})

function open(principal: string, bridge: Bridge, transportId = principal) {
  const ex = new Exchange({
    principal,
    transports: [createBridgeTransport({ transportId, bridge })],
  })
  active.push(ex)
  return ex
}

const named =
  (principal: string) =>
  (p: PeerIdentityDetails): boolean =>
    p.principal === principal

/** The promise's value if it settles within a macrotask, else "pending". */
function settledNow<T>(p: Promise<T>): Promise<T | "pending"> {
  return Promise.race([
    p,
    new Promise<"pending">(r => setTimeout(() => r("pending"), 0)),
  ])
}

describe("whenPeer", () => {
  it("resolves at once for a connected match", async () => {
    const bridge = new Bridge()
    const alice = open("alice", bridge)
    const bob = open("bob", bridge)
    await drain()

    const found = await settledNow(whenPeer(alice, named("bob")))
    expect(found).not.toBe("pending")
    expect(found).toEqual({
      peerId: bob.peerId,
      principal: "bob",
      type: "user",
    })
  })

  it("matches a peer in its grace period", async () => {
    const bridge = new Bridge()
    const alice = open("alice", bridge)
    const bob = open("bob", bridge)
    await drain()

    // Bob's channel closes; alice holds him through the default 30 s grace.
    await bob.removeTransport("bob")
    await drain()

    const found = await settledNow(whenPeer(alice, named("bob")))
    expect(found).not.toBe("pending")
    expect(found !== "pending" && found.peerId).toBe(bob.peerId)
  })

  it("resolves later, when a match establishes", async () => {
    const bridge = new Bridge()
    const alice = open("alice", bridge)
    const pending = whenPeer(alice, named("bob"))
    expect(await settledNow(pending)).toBe("pending")

    const bob = open("bob", bridge)
    expect((await pending).peerId).toBe(bob.peerId)
  })

  it("ignores peers that do not match", async () => {
    const bridge = new Bridge()
    const alice = open("alice", bridge)
    const pending = whenPeer(alice, named("bob"))

    open("carol", bridge)
    await drain()
    expect(await settledNow(pending)).toBe("pending")

    const bob = open("bob", bridge)
    const found = await pending
    expect(found.principal).toBe("bob")
    expect(found.peerId).toBe(bob.peerId)
  })
})
