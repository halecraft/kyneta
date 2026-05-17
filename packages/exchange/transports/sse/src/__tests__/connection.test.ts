// SseConnection tests.

import { SYNC_AUTHORITATIVE } from "@kyneta/schema"
import type { ChannelMsg } from "@kyneta/transport"
import { Pipeline } from "@kyneta/transport"
import { complete, encodeBinaryFrame, WIRE_VERSION } from "@kyneta/wire"
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

/**
 * Encode a ChannelMsg into binary frame bytes via Pipeline<"binary">.
 * This simulates what the client sends over POST.
 */
function encodeToBinaryFrame(msg: ChannelMsg): Uint8Array<ArrayBuffer> {
  const pipeline = new Pipeline({ send: "binary" })
  const results = pipeline.send(msg)
  pipeline.dispose()
  const r = results[0]
  if (!r || !r.ok) throw new Error("Failed to encode message via pipeline")
  return r.value
}

const presentMsg: ChannelMsg = {
  type: "present",
  docs: [
    {
      docId: "doc-1",
      replicaType: ["plain", 1, 0] as const,
      syncProtocol: SYNC_AUTHORITATIVE,
      schemaHash: "test-hash",
    },
    {
      docId: "doc-2",
      replicaType: ["plain", 1, 0] as const,
      syncProtocol: SYNC_AUTHORITATIVE,
      schemaHash: "test-hash",
    },
  ],
}

// ---------------------------------------------------------------------------
// send()
// ---------------------------------------------------------------------------

describe("SseConnection — send", () => {
  it("encodes a ChannelMsg to a valid text frame and calls sendFn", () => {
    const conn = createConnection()
    const sent: string[] = []
    conn.setSendFunction(textFrame => sent.push(textFrame))
    conn._setChannel(createMockChannel() as any)

    conn.send(presentMsg)

    expect(sent).toHaveLength(1)

    // Verify the sent text frame can be decoded back via Pipeline<"text">
    const recvPipeline = new Pipeline({ send: "text" })
    const sentFrame = sent.at(0)
    if (!sentFrame) throw new Error("expected sent frame")
    const results = recvPipeline.receive(sentFrame)
    recvPipeline.dispose()
    expect(results).toHaveLength(1)
    const r = results[0]
    if (!r || !r.ok) throw new Error("expected successful decode")
    expect(r.value).toEqual(presentMsg)
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

    expect(sent).toHaveLength(1)
  })

  it("fragments into multiple sendFn calls when above threshold", () => {
    const conn = createConnection({ fragmentThreshold: 20 })
    const sent: string[] = []
    conn.setSendFunction(textFrame => sent.push(textFrame))
    conn._setChannel(createMockChannel() as any)

    conn.send(presentMsg)

    expect(sent.length).toBeGreaterThan(1)
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
// receive()
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
// handlePostBody
// ---------------------------------------------------------------------------

describe("SseConnection — handlePostBody", () => {
  it("decodes a complete binary frame to messages", () => {
    const conn = createConnection()

    const frameBytes = encodeToBinaryFrame(presentMsg)
    const result = conn.handlePostBody(frameBytes)

    expect(result.type).toBe("messages")
    if (result.type !== "messages") throw new Error("expected messages")
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual(presentMsg)
    expect(result.response).toEqual({ status: 200, body: { ok: true } })
  })

  it("resolves docId aliases across messages", () => {
    const conn = createConnection()

    // First message: present (establishes alias bindings)
    const presentBytes = encodeToBinaryFrame(presentMsg)
    const presentResult = conn.handlePostBody(presentBytes)
    expect(presentResult.type).toBe("messages")
    if (presentResult.type !== "messages") throw new Error("expected messages")
    expect(presentResult.messages[0]).toEqual(presentMsg)

    // Second message: interest using the alias established by present.
    // To build this, we use the same pipeline so its alias table is in sync.
    const sendPipeline = new Pipeline({ send: "binary" })
    // Send the present first to establish alias bindings in the send pipeline
    sendPipeline.send(presentMsg)
    // Now send an interest for the first doc
    const interestMsg: ChannelMsg = {
      type: "interest",
      docId: "doc-1",
    }
    const interestResults = sendPipeline.send(interestMsg)
    sendPipeline.dispose()
    const interestFrame = interestResults[0]
    if (!interestFrame || !interestFrame.ok)
      throw new Error("expected interest frame")

    const interestResult = conn.handlePostBody(interestFrame.value)
    expect(interestResult.type).toBe("messages")
    if (interestResult.type !== "messages") throw new Error("expected messages")
    expect(interestResult.messages).toHaveLength(1)

    const decoded = interestResult.messages[0]
    if (!decoded) throw new Error("expected interest message")
    expect(decoded.type).toBe("interest")
    if (decoded.type !== "interest") throw new Error("expected interest")
    expect(decoded.docId).toBe("doc-1")
  })

  it("returns error on malformed binary input", () => {
    const conn = createConnection()

    // Garbage bytes that aren't a valid binary frame
    const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff])
    const result = conn.handlePostBody(garbage)

    expect(result.type).toBe("error")
    expect(result.response.status).toBe(400)
    conn.dispose()
  })

  it("returns error (not pending) on malformed CBOR payload", () => {
    const conn = new SseConnection("peer-err", 1)
    // Construct a structurally valid binary frame wrapping garbage CBOR.
    // The frame parser accepts it (valid header), but CBOR decode fails.
    const garbageCbor = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc])
    const frame = encodeBinaryFrame(complete(WIRE_VERSION, garbageCbor))

    const result = conn.handlePostBody(frame)
    expect(result.type).toBe("error")
    expect(result.response.status).toBe(400)
    conn.dispose()
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
