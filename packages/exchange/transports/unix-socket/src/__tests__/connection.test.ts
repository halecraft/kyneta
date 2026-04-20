// connection.test — unit tests for UnixSocketConnection.
//
// Tests the behavioral contracts of the connection:
// 1. Send produces valid binary frames (round-trip through StreamFrameParser)
// 2. Receive delivers decoded messages via channel.onReceive
// 3. Backpressure: write queue + drain flush + ordering
// 4. Close: idempotent, prevents further send/receive
// 5. Error resilience: invalid frames, missing channel
//
// Chunk-splitting scenarios (partial header, partial payload, boundary
// crossing) are NOT tested here — that's feedBytes's contract, thoroughly
// covered in stream-frame-parser.test.ts. The connection is a thin
// imperative shell over feedBytes; we test the glue, not the parser.

import { SYNC_AUTHORITATIVE } from "@kyneta/schema"
import type { ChannelMsg, PresentMsg } from "@kyneta/transport"
import {
  cborCodec,
  decodeBinaryFrame,
  encodeComplete,
  feedBytes,
  initialParserState,
} from "@kyneta/wire"
import { describe, expect, it, vi } from "vitest"
import { UnixSocketConnection } from "../connection.js"
import { MockUnixSocket } from "./mock-unix-socket.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePresent(docId: string): PresentMsg {
  return {
    type: "present",
    docs: [
      {
        docId,
        schemaHash: "00test",
        replicaType: ["plain", 1, 0] as const,
        syncProtocol: SYNC_AUTHORITATIVE,
      },
    ],
  }
}

function createMockChannel() {
  const received: ChannelMsg[] = []
  const channel = {
    channelId: 1,
    type: "connected" as const,
    onReceive: vi.fn((msg: ChannelMsg) => {
      received.push(msg)
    }),
    send: vi.fn(),
    meta: { transportType: "unix-socket-server" },
  }
  return { channel, received }
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const a of arrays) {
    result.set(a, offset)
    offset += a.length
  }
  return result
}

