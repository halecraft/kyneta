// SseConnection tests.
//
// Tests the core behavioral contracts:
// 1. send() encodes a ChannelMsg to a decodable text frame and calls sendFn
// 2. send() fragments large messages into multiple sendFn calls
// 3. receive() routes messages to the channel's onReceive
// 4. Guard: send() throws if sendFn not set
// 5. Guard: receive() throws if channel not set

import type { ChannelMsg } from "@kyneta/exchange"
import { decodeTextFrame, textCodec } from "@kyneta/wire"
import { describe, expect, it, vi } from "vitest"
import { SseConnection } from "../connection.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConnection(config?: { fragmentThreshold?: number }) {
  const conn = new SseConnection("test-peer", 1, config)
  return conn
}

function createMockChannel() {
  return {
    channelId: 1,
    onReceive: vi.fn(),
    send: vi.fn(),
    type: "connected" as const,
    transportType: "sse-server",
  }
}

const presentMsg: ChannelMsg = {
  type: "present",
  docs: [
    { docId: "doc-1", replicaType: ["plain", 1, 0] as const, mergeStrategy: "sequential" as const },
    { docId: "doc-2", replicaType: ["plain", 1, 0] as const, mergeStrategy: "sequential" as const },
  ],
}

const establishMsg: ChannelMsg = {
  type: "establish-request",
  identity: { peerId: "peer-1", name: "Peer 1", type: "user" },
}

// ---------------------------------------------------------------------------
// send() — encoding round-trip
// ---------------------------------------------------------------------------

describe("SseConnection — send", () => {
  it("encodes a ChannelMsg to a valid text frame and calls sendFn", () => {
    const conn = createConnection()
    const sent: string[] = []
    conn.setSendFunction(textFrame => sent.push(textFrame))
    conn._setChannel(createMockChannel() as any)

    conn.send(presentMsg)

    expect(sent).toHaveLength(1)

    // The sent string should be a valid text frame that round-trips
    const frame = decodeTextFrame(sent[0]!)
    expect(frame.content.kind).toBe("complete")
    const parsed = JSON.parse(frame.content.payload)
    const decoded = textCodec.decode(parsed)
    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toEqual(presentMsg)
  })

  it("round-trips establish-request with identity", () => {
    const conn = createConnection()
    const sent: string[] = []
    conn.setSendFunction(textFrame => sent.push(textFrame))
    conn._setChannel(createMockChannel() as any)

    conn.send(establishMsg)

    const frame = decodeTextFrame(sent[0]!)
    const decoded = textCodec.decode(JSON.parse(frame.content.payload))
    expect(decoded[0]).toEqual(establishMsg)
  })

  it("throws if sendFn not set", () => {
    const conn = createConnection()
    conn._setChannel(createMockChannel() as any)

    expect(() => conn.send(presentMsg)).toThrow(
      "Cannot send message: send function not set",
    )
  })
})

// ---------------------------------------------------------------------------
// send() — fragmentation
// ---------------------------------------------------------------------------

describe("SseConnection — fragmentation", () => {
  it("sends a single text frame when below threshold", () => {
    const conn = createConnection({ fragmentThreshold: 100_000 })
    const sent: string[] = []
    conn.setSendFunction(textFrame => sent.push(textFrame))
    conn._setChannel(createMockChannel() as any)

    conn.send(presentMsg)

    // Small message → single call
    expect(sent).toHaveLength(1)
    // Should be a complete frame (starts with ["0c",...])
    expect(sent[0]).toContain('"0c"')
  })

  it("fragments into multiple sendFn calls when above threshold", () => {
    // Use a very low threshold to force fragmentation on a normal message
    const conn = createConnection({ fragmentThreshold: 20 })
    const sent: string[] = []
    conn.setSendFunction(textFrame => sent.push(textFrame))
    conn._setChannel(createMockChannel() as any)

    conn.send(presentMsg)

    // Should produce multiple fragments
    expect(sent.length).toBeGreaterThan(1)
    // Each fragment should be a fragment frame (contains "0f" prefix)
    for (const frame of sent) {
      expect(frame).toContain('"0f"')
    }
  })

  it("does not fragment when threshold is 0 (disabled)", () => {
    const conn = createConnection({ fragmentThreshold: 0 })
    const sent: string[] = []
    conn.setSendFunction(textFrame => sent.push(textFrame))
    conn._setChannel(createMockChannel() as any)

    conn.send(presentMsg)

    expect(sent).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// receive() — delivery
// ---------------------------------------------------------------------------

describe("SseConnection — receive", () => {
  it("delivers a ChannelMsg to the channel onReceive", () => {
    const conn = createConnection()
    const channel = createMockChannel()
    conn._setChannel(channel as any)

    conn.receive(presentMsg)

    expect(channel.onReceive).toHaveBeenCalledTimes(1)
    expect(channel.onReceive).toHaveBeenCalledWith(presentMsg)
  })

  it("throws if channel not set", () => {
    const conn = createConnection()

    expect(() => conn.receive(presentMsg)).toThrow(
      "Cannot receive message: channel not set",
    )
  })
})

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe("SseConnection — dispose", () => {
  it("can be called without error", () => {
    const conn = createConnection()
    expect(() => conn.dispose()).not.toThrow()
  })
})
