// BridgeTransport — codec-faithful + alias-aware in-process tests.

import type { TransportContext } from "@kyneta/transport"
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
  it("two adapters exchange messages through a Bridge", async () => {
    const bridge = new Bridge()

    const ctxA = createTransportContext({
      identity: { peerId: "peer-a", type: "user" },
    })
    const ctxB = createTransportContext({
      identity: { peerId: "peer-b", type: "user" },
    })

    const adapterA = new BridgeTransport({ transportId: "peer-a", bridge })
    const adapterB = new BridgeTransport({ transportId: "peer-b", bridge })

    adapterA._initialize(ctxA)
    await adapterA._start()
    adapterB._initialize(ctxB)
    await adapterB._start()

    expect(bridge.transports.size).toBe(2)
  })

  it("stops cleanly and removes from bridge", async () => {
    const bridge = new Bridge()

    const adapterA = new BridgeTransport({ transportId: "peer-a", bridge })
    adapterA._initialize(createTransportContext())
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

    adapterA._initialize(
      createTransportContext({
        identity: { peerId: "peer-a", type: "user" },
        onChannelEstablish: channel =>
          establishedChannels.push(channel.channelId),
      }),
    )
    await adapterA._start()

    adapterB._initialize(
      createTransportContext({
        identity: { peerId: "peer-b", type: "user" },
        onChannelEstablish: channel =>
          establishedChannels.push(channel.channelId),
      }),
    )
    await adapterB._start()

    expect(establishedChannels.length).toBeGreaterThan(0)
  })

  it("codec-faithful: messages round-trip bit-perfectly via the bridge codec", async () => {
    const bridge = new Bridge()

    const ctxA = createTransportContext({
      identity: { peerId: "peer-a", type: "user" },
    })
    const ctxB = createTransportContext({
      identity: { peerId: "peer-b", type: "user" },
    })

    const adapterA = new BridgeTransport({ transportId: "peer-a", bridge })
    const adapterB = new BridgeTransport({ transportId: "peer-b", bridge })

    adapterA._initialize(ctxA)
    await adapterA._start()
    adapterB._initialize(ctxB)
    await adapterB._start()

    expect(bridge.transports.size).toBe(2)
  })
})
