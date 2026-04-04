// parseTextPostBody tests.
//
// Tests the framework-agnostic POST handler (functional core):
// 1. Complete text frame body → returns decoded ChannelMsg[]
// 2. Fragment text frame body → returns pending, then complete on final fragment
// 3. Malformed body → returns error

import type { ChannelMsg } from "@kyneta/transport"
import {
  encodeTextComplete,
  fragmentTextPayload,
  TextReassembler,
  textCodec,
} from "@kyneta/wire"
import { describe, expect, it } from "vitest"
import { parseTextPostBody } from "../sse-handler.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const presentMsg: ChannelMsg = {
  type: "present",
  docs: [
    {
      docId: "doc-1",
      replicaType: ["plain", 1, 0] as const,
      mergeStrategy: "sequential" as const,
      schemaHash: "test-hash",
    },
    {
      docId: "doc-2",
      replicaType: ["plain", 1, 0] as const,
      mergeStrategy: "sequential" as const,
      schemaHash: "test-hash",
    },
  ],
}

const interestMsg: ChannelMsg = {
  type: "interest",
  docId: "doc-1",
  version: "v1",
  reciprocate: true,
}

function encodeAsTextFrame(msg: ChannelMsg): string {
  return encodeTextComplete(textCodec, msg)
}

// ---------------------------------------------------------------------------
// Complete frame
// ---------------------------------------------------------------------------

describe("parseTextPostBody — complete frame", () => {
  it("decodes a present message from a complete text frame", () => {
    const reassembler = new TextReassembler()
    const body = encodeAsTextFrame(presentMsg)

    const result = parseTextPostBody(reassembler, body)

    expect(result.type).toBe("messages")
    if (result.type !== "messages") throw new Error("unreachable")
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual(presentMsg)
    expect(result.response).toEqual({ status: 200, body: { ok: true } })

    reassembler.dispose()
  })

  it("decodes an interest message with all fields", () => {
    const reassembler = new TextReassembler()
    const body = encodeAsTextFrame(interestMsg)

    const result = parseTextPostBody(reassembler, body)

    expect(result.type).toBe("messages")
    if (result.type !== "messages") throw new Error("unreachable")
    expect(result.messages[0]).toEqual(interestMsg)

    reassembler.dispose()
  })
})

// ---------------------------------------------------------------------------
// Fragment frames
// ---------------------------------------------------------------------------

describe("parseTextPostBody — fragments", () => {
  it("returns pending for intermediate fragments, then complete on the last", () => {
    const reassembler = new TextReassembler()

    // Encode the message payload and fragment it into small chunks
    const payload = JSON.stringify(textCodec.encode(presentMsg))
    const fragments = fragmentTextPayload(payload, 20) // very small chunks

    expect(fragments.length).toBeGreaterThan(1)

    // All but the last fragment should return pending
    for (let i = 0; i < fragments.length - 1; i++) {
      const result = parseTextPostBody(reassembler, fragments[i]!)
      expect(result.type).toBe("pending")
      expect(result.response).toEqual({ status: 202, body: { pending: true } })
    }

    // The last fragment should complete and return messages
    const finalResult = parseTextPostBody(
      reassembler,
      fragments[fragments.length - 1]!,
    )
    expect(finalResult.type).toBe("messages")
    if (finalResult.type !== "messages") throw new Error("unreachable")
    expect(finalResult.messages).toHaveLength(1)
    expect(finalResult.messages[0]).toEqual(presentMsg)
    expect(finalResult.response).toEqual({ status: 200, body: { ok: true } })

    reassembler.dispose()
  })
})

// ---------------------------------------------------------------------------
// Malformed body
// ---------------------------------------------------------------------------

describe("parseTextPostBody — errors", () => {
  it("returns error for invalid JSON", () => {
    const reassembler = new TextReassembler()

    const result = parseTextPostBody(reassembler, "not valid json at all")

    expect(result.type).toBe("error")
    expect(result.response.status).toBe(400)

    reassembler.dispose()
  })

  it("returns error for valid JSON that is not a text frame", () => {
    const reassembler = new TextReassembler()

    const result = parseTextPostBody(reassembler, '{"type":"present"}')

    expect(result.type).toBe("error")
    expect(result.response.status).toBe(400)

    reassembler.dispose()
  })
})
