// Line relay tests — hub-and-spoke message routing through a schema-free relay peer.
// Covers both symmetric open() routing and listen()-based relay.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { Replicate, Schema } from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import { Exchange, type ExchangeParams } from "../exchange.js"
import { Line, type LineSender } from "../line.js"

// ── Helpers ──────────────────────────────────────────────────────────────────

async function drain(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

const activeExchanges: Exchange[] = []

function createExchange(params: Partial<ExchangeParams> = {}): Exchange {
  const ex = new Exchange({ principal: "test", ...params })
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
      principal: "alice",
      transports: [
        createBridgeTransport({ transportId: "alice", bridge: bridgeAS }),
      ],
    })

    // Schema-free relay — forwards all docs via Replicate()
    createExchange({
      principal: "server",
      type: "service",
      transports: [
        createBridgeTransport({ transportId: "server-a", bridge: bridgeAS }),
        createBridgeTransport({ transportId: "server-b", bridge: bridgeSB }),
      ],
      resolve: () => Replicate(),
    })

    const exchangeB = createExchange({
      principal: "bob",
      transports: [
        createBridgeTransport({ transportId: "bob", bridge: bridgeSB }),
      ],
    })

    await drain(40)

    const P = Line.protocol({ topic: "relay", schema: SimpleSchema })
    const aliceSender = P.sender(exchangeA, exchangeB.peerId)
    const aliceReceiver = P.claimReceiver(exchangeA, exchangeB.peerId)
    const bobSender = P.sender(exchangeB, exchangeA.peerId)
    const bobReceiver = P.claimReceiver(exchangeB, exchangeA.peerId)

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
      principal: "client",
      transports: [
        createBridgeTransport({ transportId: "client", bridge: bridgeCR }),
      ],
    })

    createExchange({
      principal: "relay",
      type: "service",
      transports: [
        createBridgeTransport({ transportId: "relay-c", bridge: bridgeCR }),
        createBridgeTransport({ transportId: "relay-s", bridge: bridgeRS }),
      ],
      resolve: () => Replicate(),
    })

    const exchangeServer = createExchange({
      principal: "server",
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

    const captured: { sender?: LineSender<{ result: string; id: number }> } = {}
    const serverReceived: Array<{ method: string; id: number }> = []
    const listener = RPC.listen(exchangeServer)
    listener.onReceive((sender, receiver) => {
      captured.sender = sender
      collect(receiver, serverReceived)
    })

    const clientSender = RPC.sender(exchangeClient, exchangeServer.peerId)
    const clientReceiver = RPC.claimReceiver(
      exchangeClient,
      exchangeServer.peerId,
    )
    const clientReceived: Array<{ result: string; id: number }> = []
    collect(clientReceiver, clientReceived)

    await drain(60)

    clientSender.send({ method: "relay-ping", id: 1 })
    await drain(100)

    expect(captured.sender).toBeDefined()
    expect(serverReceived).toEqual([{ method: "relay-ping", id: 1 }])

    captured.sender?.send({ result: "relay-pong", id: 1 })
    await drain(100)

    expect(clientReceived).toEqual([{ result: "relay-pong", id: 1 }])

    listener.dispose()
    clientSender.close()
    clientReceiver.close()
    captured.sender?.close()
  })
})
