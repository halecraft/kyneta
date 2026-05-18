// BridgeTransport integration tests — lifecycle, channel handshake,
// and fragmentation through the wire pipeline.

import type { ChannelMsg, OfferMsg, TransportContext } from "@kyneta/transport"
import { describe, expect, it, vi } from "vitest"
import { Bridge, BridgeTransport } from "../bridge.js"

function createTransportContext(
  overrides: Partial<TransportContext> = {},
): TransportContext {
  return {
    identity: { peerId: "test-peer", type: "user" },
    onChannelReceive: vi.fn(),
    onChannelAdded: vi.fn(),
    onChannelRemoved: vi.fn(),
    onChannelEstablish: vi.fn(),
    ...overrides,
  }
}

describe("BridgeTransport", () => {
  it("two adapters register in a shared Bridge", async () => {
    const bridge = new Bridge()

    const ctxA = createTransportContext({
      identity: { peerId: "peer-a", type: "user" },
    })
    const ctxB = createTransportContext({
      identity: { peerId: "peer-b", type: "user" },
    })

    const adapterA = new BridgeTransport({ transportId: "peer-a", bridge })
    const adapterB = new BridgeTransport({ transportId: "peer-b", bridge })

    await adapterA._initialize(ctxA)
    await adapterA._start()
    await adapterB._initialize(ctxB)
    await adapterB._start()

    expect(bridge.transports.size).toBe(2)
  })

  it("stops cleanly and removes from bridge", async () => {
    const bridge = new Bridge()

    const adapterA = new BridgeTransport({ transportId: "peer-a", bridge })
    await adapterA._initialize(createTransportContext())
    await adapterA._start()

    expect(bridge.transports.size).toBe(1)

    await adapterA._stop()
    expect(bridge.transports.size).toBe(0)
  })

  it("channel lifecycle: connected → established via handshake", async () => {
    const bridge = new Bridge()

    const establishedChannels: number[] = []

    const adapterA = new BridgeTransport({ transportId: "peer-a", bridge })
    const adapterB = new BridgeTransport({ transportId: "peer-b", bridge })

    await adapterA._initialize(
      createTransportContext({
        identity: { peerId: "peer-a", type: "user" },
        onChannelEstablish: channel =>
          establishedChannels.push(channel.channelId),
      }),
    )
    await adapterA._start()

    await adapterB._initialize(
      createTransportContext({
        identity: { peerId: "peer-b", type: "user" },
        onChannelEstablish: channel =>
          establishedChannels.push(channel.channelId),
      }),
    )
    await adapterB._start()

    expect(establishedChannels.length).toBeGreaterThan(0)
  })

  it("fragments and reassembles large messages through the bridge", async () => {
    const bridge = new Bridge()

    // 200KB payload — exceeds the 100KB fragmentation threshold
    const largeData = new Uint8Array(200 * 1024)
    for (let i = 0; i < largeData.length; i++) {
      largeData[i] = i % 256
    }

    const offer: OfferMsg = {
      type: "offer",
      docId: "doc-large",
      payload: { kind: "entirety", encoding: "binary", data: largeData },
      version: "1",
    }

    const received: ChannelMsg[] = []
    let resolveReceived!: () => void
    const receivedPromise = new Promise<void>(resolve => {
      resolveReceived = resolve
    })

    const ctxB = createTransportContext({
      identity: { peerId: "peer-b", type: "user" },
      onChannelReceive: (_channelId, message) => {
        received.push(message)
        resolveReceived()
      },
    })

    const ctxA = createTransportContext({
      identity: { peerId: "peer-a", type: "user" },
    })

    const adapterA = new BridgeTransport({ transportId: "peer-a", bridge })
    const adapterB = new BridgeTransport({ transportId: "peer-b", bridge })

    await adapterA._initialize(ctxA)
    await adapterA._start()
    await adapterB._initialize(ctxB)
    await adapterB._start()

    // Get the channelId for A→B
    const channelIds: number[] = []
    for (const ch of adapterA.channels) {
      channelIds.push(ch.channelId)
    }
    // Send the large offer through A's channel to B
    adapterA._send({
      toChannelIds: channelIds,
      message: offer,
    })

    await receivedPromise

    expect(received).toHaveLength(1)
    const msg = received[0]
    expect(msg).toBeDefined()
    if (msg === undefined) throw new Error("unreachable")
    expect(msg.type).toBe("offer")
    if (msg.type !== "offer") throw new Error("unreachable")
    expect(msg.docId).toBe("doc-large")
    expect(msg.payload.data).toBeInstanceOf(Uint8Array)
    if (!(msg.payload.data instanceof Uint8Array))
      throw new Error("unreachable")
    expect(msg.payload.data.length).toBe(largeData.length)
    expect(new Uint8Array(msg.payload.data)).toEqual(largeData)
  })
})
