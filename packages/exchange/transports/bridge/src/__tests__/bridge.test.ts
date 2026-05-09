// BridgeTransport — codec-faithful + alias-aware in-process tests.

import { SYNC_AUTHORITATIVE } from "@kyneta/schema"
import type { ChannelMsg, TransportContext } from "@kyneta/transport"
import { cborCodec } from "@kyneta/wire"
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
    const bridge = new Bridge({ codec: cborCodec })

    const receivedByB: ChannelMsg[] = []

    const ctxA = createTransportContext({
      identity: { peerId: "peer-a", type: "user" },
    })
    const ctxB = createTransportContext({
      identity: { peerId: "peer-b", type: "user" },
      onChannelReceive: (_id, msg) => receivedByB.push(msg),
    })

    const adapterA = new BridgeTransport({ transportId: "peer-a", bridge })
    const adapterB = new BridgeTransport({ transportId: "peer-b", bridge })

    adapterA._initialize(ctxA)
    await adapterA._start()
    adapterB._initialize(ctxB)
    await adapterB._start()

    expect(bridge.transports.size).toBe(2)

    const msg: ChannelMsg = {
      type: "present",
      docs: [
        {
          docId: "test-doc",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0] as const,
          syncProtocol: SYNC_AUTHORITATIVE,
        },
      ],
    }
    bridge.routeMessage("peer-a", "peer-b", msg)

    for (let i = 0; i < 4; i++) {
      await new Promise<void>(r => queueMicrotask(r))
    }

    expect(receivedByB.length).toBe(1)
    expect(receivedByB[0]).toEqual(msg)
  })

  it("stops cleanly and removes from bridge", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const adapterA = new BridgeTransport({ transportId: "peer-a", bridge })
    adapterA._initialize(createTransportContext())
    await adapterA._start()

    expect(bridge.transports.size).toBe(1)

    await adapterA._stop()
    expect(bridge.transports.size).toBe(0)
  })

  it("channel lifecycle: connected → established via handshake", async () => {
    const bridge = new Bridge({ codec: cborCodec })

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
    const bridge = new Bridge({ codec: cborCodec })

    const receivedByB: ChannelMsg[] = []

    const ctxA = createTransportContext({
      identity: { peerId: "peer-a", type: "user" },
    })
    const ctxB = createTransportContext({
      identity: { peerId: "peer-b", type: "user" },
      onChannelReceive: (_id, msg) => receivedByB.push(msg),
    })

    const adapterA = new BridgeTransport({ transportId: "peer-a", bridge })
    const adapterB = new BridgeTransport({ transportId: "peer-b", bridge })

    adapterA._initialize(ctxA)
    await adapterA._start()
    adapterB._initialize(ctxB)
    await adapterB._start()

    const presentMsg: ChannelMsg = {
      type: "present",
      docs: [
        {
          docId: "ascii-doc",
          schemaHash: "00abc",
          replicaType: ["plain", 1, 0] as const,
          syncProtocol: SYNC_AUTHORITATIVE,
        },
        {
          docId: "日本語-doc-🚀",
          schemaHash: "11def",
          replicaType: ["plain", 1, 0] as const,
          syncProtocol: SYNC_AUTHORITATIVE,
        },
      ],
    }
    bridge.routeMessage("peer-a", "peer-b", presentMsg)

    const offerMsg: ChannelMsg = {
      type: "offer",
      docId: "ascii-doc",
      payload: {
        kind: "entirety",
        encoding: "binary",
        data: new Uint8Array([0, 1, 2, 3, 0xff, 0xfe, 0xfd]),
      },
      version: "v1",
    }
    bridge.routeMessage("peer-a", "peer-b", offerMsg)

    for (let i = 0; i < 4; i++) {
      await new Promise<void>(r => queueMicrotask(r))
    }

    expect(receivedByB).toEqual([presentMsg, offerMsg])
    expect(receivedByB[0]).not.toBe(presentMsg)
    expect(receivedByB[1]).not.toBe(offerMsg)
  })
})
