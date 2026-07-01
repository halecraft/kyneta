// Line relay tests — hub-and-spoke message routing through a schema-free relay peer.
// Covers both symmetric open() routing and listen()-based relay.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { Replicate, Schema } from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import {
  Exchange,
  type ExchangeParams,
  type PeerIdentityInput,
} from "../exchange.js"
import { Line } from "../line.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

async function drain(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

const activeExchanges: Exchange[] = []

function createExchange(params: Partial<ExchangeParams> = {}): Exchange {
  const merged = { id: "test" as string | PeerIdentityInput, ...params }
  const ex = new Exchange(merged as ExchangeParams)
  activeExchanges.push(ex)
  return ex
}

function collect<T>(recv: AsyncIterable<T>, into: T[]): void {
  ;(async () => {
    for await (const msg of recv) into.push(msg)
  })()
}

afterEach(async () => {
  for (const ex of activeExchanges) {
    try {
      await ex.shutdown()
    } catch {
      /* ignore */
    }
  }
  activeExchanges.length = 0
})

const RequestSchema = Schema.struct({
  method: Schema.string(),
  id: Schema.number(),
})
const ResponseSchema = Schema.struct({
  result: Schema.string(),
  id: Schema.number(),
})
const SimpleSchema = Schema.struct({ value: Schema.number() })

// ── Tests ────────────────────────────────────────────────────────────────────

describe("hub-and-spoke relay", () => {
  it("messages flow Alice → Server → Bob via relay (symmetric sender/receiver)", async () => {
    const bridgeAS = new Bridge()
    const bridgeSB = new Bridge()

    const exchangeA = createExchange({
      id: "alice",
      transports: [
        createBridgeTransport({ transportId: "alice", bridge: bridgeAS }),
      ],
    })

    // Schema-free relay — forwards all docs via Replicate()
    createExchange({
      id: { peerId: "server", type: "service" },
      transports: [
        createBridgeTransport({ transportId: "server-a", bridge: bridgeAS }),
        createBridgeTransport({ transportId: "server-b", bridge: bridgeSB }),
      ],
      resolve: () => Replicate(),
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [
        createBridgeTransport({ transportId: "bob", bridge: bridgeSB }),
      ],
    })

    await drain(40)

    const P = Line.protocol({ topic: "relay", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, "bob")
    const aliceReceiver = P.claimReceiver(exchangeA, "bob")
    const bobSender = P.sender(exchangeB, "alice")
    const bobReceiver = P.claimReceiver(exchangeB, "alice")

    await drain(60)

    const receivedByB: { value: number }[] = []
    collect(bobReceiver, receivedByB)

    aliceSender.send({ value: 42 })
    await drain(100)
    expect(receivedByB.map(m => m.value)).toContain(42)

    const receivedByA: { value: number }[] = []
    collect(aliceReceiver, receivedByA)

    bobSender.send({ value: 99 })
    await drain(100)
    expect(receivedByA.map(m => m.value)).toContain(99)

    aliceSender.close()
    aliceReceiver.close()
    bobSender.close()
    bobReceiver.close()
  })

  it("hub-and-spoke relay with protocol.listen", async () => {
    const bridgeCR = new Bridge()
    const bridgeRS = new Bridge()

    const exchangeClient = createExchange({
      id: "client",
      transports: [
        createBridgeTransport({ transportId: "client", bridge: bridgeCR }),
      ],
    })

    createExchange({
      id: { peerId: "relay", type: "service" },
      transports: [
        createBridgeTransport({ transportId: "relay-c", bridge: bridgeCR }),
        createBridgeTransport({ transportId: "relay-s", bridge: bridgeRS }),
      ],
      resolve: () => Replicate(),
    })

    const exchangeServer = createExchange({
      id: "server",
      transports: [
        createBridgeTransport({ transportId: "server", bridge: bridgeRS }),
      ],
    })

    await drain(40)

    const RPC = Line.protocol({
      topic: "relay-rpc",
      client: RequestSchema,
      server: ResponseSchema,
    })

    let capturedServerSender: any = null
    const serverReceived: Array<{ method: string; id: number }> = []
    const listener = RPC.listen(exchangeServer)
    listener.onReceive((sender, receiver) => {
      capturedServerSender = sender
      collect(receiver, serverReceived)
    })

    const clientSender = RPC.sender(exchangeClient, "server")
    const clientReceiver = RPC.claimReceiver(exchangeClient, "server")
    const clientReceived: Array<{ result: string; id: number }> = []
    collect(clientReceiver, clientReceived)

    await drain(60)

    clientSender.send({ method: "relay-ping", id: 1 })
    await drain(100)

    expect(capturedServerSender).not.toBeNull()
    expect(serverReceived).toEqual([{ method: "relay-ping", id: 1 }])

    capturedServerSender.send({ result: "relay-pong", id: 1 })
    await drain(100)

    expect(clientReceived).toEqual([{ result: "relay-pong", id: 1 }])

    listener.dispose()
    clientSender.close()
    clientReceiver.close()
    capturedServerSender?.close()
  })
})
