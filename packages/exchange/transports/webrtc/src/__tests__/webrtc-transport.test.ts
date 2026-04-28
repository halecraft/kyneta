// webrtc-transport.test — unit tests for WebrtcTransport.
//
// Tests the BYODC (Bring Your Own Data Channel) WebRTC transport
// lifecycle, send/receive pipelines, fragmentation, and multi-peer
// channel management.

import type { ChannelMsg } from "@kyneta/transport"
import { cborCodec, encodeComplete, fragmentPayload } from "@kyneta/wire"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { WebrtcTransport } from "../webrtc-transport.js"
import { MockDataChannel } from "./mock-data-channel.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Initialize and start a WebrtcTransport for testing.
 *
 * Wires up the full Transport lifecycle (construct → initialize → start)
 * with stubbed callbacks. Returns the spies so tests can assert on
 * channel lifecycle events and message delivery.
 */
function createContext() {
  return {
    identity: { peerId: "local-peer", name: "Local", type: "user" as const },
    onChannelReceive: vi.fn(),
    onChannelAdded: vi.fn(),
    onChannelRemoved: vi.fn(),
    onChannelEstablish: vi.fn(),
  }
}

async function initializeTransport(
  transport: WebrtcTransport,
  ctx = createContext(),
) {
  transport._initialize(ctx)
  await transport._start()
  return ctx
}

/** A minimal establish message for send/receive tests. */
const TEST_MSG: ChannelMsg = {
  type: "establish",
  identity: { peerId: "remote", name: "R", type: "user" },
}

// ---------------------------------------------------------------------------
// 1. Lifecycle
// ---------------------------------------------------------------------------

describe("Lifecycle", () => {
  let transport: WebrtcTransport

  beforeEach(async () => {
    transport = new WebrtcTransport()
    await initializeTransport(transport)
  })

  it("attach creates internal channel when data channel is already open", () => {
    const dc = new MockDataChannel("open")
    transport.attachDataChannel("peer-1", dc)

    expect(transport.hasDataChannel("peer-1")).toBe(true)
    expect(transport.getAttachedPeerIds()).toContain("peer-1")
  })

  it("attach waits for open event when connecting", () => {
    const dc = new MockDataChannel("connecting")
    transport.attachDataChannel("peer-1", dc)

    expect(transport.hasDataChannel("peer-1")).toBe(true)
    // Sync channel not yet created — still connecting
    expect(transport.channels.size).toBe(0)

    dc.open()
    // Now the sync channel should exist
    expect(transport.channels.size).toBe(1)
  })

  it("detach removes the attached channel", () => {
    const dc = new MockDataChannel("open")
    transport.attachDataChannel("peer-1", dc)
    expect(transport.hasDataChannel("peer-1")).toBe(true)

    transport.detachDataChannel("peer-1")
    expect(transport.hasDataChannel("peer-1")).toBe(false)
    expect(transport.getAttachedPeerIds()).toEqual([])
  })

  it("detach cleans up event listeners", () => {
    const dc = new MockDataChannel("open")
    transport.attachDataChannel("peer-1", dc)
    expect(dc.hasListeners()).toBe(true)

    transport.detachDataChannel("peer-1")
    expect(dc.hasListeners()).toBe(false)
  })

  it("double-attach detaches old channel first", () => {
    const dc1 = new MockDataChannel("open")
    const dc2 = new MockDataChannel("open")

    transport.attachDataChannel("peer-1", dc1)
    transport.attachDataChannel("peer-1", dc2)

    // Old channel's listeners should be cleaned up
    expect(dc1.hasListeners()).toBe(false)
    // New channel should be attached
    expect(transport.hasDataChannel("peer-1")).toBe(true)
    expect(dc2.hasListeners()).toBe(true)
  })

  it("onStop detaches all channels", async () => {
    const dc1 = new MockDataChannel("open")
    const dc2 = new MockDataChannel("open")

    transport.attachDataChannel("peer-a", dc1)
    transport.attachDataChannel("peer-b", dc2)
    expect(transport.getAttachedPeerIds()).toHaveLength(2)

    await transport._stop()

    expect(transport.hasDataChannel("peer-a")).toBe(false)
    expect(transport.hasDataChannel("peer-b")).toBe(false)
    expect(dc1.hasListeners()).toBe(false)
    expect(dc2.hasListeners()).toBe(false)
  })

  it("cleanup function returned by attach calls detach", () => {
    const dc = new MockDataChannel("open")
    const cleanup = transport.attachDataChannel("peer-1", dc)

    expect(transport.hasDataChannel("peer-1")).toBe(true)
    cleanup()
    expect(transport.hasDataChannel("peer-1")).toBe(false)
  })

  it("detach is idempotent for unknown peer", () => {
    // Should not throw
    transport.detachDataChannel("nonexistent")
  })
})

