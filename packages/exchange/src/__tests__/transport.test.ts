// Adapter and BridgeTransport — unit tests for the adapter/channel infrastructure.

import { describe, expect, it, vi } from "vitest"
import type { GeneratedChannel } from "../channel.js"
import type { ChannelMsg } from "../messages.js"
import { Bridge, BridgeTransport } from "../transport/bridge-transport.js"
import type { TransportContext } from "../transport/transport.js"
import { Transport } from "../transport/transport.js"
import { TransportManager } from "../transport/transport-manager.js"
import type { PeerIdentityDetails } from "../types.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const testIdentity: PeerIdentityDetails = {
  peerId: "test-peer",
  name: "Test Peer",
  type: "user",
}

function createTransportContext(
  overrides: Partial<TransportContext> = {},
): TransportContext {
  return {
    identity: testIdentity,
    onChannelReceive: vi.fn(),
    onChannelAdded: vi.fn(),
    onChannelRemoved: vi.fn(),
    onChannelEstablish: vi.fn(),
    ...overrides,
  }
}

/**
 * Minimal concrete adapter for testing the abstract Transport base class.
 */
class TestAdapter extends Transport<{ label: string }> {
  started = false
  stopped = false

  constructor(transportType = "test") {
    super({ transportType, transportId: transportType })
  }

  generate(_context: { label: string }): GeneratedChannel {
    return {
      transportType: this.transportType,
      send: vi.fn(),
      stop: vi.fn(),
    }
  }

  async onStart(): Promise<void> {
    this.started = true
  }

  async onStop(): Promise<void> {
    this.stopped = true
  }
}

// ---------------------------------------------------------------------------
// Adapter lifecycle
// ---------------------------------------------------------------------------

