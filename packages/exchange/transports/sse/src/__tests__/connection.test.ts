// SseConnection tests.

import { SYNC_AUTHORITATIVE } from "@kyneta/schema"
import type { ChannelMsg } from "@kyneta/transport"
import type { WireInterestMsg } from "@kyneta/wire"
import {
  applyInboundAliasing,
  applyOutboundAliasing,
  complete,
  decodeTextFrame,
  decodeTextWireMessage,
  emptyAliasState,
  encodeTextFrame,
  encodeTextWireMessage,
  fragmentTextPayload,
  MessageType,
  TEXT_WIRE_VERSION,
} from "@kyneta/wire"
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
 * Encode a ChannelMsg into a text frame string via the alias-aware pipeline.
 */
function encodeToTextFrame(msg: ChannelMsg): string {
  const { wire } = applyOutboundAliasing(emptyAliasState(), msg)
  const payload = JSON.stringify(encodeTextWireMessage(wire))
  return encodeTextFrame(complete(TEXT_WIRE_VERSION, payload))
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

    const sentFrame = sent.at(0)
    if (!sentFrame) throw new Error("expected sent frame")
    const frame = decodeTextFrame(sentFrame)
    expect(frame.content.kind).toBe("complete")
    const parsed = JSON.parse(frame.content.payload)
    const wire = decodeTextWireMessage(parsed)
    const decoded = applyInboundAliasing(emptyAliasState(), wire)
    expect(decoded.error).toBeUndefined()
    expect(decoded.msg).toEqual(presentMsg)
  })

  it("sends messages with short field names (alias-form wire format)", () => {
    const conn = createConnection()
    const sent: string[] = []
    conn.setSendFunction(textFrame => sent.push(textFrame))
    conn._setChannel(createMockChannel() as any)

    conn.send(presentMsg)

    const sentFrame = sent.at(0)
    if (!sentFrame) throw new Error("expected sent frame")
    const frame = decodeTextFrame(sentFrame)
    const payload = JSON.parse(frame.content.payload) as Record<string, unknown>

    // The alias-aware pipeline uses compact integer discriminators and
    // short field names, not the long-name human-readable format.
    expect(payload.t).toBe(MessageType.Present)
    expect(payload.docs).toBeInstanceOf(Array)
    const doc = (payload.docs as Array<Record<string, unknown>>)[0]
    if (!doc) throw new Error("expected doc entry")
    expect(doc.d).toBe("doc-1")
    expect(doc.sh).toBe("test-hash")
    // No long-name fields from the old textCodec format
    expect(doc.docId).toBeUndefined()
    expect(doc.schemaHash).toBeUndefined()
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
    expect(sent[0]).toContain('"1c"')
  })

  it("fragments into multiple sendFn calls when above threshold", () => {
    const conn = createConnection({ fragmentThreshold: 20 })
    const sent: string[] = []
    conn.setSendFunction(textFrame => sent.push(textFrame))
    conn._setChannel(createMockChannel() as any)

    conn.send(presentMsg)

    expect(sent.length).toBeGreaterThan(1)
    for (const frame of sent) {
      expect(frame).toContain('"1f"')
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
  it("decodes a complete frame to messages", () => {
    const conn = createConnection()

    const textFrame = encodeToTextFrame(presentMsg)
    const result = conn.handlePostBody(textFrame)

    expect(result.type).toBe("messages")
    if (result.type !== "messages") throw new Error("expected messages")
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual(presentMsg)
    expect(result.response).toEqual({ status: 200, body: { ok: true } })
  })

  it("skips messages with alias resolution errors, continues processing", () => {
    const conn = createConnection()

    // An interest with an unresolved dx alias will fail alias resolution.
    // The connection should skip it (not throw, not break) and return
    // an empty messages array with a 200 (no fatal error).
    const unresolvedInterest: WireInterestMsg = {
      t: MessageType.Interest,
      dx: 999,
    }
    const payload = JSON.stringify(encodeTextWireMessage(unresolvedInterest))
    const textFrame = encodeTextFrame(complete(TEXT_WIRE_VERSION, payload))

    const result = conn.handlePostBody(textFrame)

    expect(result.type).toBe("messages")
    if (result.type !== "messages") throw new Error("expected messages")
    expect(result.messages).toHaveLength(0)
    expect(result.response).toEqual({ status: 200, body: { ok: true } })
  })

  it("reassembles fragmented payloads", () => {
    const conn = createConnection()

    const { wire } = applyOutboundAliasing(emptyAliasState(), presentMsg)
    const payload = JSON.stringify(encodeTextWireMessage(wire))
    const fragments = fragmentTextPayload(payload, 50, 42)

    expect(fragments.length).toBeGreaterThan(1)

    for (let i = 0; i < fragments.length - 1; i++) {
      const fragment = fragments.at(i)
      if (fragment === undefined) throw new Error(`missing fragment ${i}`)
      const result = conn.handlePostBody(fragment)
      expect(result.type).toBe("pending")
      if (result.type === "pending") {
        expect(result.response).toEqual({
          status: 202,
          body: { pending: true },
        })
      }
    }

    const lastFragment = fragments.at(fragments.length - 1)
    if (lastFragment === undefined) throw new Error("missing last fragment")
    const finalResult = conn.handlePostBody(lastFragment)

    expect(finalResult.type).toBe("messages")
    if (finalResult.type !== "messages") throw new Error("expected messages")
    expect(finalResult.messages).toHaveLength(1)
    expect(finalResult.messages[0]).toEqual(presentMsg)
  })

  it("resolves docId aliases across messages", () => {
    const conn = createConnection()

    const { wire: presentWire } = applyOutboundAliasing(
      emptyAliasState(),
      presentMsg,
    )
    const presentPayload = JSON.stringify(encodeTextWireMessage(presentWire))
    const presentFrame = encodeTextFrame(
      complete(TEXT_WIRE_VERSION, presentPayload),
    )

    const presentResult = conn.handlePostBody(presentFrame)
    expect(presentResult.type).toBe("messages")
    if (presentResult.type !== "messages") throw new Error("expected messages")
    expect(presentResult.messages[0]).toEqual(presentMsg)

    const docAlias = (presentWire as { docs: Array<{ a?: number }> }).docs[0]?.a
    if (docAlias === undefined) throw new Error("expected doc alias assignment")

    const interestWire: WireInterestMsg = {
      t: MessageType.Interest,
      dx: docAlias,
    }
    const interestPayload = JSON.stringify(encodeTextWireMessage(interestWire))
    const interestFrame = encodeTextFrame(
      complete(TEXT_WIRE_VERSION, interestPayload),
    )

    const interestResult = conn.handlePostBody(interestFrame)
    expect(interestResult.type).toBe("messages")
    if (interestResult.type !== "messages") throw new Error("expected messages")
    expect(interestResult.messages).toHaveLength(1)

    const interestMsg = interestResult.messages[0]
    if (!interestMsg) throw new Error("expected interest message")
    expect(interestMsg.type).toBe("interest")
    if (interestMsg.type !== "interest") throw new Error("expected interest")
    expect(interestMsg.docId).toBe("doc-1")
  })

  it("returns error on malformed JSON input", () => {
    const conn = createConnection()

    const result = conn.handlePostBody("not json")

    expect(result.type).toBe("error")
    if (result.type === "error") {
      expect(result.response.status).toBe(400)
    }
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
