// binary-helpers — tests for shared binary transport encode/decode helpers.
//
// Tests the two shared pipelines that every binary transport uses:
// - encodeBinaryAndSend: encode → optional fragment → sendFn per piece
// - decodeBinaryMessages: reassemble → decode → ChannelMsg[] | null

import type { ChannelMsg } from "@kyneta/exchange"
import { describe, expect, it, vi } from "vitest"
import {
  decodeBinaryMessages,
  encodeBinaryAndSend,
  FragmentReassembler,
} from "../index.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SMALL_MSG: ChannelMsg = {
  type: "establish-request",
  identity: { peerId: "test", name: "Test", type: "user" },
}

const LARGE_MSG: ChannelMsg = {
  type: "offer",
  docId: "doc-1",
  payload: { kind: "entirety", encoding: "binary", data: new Uint8Array(300_000) },
  version: "1",
}

// ---------------------------------------------------------------------------
// encodeBinaryAndSend
// ---------------------------------------------------------------------------

describe("encodeBinaryAndSend", () => {
  it("calls sendFn exactly once for a small message", () => {
    const sendFn = vi.fn()
    encodeBinaryAndSend(SMALL_MSG, 100_000, sendFn)

    expect(sendFn).toHaveBeenCalledTimes(1)
    expect(sendFn.mock.calls[0]![0]).toBeInstanceOf(Uint8Array)
  })

  it("fragments a large message when payload exceeds threshold", () => {
    const sendFn = vi.fn()
    encodeBinaryAndSend(LARGE_MSG, 100_000, sendFn)

    expect(sendFn.mock.calls.length).toBeGreaterThan(1)
    for (const [data] of sendFn.mock.calls) {
      expect(data).toBeInstanceOf(Uint8Array)
    }
  })

  it("disables fragmentation when threshold is 0", () => {
    const sendFn = vi.fn()
    encodeBinaryAndSend(LARGE_MSG, 0, sendFn)

    expect(sendFn).toHaveBeenCalledTimes(1)
    expect(sendFn.mock.calls[0]![0]).toBeInstanceOf(Uint8Array)
  })
})

// ---------------------------------------------------------------------------
// decodeBinaryMessages
// ---------------------------------------------------------------------------

describe("decodeBinaryMessages", () => {
  it("round-trips a small message through encode and decode", () => {
    const sent: Uint8Array[] = []
    encodeBinaryAndSend(SMALL_MSG, 100_000, data => sent.push(data))

    expect(sent).toHaveLength(1)

    const reassembler = new FragmentReassembler({ timeoutMs: 5000 })
    const result = decodeBinaryMessages(sent[0]!, reassembler)

    expect(result).not.toBeNull()
    expect(result).toHaveLength(1)
    expect(result![0]!.type).toBe("establish-request")
    expect((result![0] as { identity: { peerId: string } }).identity.peerId).toBe("test")
    reassembler.dispose()
  })

  it("returns null for pending fragments", () => {
    const sent: Uint8Array[] = []
    encodeBinaryAndSend(LARGE_MSG, 100_000, data => sent.push(data))

    expect(sent.length).toBeGreaterThan(1)

    const reassembler = new FragmentReassembler({ timeoutMs: 5000 })

    // Feed only the first fragment — should return null (pending)
    const pending = decodeBinaryMessages(sent[0]!, reassembler)
    expect(pending).toBeNull()

    // Feed the remaining fragments; the last one should return the decoded messages
    let result: ChannelMsg[] | null = null
    for (let i = 1; i < sent.length; i++) {
      result = decodeBinaryMessages(sent[i]!, reassembler)
      if (i < sent.length - 1) {
        expect(result).toBeNull()
      }
    }

    expect(result).not.toBeNull()
    expect(result).toHaveLength(1)
    expect(result![0]!.type).toBe("offer")
    expect((result![0] as { docId: string }).docId).toBe("doc-1")
    reassembler.dispose()
  })

  it("throws on garbage bytes", () => {
    const reassembler = new FragmentReassembler({ timeoutMs: 5000 })
    const garbage = new Uint8Array([0xff, 0xde, 0xad, 0xbe, 0xef])

    expect(() => decodeBinaryMessages(garbage, reassembler)).toThrow()
    reassembler.dispose()
  })
})