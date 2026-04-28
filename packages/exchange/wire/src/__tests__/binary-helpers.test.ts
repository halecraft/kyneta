// binary-helpers — tests for shared binary transport encode/decode helpers.
//
// Tests the two shared pipelines that every binary transport uses:
// - encodeBinaryAndSend: encode → optional fragment → sendFn per piece
// - decodeBinaryMessages: reassemble → decode → ChannelMsg[] | null

import type { ChannelMsg } from "@kyneta/transport"
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
  type: "establish",
  identity: { peerId: "test", name: "Test", type: "user" },
}

const LARGE_MSG: ChannelMsg = {
  type: "offer",
  docId: "doc-1",
  payload: {
    kind: "entirety",
    encoding: "binary",
    data: new Uint8Array(300_000),
  },
  version: "1",
}

// ---------------------------------------------------------------------------
// encodeBinaryAndSend
// ---------------------------------------------------------------------------

describe("encodeBinaryAndSend", () => {
  it("calls sendFn exactly once for a small message", () => {
    const sendFn = vi.fn()
    let frameId = 0
    encodeBinaryAndSend(SMALL_MSG, sendFn, 100_000, () => frameId++)

    expect(sendFn).toHaveBeenCalledTimes(1)
    expect(sendFn.mock.calls.at(0)?.[0]).toBeInstanceOf(Uint8Array)
  })

  it("fragments a large message when payload exceeds threshold", () => {
    const sendFn = vi.fn()
    let frameId = 0
    encodeBinaryAndSend(LARGE_MSG, sendFn, 100_000, () => frameId++)

    expect(sendFn.mock.calls.length).toBeGreaterThan(1)
    for (const [data] of sendFn.mock.calls) {
      expect(data).toBeInstanceOf(Uint8Array)
    }
  })

  it("disables fragmentation when threshold is 0", () => {
    const sendFn = vi.fn()
    let frameId = 0
    encodeBinaryAndSend(LARGE_MSG, sendFn, 0, () => frameId++)

    expect(sendFn).toHaveBeenCalledTimes(1)
    expect(sendFn.mock.calls.at(0)?.[0]).toBeInstanceOf(Uint8Array)
  })
})

// ---------------------------------------------------------------------------
// decodeBinaryMessages
// ---------------------------------------------------------------------------

describe("decodeBinaryMessages", () => {
  it("round-trips a small message through encode and decode", () => {
    const sent: Uint8Array[] = []
    let frameId = 0
    encodeBinaryAndSend(
      SMALL_MSG,
      data => sent.push(data),
      100_000,
      () => frameId++,
    )

    expect(sent).toHaveLength(1)

    const reassembler = new FragmentReassembler({ timeoutMs: 5000 })
    const first = sent.at(0)
    if (!first) throw new Error("expected at least one sent buffer")
    const result = decodeBinaryMessages(first, reassembler)

    expect(result).not.toBeNull()
    if (!result) throw new Error("expected non-null result")
    expect(result).toHaveLength(1)
    const msg0 = result.at(0)
    if (!msg0) throw new Error("expected at least one decoded message")
    expect(msg0.type).toBe("establish")
    expect((msg0 as { identity: { peerId: string } }).identity.peerId).toBe(
      "test",
    )
    reassembler.dispose()
  })

  it("returns null for pending fragments", () => {
    const sent: Uint8Array[] = []
    let frameId = 0
    encodeBinaryAndSend(
      LARGE_MSG,
      data => sent.push(data),
      100_000,
      () => frameId++,
    )

    expect(sent.length).toBeGreaterThan(1)

    const reassembler = new FragmentReassembler({ timeoutMs: 5000 })

    // Feed only the first fragment — should return null (pending)
    const firstFrag = sent.at(0)
    if (!firstFrag) throw new Error("expected at least one sent fragment")
    const pending = decodeBinaryMessages(firstFrag, reassembler)
    expect(pending).toBeNull()

    // Feed the remaining fragments; the last one should return the decoded messages
    let result: ChannelMsg[] | null = null
    for (let i = 1; i < sent.length; i++) {
      const frag = sent.at(i)
      if (!frag) throw new Error(`expected sent fragment at index ${i}`)
      result = decodeBinaryMessages(frag, reassembler)
      if (i < sent.length - 1) {
        expect(result).toBeNull()
      }
    }

    expect(result).not.toBeNull()
    if (!result) throw new Error("expected non-null result after all fragments")
    expect(result).toHaveLength(1)
    const msg0 = result.at(0)
    if (!msg0) throw new Error("expected at least one decoded message")
    expect(msg0.type).toBe("offer")
    expect((msg0 as { docId: string }).docId).toBe("doc-1")
    reassembler.dispose()
  })

  it("throws on garbage bytes", () => {
    const reassembler = new FragmentReassembler({ timeoutMs: 5000 })
    const garbage = new Uint8Array([0xff, 0xde, 0xad, 0xbe, 0xef])

    expect(() => decodeBinaryMessages(garbage, reassembler)).toThrow()
    reassembler.dispose()
  })
})
