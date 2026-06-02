// Transport — unit tests for the abstract transport / channel infrastructure.
//
// BridgeTransport tests live in @kyneta/bridge-transport.

import { describe, expect, it, vi } from "vitest"
import type { GeneratedChannel } from "../channel.js"
import { ChannelDirectory } from "../channel-directory.js"
import type { ChannelMsg } from "../messages.js"
import { createTestTransportContext } from "../testing/transport-context.js"
import { Transport } from "../transport.js"
import { type PeerIdentityDetails, PROTOCOL_VERSION } from "../types.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const testIdentity: PeerIdentityDetails = {
  peerId: "test-peer",
  name: "Test Peer",
  type: "user",
}

const createTransportContext = createTestTransportContext

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
    await adapter._initialize(ctx)

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

  it("cannot add channel before starting", async () => {
    const adapter = new TestAdapter()
    const ctx = createTransportContext()
    await adapter._initialize(ctx)

    // addChannel is protected, so we test via a subclass that exposes it
    class ExposedAdapter extends TestAdapter {
      tryAddChannel() {
        return this.addChannel({ label: "test" })
      }
    }

    const exposed = new ExposedAdapter()
    await exposed._initialize(ctx)
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
    await adapter._initialize(ctx)
    await adapter._start()

    // Get the channel that was created during onStart
    const channels = [...adapter.channels]
    expect(channels.length).toBe(1)
    const channelId = channels[0]?.channelId

    const msg: ChannelMsg = {
      type: "establish",
      identity: testIdentity,
      protocolVersion: PROTOCOL_VERSION,
    }

    const sent = adapter._send({ toChannelIds: [channelId], message: msg })
    expect(sent).toBe(1)
    expect(sendFn).toHaveBeenCalledWith(msg)
  })

  it("_send continues fan-out when one channel throws", async () => {
    const sendFnA = vi.fn(() => {
      throw new Error("channel A broken")
    })
    const sendFnB = vi.fn()

    class FanOutAdapter extends Transport<void> {
      #callCount = 0

      generate(): GeneratedChannel {
        this.#callCount++
        if (this.#callCount === 1) {
          return {
            transportType: this.transportType,
            send: sendFnA,
            stop: vi.fn(),
          }
        }
        return {
          transportType: this.transportType,
          send: sendFnB,
          stop: vi.fn(),
        }
      }

      async onStart(): Promise<void> {
        this.addChannel(undefined)
        this.addChannel(undefined)
      }

      async onStop(): Promise<void> {}
    }

    const adapter = new FanOutAdapter({
      transportType: "fanout",
      transportId: "fanout",
    })
    const ctx = createTransportContext()
    await adapter._initialize(ctx)
    await adapter._start()

    const channels = [...adapter.channels]
    const chAId = channels[0]?.channelId
    const chBId = channels[1]?.channelId
    expect(chAId).toBe(1)
    expect(chBId).toBe(2)

    const msg: ChannelMsg = {
      type: "establish",
      identity: testIdentity,
      protocolVersion: PROTOCOL_VERSION,
    }

    adapter._send({
      toChannelIds: [chAId, chBId] as number[],
      message: msg,
    })

    expect(sendFnA).toHaveBeenCalledWith(msg)
    expect(sendFnB).toHaveBeenCalledWith(msg)
  })

  it("_send returns 0 for non-existent channel IDs", async () => {
    const adapter = new TestAdapter()
    await adapter._initialize(createTransportContext())
    await adapter._start()

    const msg: ChannelMsg = {
      type: "establish",
      identity: testIdentity,
      protocolVersion: PROTOCOL_VERSION,
    }

    const sent = adapter._send({ toChannelIds: [9999], message: msg })
    expect(sent).toBe(0)
  })

  it("calls onStop() during re-initialization to avoid resource leaks", async () => {
    const adapter = new TestAdapter()
    const ctx = createTransportContext()

    await adapter._initialize(ctx)
    await adapter._start()
    expect(adapter.stopped).toBe(false) // not stopped yet

    // Re-initialize (HMR path) — should first stop the adapter to clean up
    await adapter._initialize(ctx)

    expect(adapter.stopped).toBe(true)
  })

  it("ChannelDirectory stores channels under the caller-supplied id", () => {
    const generate = vi.fn(() => ({
      transportType: "test" as const,
      send: vi.fn(),
      stop: vi.fn(),
    }))

    const dir = new ChannelDirectory(generate)

    const ch1 = dir.create(7, { label: "a" }, vi.fn())
    expect(ch1.channelId).toBe(7)
    expect(dir.get(7)).toBe(ch1)

    // The directory never invents ids; uniqueness is the caller's job.
    const ch2 = dir.create(42, { label: "b" }, vi.fn())
    expect(ch2.channelId).toBe(42)
    expect(dir.size).toBe(2)
  })

  it("establishChannel throws if channel is not in connected state", async () => {
    const ctx = createTransportContext()

    class ExposedAdapter extends TestAdapter {
      tryAddChannel() {
        return this.addChannel({ label: "test" })
      }
      tryEstablishChannel(channelId: number) {
        return this.establishChannel(channelId)
      }
    }

    const exposed = new ExposedAdapter()
    await exposed._initialize(ctx)
    await exposed._start()

    const channel = exposed.tryAddChannel()
    expect(channel.type).toBe("connected")

    // Simulate the channel having transitioned to established elsewhere
    ;(channel as unknown as { type: string }).type = "established"

    expect(() => exposed.tryEstablishChannel(channel.channelId)).toThrow(
      "expected 'connected'",
    )
  })
})