// ---------------------------------------------------------------------------
// 2. Send
// ---------------------------------------------------------------------------

describe("Send", () => {
  let transport: WebrtcTransport

  beforeEach(async () => {
    transport = new WebrtcTransport()
    await initializeTransport(transport)
  })

  it("send encodes and delivers binary data via dc.send", () => {
    const dc = new MockDataChannel("open")
    transport.attachDataChannel("peer-1", dc)

    const syncChannel = [...transport.channels].find(
      ch => ch.type === "connected",
    )
    if (!syncChannel) throw new Error("expected syncChannel to be defined")

    syncChannel.send(TEST_MSG)

    expect(dc.send).toHaveBeenCalledOnce()
    expect(dc.send.mock.calls.at(0)?.at(0)).toBeInstanceOf(Uint8Array)
  })
})

// ---------------------------------------------------------------------------
// 3. Receive
// ---------------------------------------------------------------------------

describe("Receive", () => {
  let transport: WebrtcTransport
  let ctx: ReturnType<typeof createContext>

  beforeEach(async () => {
    transport = new WebrtcTransport()
    ctx = await initializeTransport(transport)
  })

  it("receive with ArrayBuffer data", () => {
    const dc = new MockDataChannel("open")
    transport.attachDataChannel("peer-1", dc)

    // Encode a test message through the wire pipeline
    const encoded = encodeComplete(cborCodec, TEST_MSG)

    // Convert to ArrayBuffer (as native RTCDataChannel with binaryType "arraybuffer" would deliver)
    const ab = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    )

    dc.emit("message", { data: ab })

    expect(ctx.onChannelReceive).toHaveBeenCalled()
    const callArgs = ctx.onChannelReceive.mock.calls.at(0)
    if (!callArgs)
      throw new Error("expected onChannelReceive to have been called")
    const [, receivedMsg] = callArgs
    expect(receivedMsg.type).toBe("establish")
    expect((receivedMsg as any).identity.peerId).toBe("remote")
  })

  it("receive with Uint8Array data", () => {
    const dc = new MockDataChannel("open")
    transport.attachDataChannel("peer-1", dc)

    const encoded = encodeComplete(cborCodec, TEST_MSG)

    // Pass Uint8Array directly (as simple-peer and other wrappers may deliver)
    dc.emit("message", { data: encoded })

    expect(ctx.onChannelReceive).toHaveBeenCalled()
    const callArgs = ctx.onChannelReceive.mock.calls.at(0)
    if (!callArgs)
      throw new Error("expected onChannelReceive to have been called")
    const [, receivedMsg] = callArgs
    expect(receivedMsg.type).toBe("establish")
    expect((receivedMsg as any).identity.peerId).toBe("remote")
  })

  it("receive ignores string data", () => {
    const dc = new MockDataChannel("open")
    transport.attachDataChannel("peer-1", dc)

    dc.emit("message", { data: "unexpected string" })

    expect(ctx.onChannelReceive).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 4. readyState
// ---------------------------------------------------------------------------

describe("readyState", () => {
  let transport: WebrtcTransport

  beforeEach(async () => {
    transport = new WebrtcTransport()
    await initializeTransport(transport)
  })

  it("sets binaryType on attach", () => {
    const dc = new MockDataChannel("open")
    expect(dc.binaryType).toBe("blob")

    transport.attachDataChannel("peer-1", dc)
    expect(dc.binaryType).toBe("arraybuffer")
  })

  it("send is no-op when readyState is not open", () => {
    const dc = new MockDataChannel("connecting")
    transport.attachDataChannel("peer-1", dc)
    dc.open()

    const syncChannel = [...transport.channels].find(
      ch => ch.type === "connected",
    )
    if (!syncChannel) throw new Error("expected syncChannel to be defined")

    // Simulate the channel transitioning to closing
    dc.readyState = "closing"

    syncChannel.send(TEST_MSG)
    expect(dc.send).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 5. Fragmentation
// ---------------------------------------------------------------------------

describe("Fragmentation", () => {
  it("fragments large messages", async () => {
    // Tiny threshold to force fragmentation on any message
    const transport = new WebrtcTransport({ fragmentThreshold: 200 })
    await initializeTransport(transport)

    const dc = new MockDataChannel("open")
    transport.attachDataChannel("peer-1", dc)

    const syncChannel = [...transport.channels].find(
      ch => ch.type === "connected",
    )
    if (!syncChannel) throw new Error("expected syncChannel to be defined")

    // Send a message — with a 200-byte threshold, even a small message's
    // binary frame may exceed it if the CBOR encoding + frame header is large enough.
    // Use a message with enough payload to guarantee fragmentation.
    const largeMsg: ChannelMsg = {
      type: "establish",
      identity: {
        peerId: `a]very-long-peer-id-${"x".repeat(200)}`,
        name: `A Long Name ${"y".repeat(200)}`,
        type: "user",
      },
    }

    syncChannel.send(largeMsg)

    // Should have been called more than once (multiple fragments)
    expect(dc.send.mock.calls.length).toBeGreaterThan(1)
  })

  it("reassembles fragmented incoming messages across multiple events", async () => {
    const transport = new WebrtcTransport()
    const ctx = await initializeTransport(transport)

    const dc = new MockDataChannel("open")
    transport.attachDataChannel("peer-1", dc)

    // Build a message large enough to guarantee multiple fragments at chunk size 50
    const largeMsg: ChannelMsg = {
      type: "establish",
      identity: {
        peerId: `peer-${"z".repeat(200)}`,
        name: `Name-${"w".repeat(200)}`,
        type: "user",
      },
    }

    const encoded = encodeComplete(cborCodec, largeMsg)
    const fragments = fragmentPayload(encoded, 50, 1)
    expect(fragments.length).toBeGreaterThan(1)

    // Emit all but the last fragment — should NOT trigger receive yet
    for (let i = 0; i < fragments.length - 1; i++) {
      const frag = fragments.at(i)
      if (!frag) throw new Error(`expected fragment at index ${i}`)
      const ab = frag.buffer.slice(
        frag.byteOffset,
        frag.byteOffset + frag.byteLength,
      )
      dc.emit("message", { data: ab })
    }
    expect(ctx.onChannelReceive).not.toHaveBeenCalled()

    // Emit the last fragment — should complete reassembly
    const lastFrag = fragments.at(-1)
    if (!lastFrag) throw new Error("expected last fragment to exist")
    const ab = lastFrag.buffer.slice(
      lastFrag.byteOffset,
      lastFrag.byteOffset + lastFrag.byteLength,
    )
    dc.emit("message", { data: ab })

    expect(ctx.onChannelReceive).toHaveBeenCalledTimes(1)
    const callArgs = ctx.onChannelReceive.mock.calls.at(0)
    if (!callArgs)
      throw new Error("expected onChannelReceive to have been called")
    const [, receivedMsg] = callArgs
    expect(receivedMsg.type).toBe("establish")
    expect((receivedMsg as any).identity.peerId).toBe(`peer-${"z".repeat(200)}`)
  })
})

// ---------------------------------------------------------------------------
// 6. Multi-peer
// ---------------------------------------------------------------------------

describe("Multi-peer", () => {
  let transport: WebrtcTransport

  beforeEach(async () => {
    transport = new WebrtcTransport()
    await initializeTransport(transport)
  })

  it("independent channels for different peers", () => {
    const dc1 = new MockDataChannel("open")
    const dc2 = new MockDataChannel("open")

    transport.attachDataChannel("peer-a", dc1)
    transport.attachDataChannel("peer-b", dc2)

    expect(transport.getAttachedPeerIds()).toContain("peer-a")
    expect(transport.getAttachedPeerIds()).toContain("peer-b")
    expect(transport.channels.size).toBe(2)

    const channels = [...transport.channels]
    const ch0 = channels.at(0)
    const ch1 = channels.at(1)
    if (!ch0) throw new Error("expected channel at index 0")
    if (!ch1) throw new Error("expected channel at index 1")
    ch0.send(TEST_MSG)
    ch1.send(TEST_MSG)

    // Each data channel received its own send call
    expect(dc1.send).toHaveBeenCalledOnce()
    expect(dc2.send).toHaveBeenCalledOnce()

    // Payloads are distinct Uint8Array instances (not shared references)
    const bytes1 = dc1.send.mock.calls.at(0)?.at(0) as Uint8Array
    const bytes2 = dc2.send.mock.calls.at(0)?.at(0) as Uint8Array
    expect(bytes1).not.toBe(bytes2)
  })
})

// ---------------------------------------------------------------------------
// 7. DataChannelLike conformance
// ---------------------------------------------------------------------------

describe("DataChannelLike conformance", () => {
  let transport: WebrtcTransport

  beforeEach(async () => {
    transport = new WebrtcTransport()
    await initializeTransport(transport)
  })

  it("works with a plain object literal", () => {
    const dc = {
      readyState: "open" as string,
      binaryType: "blob",
      send: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }

    // Should not throw
    transport.attachDataChannel("peer-1", dc)
    expect(transport.hasDataChannel("peer-1")).toBe(true)

    // binaryType should have been set
    expect(dc.binaryType).toBe("arraybuffer")

    // addEventListener should have been called for the 4 event types
    const eventTypes = dc.addEventListener.mock.calls.map(
      (call: any[]) => call[0],
    )
    expect(eventTypes).toContain("open")
    expect(eventTypes).toContain("close")
    expect(eventTypes).toContain("error")
    expect(eventTypes).toContain("message")
  })
})

// ---------------------------------------------------------------------------
// 8. Channel close event
// ---------------------------------------------------------------------------

describe("Message before open (race condition)", () => {
  it("silently drops messages received before sync channel is created", async () => {
    const transport = new WebrtcTransport()
    const ctx = await initializeTransport(transport)

    const dc = new MockDataChannel("connecting")
    transport.attachDataChannel("peer-1", dc)

    // Data channel is still connecting — no sync channel exists yet
    expect(transport.channels.size).toBe(0)

    // Simulate a message arriving before the open event
    const encoded = encodeComplete(cborCodec, TEST_MSG)
    dc.emit("message", { data: encoded })

    // Message should be silently dropped — no delivery, no error
    expect(ctx.onChannelReceive).not.toHaveBeenCalled()

    // Now open the channel — subsequent messages should work
    dc.open()
    expect(transport.channels.size).toBe(1)

    dc.emit("message", { data: encoded })
    expect(ctx.onChannelReceive).toHaveBeenCalledOnce()
  })
})

describe("Channel close event", () => {
  let transport: WebrtcTransport
  let ctx: ReturnType<typeof createContext>

  beforeEach(async () => {
    transport = new WebrtcTransport()
    ctx = await initializeTransport(transport)
  })

  it("removes sync channel when data channel fires close", () => {
    const dc = new MockDataChannel("open")
    transport.attachDataChannel("peer-1", dc)
    expect(transport.channels.size).toBe(1)

    dc.close()

    // The sync channel should be removed, but the attachment tracking remains
    // (the transport removes the internal sync channel but doesn't auto-detach)
    expect(transport.channels.size).toBe(0)
    expect(ctx.onChannelRemoved).toHaveBeenCalled()
  })

  it("removes sync channel when data channel fires error", () => {
    const dc = new MockDataChannel("open")
    transport.attachDataChannel("peer-1", dc)
    expect(transport.channels.size).toBe(1)

    dc.emit("error", new Error("connection failed"))

    expect(transport.channels.size).toBe(0)
    expect(ctx.onChannelRemoved).toHaveBeenCalled()
  })
})
