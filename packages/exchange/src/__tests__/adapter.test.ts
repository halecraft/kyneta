// Adapter and BridgeAdapter — unit tests for the adapter/channel infrastructure.

import { describe, expect, it, vi } from "vitest"
import type { AdapterContext } from "../adapter/adapter.js"
import { Adapter } from "../adapter/adapter.js"
import { AdapterManager } from "../adapter/adapter-manager.js"
import { Bridge, BridgeAdapter } from "../adapter/bridge-adapter.js"
import type { GeneratedChannel } from "../channel.js"
import type { ChannelMsg } from "../messages.js"
import type { PeerIdentityDetails } from "../types.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const testIdentity: PeerIdentityDetails = {
  peerId: "test-peer",
  name: "Test Peer",
  type: "user",
}

function createAdapterContext(
  overrides: Partial<AdapterContext> = {},
): AdapterContext {
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
 * Minimal concrete adapter for testing the abstract Adapter base class.
 */
class TestAdapter extends Adapter<{ label: string }> {
  started = false
  stopped = false

  constructor(adapterType = "test") {
    super({ adapterType, adapterId: adapterType })
  }

  generate(context: { label: string }): GeneratedChannel {
    return {
      kind: "network",
      adapterType: this.adapterType,
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

describe("Adapter lifecycle", () => {
  it("starts in 'created' state and transitions through initialize → start → stop", async () => {
    const adapter = new TestAdapter()
    const ctx = createAdapterContext()

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
    const ctx = createAdapterContext()
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

    class SendTestAdapter extends Adapter<void> {
      generate(): GeneratedChannel {
        return {
          kind: "network",
          adapterType: this.adapterType,
          send: sendFn,
          stop: vi.fn(),
        }
      }

      async onStart(): Promise<void> {
        this.addChannel(undefined as void)
      }
      async onStop(): Promise<void> {}
    }

    const adapter = new SendTestAdapter({
      adapterType: "send-test",
      adapterId: "send-test",
    })
    const ctx = createAdapterContext()
    adapter._initialize(ctx)
    await adapter._start()

    // Get the channel that was created during onStart
    const channels = [...adapter.channels]
    expect(channels.length).toBe(1)
    const channelId = channels[0]!.channelId

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
    adapter._initialize(createAdapterContext())
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
// AdapterManager
// ---------------------------------------------------------------------------

describe("AdapterManager", () => {
  it("initializes and starts adapters", async () => {
    const adapter = new TestAdapter("mgr-test")
    const ctx = createAdapterContext()

    const manager = new AdapterManager({
      adapters: [adapter],
      context: ctx,
      onReset: vi.fn(),
    })

    manager.startAll()
    // Give microtask a chance to run
    await new Promise<void>(r => queueMicrotask(r))

    expect(adapter.started).toBe(true)
    expect(manager.hasAdapter("mgr-test")).toBe(true)
    expect(manager.adapters.length).toBe(1)
  })

  it("add/remove adapter dynamically", async () => {
    const ctx = createAdapterContext()
    const manager = new AdapterManager({
      context: ctx,
      onReset: vi.fn(),
    })

    const adapter = new TestAdapter("dynamic")
    await manager.addAdapter(adapter)
    expect(manager.hasAdapter("dynamic")).toBe(true)
    expect(adapter.started).toBe(true)

    await manager.removeAdapter("dynamic")
    expect(manager.hasAdapter("dynamic")).toBe(false)
    expect(adapter.stopped).toBe(true)
  })

  it("addAdapter is idempotent", async () => {
    const ctx = createAdapterContext()
    const manager = new AdapterManager({
      context: ctx,
      onReset: vi.fn(),
    })

    const adapter = new TestAdapter("idem")
    await manager.addAdapter(adapter)
    await manager.addAdapter(adapter) // no-op
    expect(manager.adapters.length).toBe(1)
  })

  it("removeAdapter is idempotent for non-existent IDs", async () => {
    const ctx = createAdapterContext()
    const manager = new AdapterManager({
      context: ctx,
      onReset: vi.fn(),
    })

    // Should not throw
    await manager.removeAdapter("nonexistent")
  })

  it("sends envelopes across all adapters", async () => {
    const ctx = createAdapterContext()
    const sendFn = vi.fn()

    class ChannelAdapter extends Adapter<void> {
      channelIdPublic?: number
      generate(): GeneratedChannel {
        return {
          kind: "network",
          adapterType: this.adapterType,
          send: sendFn,
          stop: vi.fn(),
        }
      }
      async onStart(): Promise<void> {
        const ch = this.addChannel(undefined as void)
        this.channelIdPublic = ch.channelId
      }
      async onStop(): Promise<void> {}
    }

    const adapter = new ChannelAdapter({
      adapterType: "ch-adapter",
      adapterId: "ch-adapter",
    })

    const manager = new AdapterManager({
      adapters: [adapter],
      context: ctx,
      onReset: vi.fn(),
    })

    manager.startAll()
    await new Promise<void>(r => queueMicrotask(r))

    const msg: ChannelMsg = { type: "discover", docIds: ["doc-1"] }
    const sent = manager.send({
      toChannelIds: [adapter.channelIdPublic!],
      message: msg,
    })

    expect(sent).toBe(1)
    expect(sendFn).toHaveBeenCalledWith(msg)
  })
})

// ---------------------------------------------------------------------------
// BridgeAdapter — two adapters exchange messages
// ---------------------------------------------------------------------------

describe("BridgeAdapter", () => {
  it("two adapters exchange messages through a Bridge", async () => {
    const bridge = new Bridge()

    const receivedByA: ChannelMsg[] = []
    const receivedByB: ChannelMsg[] = []

    const ctxA = createAdapterContext({
      identity: { peerId: "peer-a", type: "user" },
      onChannelReceive: (_channelId, msg) => receivedByA.push(msg),
    })

    const ctxB = createAdapterContext({
      identity: { peerId: "peer-b", type: "user" },
      onChannelReceive: (_channelId, msg) => receivedByB.push(msg),
    })

    const adapterA = new BridgeAdapter({ adapterType: "peer-a", bridge })
    const adapterB = new BridgeAdapter({ adapterType: "peer-b", bridge })

    adapterA._initialize(ctxA)
    await adapterA._start()

    adapterB._initialize(ctxB)
    await adapterB._start()

    // At this point, both adapters should have channels to each other.
    // adapterB's onStart established channels to adapterA.
    // The establish handshake triggers onChannelEstablish — but our mock
    // doesn't complete the handshake. Let's verify channels were created.

    expect(bridge.adapters.size).toBe(2)

    // Send a message from A to B via the bridge directly
    const msg: ChannelMsg = { type: "discover", docIds: ["test-doc"] }
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

    const ctxA = createAdapterContext({
      identity: { peerId: "peer-a", type: "user" },
    })

    const adapterA = new BridgeAdapter({ adapterType: "peer-a", bridge })
    adapterA._initialize(ctxA)
    await adapterA._start()

    expect(bridge.adapters.size).toBe(1)

    await adapterA._stop()
    expect(bridge.adapters.size).toBe(0)
  })

  it("channel lifecycle: connected → established via handshake", async () => {
    const bridge = new Bridge()

    const establishedChannels: number[] = []

    const ctxA = createAdapterContext({
      identity: { peerId: "peer-a", type: "user" },
      onChannelEstablish: channel => {
        establishedChannels.push(channel.channelId)
      },
    })

    const ctxB = createAdapterContext({
      identity: { peerId: "peer-b", type: "user" },
      onChannelEstablish: channel => {
        establishedChannels.push(channel.channelId)
      },
    })

    const adapterA = new BridgeAdapter({ adapterType: "peer-a", bridge })
    const adapterB = new BridgeAdapter({ adapterType: "peer-b", bridge })

    adapterA._initialize(ctxA)
    await adapterA._start()

    adapterB._initialize(ctxB)
    await adapterB._start()

    // adapterB's onStart creates channels to adapterA and establishes them.
    // onChannelEstablish should have been called for adapterB's channels.
    expect(establishedChannels.length).toBeGreaterThan(0)
  })
})