describe("Transport lifecycle", () => {
  it("starts in 'created' state and transitions through initialize → start → stop", async () => {
    const adapter = new TestAdapter()
    const ctx = createTransportContext()

    // Initialize
    adapter._initialize(ctx)

    // Start
    await adapter._start()
    expect(adapter.started).toBe(true)

    // Stop
    await adapter._stop()
    expect(adapter.stopped).toBe(true)
  })

  it("cannot start without being initialized", async () => {
    const adapter = new TestAdapter()
    await expect(adapter._start()).rejects.toThrow("Cannot start")
  })

  it("cannot add channel before starting", () => {
    const adapter = new TestAdapter()
    const ctx = createTransportContext()
    adapter._initialize(ctx)

    // addChannel is protected, so we test via a subclass that exposes it
    class ExposedAdapter extends TestAdapter {
      tryAddChannel() {
        return this.addChannel({ label: "test" })
      }
    }

    const exposed = new ExposedAdapter()
    exposed._initialize(ctx)
    // not started yet
    expect(() => exposed.tryAddChannel()).toThrow("must be 'started'")
  })

  it("_send routes to matching channels", async () => {
    const sendFn = vi.fn()

    class SendTestAdapter extends Transport<void> {
      generate(): GeneratedChannel {
        return {
          transportType: this.transportType,
          send: sendFn,
          stop: vi.fn(),
        }
      }

      async onStart(): Promise<void> {
        this.addChannel(undefined as undefined)
      }
      async onStop(): Promise<void> {}
    }

    const adapter = new SendTestAdapter({
      transportType: "send-test",
      transportId: "send-test",
    })
    const ctx = createTransportContext()
    adapter._initialize(ctx)
    await adapter._start()

    // Get the channel that was created during onStart
    const channels = [...adapter.channels]
    expect(channels.length).toBe(1)
    const channelId = channels[0]?.channelId

    const msg: ChannelMsg = {
      type: "establish-request",
      identity: testIdentity,
    }

    const sent = adapter._send({ toChannelIds: [channelId], message: msg })
    expect(sent).toBe(1)
    expect(sendFn).toHaveBeenCalledWith(msg)
  })

  it("_send returns 0 for non-existent channel IDs", async () => {
    const adapter = new TestAdapter()
    adapter._initialize(createTransportContext())
    await adapter._start()

    const msg: ChannelMsg = {
      type: "establish-request",
      identity: testIdentity,
    }

    const sent = adapter._send({ toChannelIds: [9999], message: msg })
    expect(sent).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// TransportManager
// ---------------------------------------------------------------------------

describe("TransportManager", () => {
  it("initializes and starts adapters", async () => {
    const adapter = new TestAdapter("mgr-test")
    const ctx = createTransportContext()

    const manager = new TransportManager({
      transports: [adapter],
      context: ctx,
      onReset: vi.fn(),
    })

    manager.startAll()
    // Give microtask a chance to run
    await new Promise<void>(r => queueMicrotask(r))

    expect(adapter.started).toBe(true)
    expect(manager.hasTransport("mgr-test")).toBe(true)
    expect(manager.transports.length).toBe(1)
  })

  it("add/remove adapter dynamically", async () => {
    const ctx = createTransportContext()
    const manager = new TransportManager({
      context: ctx,
      onReset: vi.fn(),
    })

    const adapter = new TestAdapter("dynamic")
    await manager.addTransport(adapter)
    expect(manager.hasTransport("dynamic")).toBe(true)
    expect(adapter.started).toBe(true)

    await manager.removeTransport("dynamic")
    expect(manager.hasTransport("dynamic")).toBe(false)
    expect(adapter.stopped).toBe(true)
  })

  it("addTransport is idempotent", async () => {
    const ctx = createTransportContext()
    const manager = new TransportManager({
      context: ctx,
      onReset: vi.fn(),
    })

    const adapter = new TestAdapter("idem")
    await manager.addTransport(adapter)
    await manager.addTransport(adapter) // no-op
    expect(manager.transports.length).toBe(1)
  })

  it("removeTransport is idempotent for non-existent IDs", async () => {
    const ctx = createTransportContext()
    const manager = new TransportManager({
      context: ctx,
      onReset: vi.fn(),
    })

    // Should not throw
    await manager.removeTransport("nonexistent")
  })

  it("sends envelopes across all adapters", async () => {
    const ctx = createTransportContext()
    const sendFn = vi.fn()

    class ChannelAdapter extends Transport<void> {
      channelIdPublic?: number
      generate(): GeneratedChannel {
        return {
          transportType: this.transportType,
          send: sendFn,
          stop: vi.fn(),
        }
      }
      async onStart(): Promise<void> {
        const ch = this.addChannel(undefined as undefined)
        this.channelIdPublic = ch.channelId
      }
      async onStop(): Promise<void> {}
    }

    const adapter = new ChannelAdapter({
      transportType: "ch-adapter",
      transportId: "ch-adapter",
    })

    const manager = new TransportManager({
      transports: [adapter],
      context: ctx,
      onReset: vi.fn(),
    })

    manager.startAll()
    await new Promise<void>(r => queueMicrotask(r))

    const msg: ChannelMsg = {
      type: "present",
      docs: [
        {
          docId: "doc-1",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "sequential" as const,
        },
      ],
    }
    const sent = manager.send({
      toChannelIds: [adapter.channelIdPublic!],
      message: msg,
    })

    expect(sent).toBe(1)
    expect(sendFn).toHaveBeenCalledWith(msg)
  })
})

// ---------------------------------------------------------------------------
// BridgeTransport — two adapters exchange messages
// ---------------------------------------------------------------------------

describe("BridgeTransport", () => {
  it("two adapters exchange messages through a Bridge", async () => {
    const bridge = new Bridge()

    const receivedByA: ChannelMsg[] = []
    const receivedByB: ChannelMsg[] = []

    const ctxA = createTransportContext({
      identity: { peerId: "peer-a", type: "user" },
      onChannelReceive: (_channelId, msg) => receivedByA.push(msg),
    })

    const ctxB = createTransportContext({
      identity: { peerId: "peer-b", type: "user" },
      onChannelReceive: (_channelId, msg) => receivedByB.push(msg),
    })

    const adapterA = new BridgeTransport({ transportType: "peer-a", bridge })
    const adapterB = new BridgeTransport({ transportType: "peer-b", bridge })

    adapterA._initialize(ctxA)
    await adapterA._start()

    adapterB._initialize(ctxB)
    await adapterB._start()

    // At this point, both adapters should have channels to each other.
    // adapterB's onStart established channels to adapterA.
    // The establish handshake triggers onChannelEstablish — but our mock
    // doesn't complete the handshake. Let's verify channels were created.

    expect(bridge.transports.size).toBe(2)

    // Send a message from A to B via the bridge directly
    const msg: ChannelMsg = {
      type: "present",
      docs: [
        {
          docId: "test-doc",
          schemaHash: "00test",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "sequential" as const,
        },
      ],
    }
    adapterA.deliverMessage("peer-b", msg)

    // Message delivered async — wait for microtask
    // Note: deliverMessage is called ON adapterA, meaning peer-b sends TO adapterA
    // but we're testing the bridge routing, so let's route through bridge instead

    bridge.routeMessage("peer-a", "peer-b", msg)

    // Wait for async delivery
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => queueMicrotask(r))

    // adapterB should have received the message via deliverMessage → onReceive
    expect(receivedByB.length).toBe(1)
    expect(receivedByB[0]).toEqual(msg)
  })

  it("stops cleanly and removes from bridge", async () => {
    const bridge = new Bridge()

    const ctxA = createTransportContext({
      identity: { peerId: "peer-a", type: "user" },
    })

    const adapterA = new BridgeTransport({ transportType: "peer-a", bridge })
    adapterA._initialize(ctxA)
    await adapterA._start()

    expect(bridge.transports.size).toBe(1)

    await adapterA._stop()
    expect(bridge.transports.size).toBe(0)
  })

  it("channel lifecycle: connected → established via handshake", async () => {
    const bridge = new Bridge()

    const establishedChannels: number[] = []

    const ctxA = createTransportContext({
      identity: { peerId: "peer-a", type: "user" },
      onChannelEstablish: channel => {
        establishedChannels.push(channel.channelId)
      },
    })

    const ctxB = createTransportContext({
      identity: { peerId: "peer-b", type: "user" },
      onChannelEstablish: channel => {
        establishedChannels.push(channel.channelId)
      },
    })

    const adapterA = new BridgeTransport({ transportType: "peer-a", bridge })
    const adapterB = new BridgeTransport({ transportType: "peer-b", bridge })

    adapterA._initialize(ctxA)
    await adapterA._start()

    adapterB._initialize(ctxB)
    await adapterB._start()

    // adapterB's onStart creates channels to adapterA and establishes them.
    // onChannelEstablish should have been called for adapterB's channels.
    expect(establishedChannels.length).toBeGreaterThan(0)
  })
})