function createStartedConnection(socket?: MockUnixSocket) {
  const s = socket ?? new MockUnixSocket()
  const connection = new UnixSocketConnection("peer-1", 1, s)
  const { channel, received } = createMockChannel()
  connection._setChannel(channel as any)
  connection.start()
  return { socket: s, connection, channel, received }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UnixSocketConnection", () => {
  // ========================================================================
  // Send
  // ========================================================================

  it("send produces bytes that round-trip through StreamFrameParser", () => {
    const { socket, connection } = createStartedConnection()

    const msg = makePresent("doc-roundtrip")
    connection.send(msg)

    expect(socket.write).toHaveBeenCalledOnce()
    const writtenBytes = socket.write.mock.calls.at(0)?.at(0)
    if (!writtenBytes) throw new Error("expected written bytes")

    // Parse the written bytes through the same pipeline the receiver uses
    const result = feedBytes(initialParserState(), writtenBytes)
    expect(result.frames).toHaveLength(1)

    const frame = result.frames.at(0)
    if (!frame) throw new Error("expected a frame")
    const decoded = decodeBinaryFrame(frame)
    expect(decoded.content.kind).toBe("complete")
    if (decoded.content.kind === "complete") {
      const messages = cborCodec.decode(decoded.content.payload)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toEqual(msg)
    }
  })

  // ========================================================================
  // Receive
  // ========================================================================

  it("receive delivers decoded messages via channel.onReceive", () => {
    const { socket, received } = createStartedConnection()

    const msg = makePresent("doc-recv")
    socket.emitData(encodeComplete(cborCodec, msg))

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(msg)
  })

  it("receive handles multiple coalesced frames in one data event", () => {
    const { socket, received } = createStartedConnection()

    const msg1 = makePresent("doc-a")
    const msg2 = makePresent("doc-b")
    const combined = concat(
      encodeComplete(cborCodec, msg1),
      encodeComplete(cborCodec, msg2),
    )

    socket.emitData(combined)

    expect(received).toHaveLength(2)
    expect(received[0]).toEqual(msg1)
    expect(received[1]).toEqual(msg2)
  })

  it("receive delivers messages across separate data events", () => {
    const { socket, received } = createStartedConnection()

    const msgs = [makePresent("s1"), makePresent("s2"), makePresent("s3")]
    for (const msg of msgs) {
      socket.emitData(encodeComplete(cborCodec, msg))
    }

    expect(received).toHaveLength(3)
    for (let i = 0; i < 3; i++) {
      expect(received[i]).toEqual(msgs[i])
    }
  })

  // ========================================================================
  // Backpressure
  // ========================================================================

  it("queues frames when socket.write returns false, flushes on drain", () => {
    const socket = new MockUnixSocket()
    socket.setBackpressure(true)
    const { connection } = createStartedConnection(socket)

    const msg1 = makePresent("bp-1")
    const msg2 = makePresent("bp-2")
    const msg3 = makePresent("bp-3")

    // First write goes through but returns false → draining mode
    connection.send(msg1)
    expect(socket.write).toHaveBeenCalledTimes(1)

    // Subsequent writes are queued, not sent
    connection.send(msg2)
    connection.send(msg3)
    expect(socket.write).toHaveBeenCalledTimes(1)

    // Drain: release backpressure and fire event
    socket.setBackpressure(false)
    socket.emitDrain()

    // Both queued frames flushed
    expect(socket.write).toHaveBeenCalledTimes(3)
  })

  it("drain flushes queued frames in send order", () => {
    const socket = new MockUnixSocket()
    socket.setBackpressure(true)
    const { connection } = createStartedConnection(socket)

    const msg1 = makePresent("order-1")
    const msg2 = makePresent("order-2")

    connection.send(msg1)
    connection.send(msg2) // queued

    socket.setBackpressure(false)
    socket.emitDrain()

    expect(socket.write).toHaveBeenCalledTimes(2)

    // Verify second write is msg2 (not msg1 again)
    const secondWriteBytes = socket.write.mock.calls.at(1)?.at(0)
    expect(secondWriteBytes).toEqual(encodeComplete(cborCodec, msg2))
  })

  it("drain during flush: stops if write returns false again", () => {
    const socket = new MockUnixSocket()
    socket.setBackpressure(true)
    const { connection } = createStartedConnection(socket)

    const msg1 = makePresent("re-1")
    const msg2 = makePresent("re-2")
    const msg3 = makePresent("re-3")

    // First send goes through (returns false), others queued
    connection.send(msg1)
    connection.send(msg2)
    connection.send(msg3)
    expect(socket.write).toHaveBeenCalledTimes(1)

    // First drain: allow one write then re-trigger backpressure
    let drainWriteCount = 0
    socket.write.mockImplementation(() => {
      drainWriteCount++
      if (drainWriteCount === 1) {
        // First flush write succeeds, but the second will fail
        return true
      }
      // Second flush write hits backpressure again
      return false
    })

    socket.emitDrain()

    // Should have written msg2 (success) then attempted msg3 (backpressure)
    // Total: 1 (original) + 2 (flush attempts) = 3
    expect(socket.write).toHaveBeenCalledTimes(3)

    // msg3 should still be in the queue — send it on next drain
    socket.write.mockImplementation(() => true)
    socket.emitDrain()

    // Now msg3 should be flushed
    expect(socket.write).toHaveBeenCalledTimes(4)
  })

  // ========================================================================
  // Close
  // ========================================================================

  it("close calls socket.end and prevents further sends", () => {
    const { socket, connection } = createStartedConnection()

    connection.close()

    expect(socket.end).toHaveBeenCalledOnce()
    socket.write.mockClear()

    connection.send(makePresent("after-close"))
    expect(socket.write).not.toHaveBeenCalled()
  })

  it("close prevents further receive delivery", () => {
    const { socket, connection, received } = createStartedConnection()

    connection.close()

    socket.emitData(encodeComplete(cborCodec, makePresent("after-close")))
    expect(received).toHaveLength(0)
  })

  it("close is idempotent", () => {
    const { socket, connection } = createStartedConnection()

    connection.close()
    connection.close()

    expect(socket.end).toHaveBeenCalledOnce()
  })

  it("start is idempotent — does not double-register handlers", () => {
    const socket = new MockUnixSocket()
    const connection = new UnixSocketConnection("peer-1", 1, socket)
    const { channel } = createMockChannel()
    connection._setChannel(channel as any)

    connection.start()
    connection.start()

    expect(socket.handlerCount("data")).toBe(1)
    expect(socket.handlerCount("drain")).toBe(1)
  })

  // ========================================================================
  // Error resilience
  // ========================================================================

  it("logs error and continues when frame contains invalid CBOR", () => {
    const { socket, received } = createStartedConnection()
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    // Valid 7-byte header with payloadLength=13, followed by garbage payload
    const garbage = new Uint8Array(20)
    const view = new DataView(garbage.buffer)
    view.setUint8(0, 0) // version
    view.setUint8(1, 0x00) // type COMPLETE
    view.setUint8(2, 0x00) // hash NONE
    view.setUint32(3, 13, false) // payload length
    for (let i = 7; i < 20; i++) garbage[i] = 0xff

    socket.emitData(garbage)

    expect(consoleSpy).toHaveBeenCalled()
    expect(received).toHaveLength(0)

    // Connection still works after the error
    socket.emitData(encodeComplete(cborCodec, makePresent("after-error")))
    expect(received).toHaveLength(1)

    consoleSpy.mockRestore()
  })

  it("logs error when message arrives with no channel set", () => {
    const socket = new MockUnixSocket()
    const connection = new UnixSocketConnection("peer-1", 1, socket)
    // Deliberately do NOT call _setChannel
    connection.start()

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    socket.emitData(encodeComplete(cborCodec, makePresent("no-channel")))

    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})
