// Transport — unit tests for the abstract transport / channel infrastructure.
//
// BridgeTransport tests live in @kyneta/bridge-transport.

import { describe, expect, it, vi } from "vitest"
import type { GeneratedChannel } from "../channel.js"
import type { ChannelMsg } from "../messages.js"
import type { TransportContext } from "../transport.js"
import { Transport } from "../transport.js"
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
      type: "establish",
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
      type: "establish",
      identity: testIdentity,
    }

    const sent = adapter._send({ toChannelIds: [9999], message: msg })
    expect(sent).toBe(0)
  })
})
