// TransportManager — unit tests for transport lifecycle and message routing.

import { SYNC_AUTHORITATIVE } from "@kyneta/schema"
import type {
  ChannelMsg,
  GeneratedChannel,
  PeerIdentityDetails,
  TransportContext,
} from "@kyneta/transport"
import { Transport } from "@kyneta/transport"
import { describe, expect, it, vi } from "vitest"
import { TransportManager } from "../transport/transport-manager.js"

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
 * Minimal concrete adapter for testing.
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
          syncProtocol: SYNC_AUTHORITATIVE,
        },
      ],
    }
    if (adapter.channelIdPublic === undefined)
      throw new Error("expected channelId")
    const sent = manager.send({
      toChannelIds: [adapter.channelIdPublic],
      message: msg,
    })

    expect(sent).toBe(1)
    expect(sendFn).toHaveBeenCalledWith(msg)
  })
})
