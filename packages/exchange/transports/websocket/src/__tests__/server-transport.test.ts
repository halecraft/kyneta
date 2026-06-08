// server-transport — tests for graceful drain and the stop-accepting guard.
//
// The pure schedule is covered in drain.test.ts; here we drive the imperative
// shell with fake timers, a mock Socket, and a pinned randomFn.

import { createTestTransportContext } from "@kyneta/transport/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WebsocketServerTransport } from "../server-transport.js"
import { createMockSocket } from "./mock-socket.js"

async function startedTransport(): Promise<WebsocketServerTransport> {
  const transport = new WebsocketServerTransport()
  await transport._initialize(createTestTransportContext())
  await transport._start()
  return transport
}

describe("WebsocketServerTransport — drainConnections", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns immediately when there are no connections", async () => {
    const transport = await startedTransport()
    const result = await transport.drainConnections()
    expect(result).toEqual({ closed: 0, remaining: 0, timedOut: false })
  })

  it("closes all connections within the window and resolves with no stragglers", async () => {
    const transport = await startedTransport()
    const sockets = [createMockSocket(), createMockSocket(), createMockSocket()]
    for (const socket of sockets) transport.handleConnection({ socket })
    expect(transport.connectionCount).toBe(3)

    // random=0 → all scheduled at offset 0; close() fires onClose → unregister.
    const p = transport.drainConnections({ windowMs: 3000, randomFn: () => 0 })
    await vi.advanceTimersByTimeAsync(3000)
    const result = await p

    expect(result).toEqual({ closed: 3, remaining: 0, timedOut: false })
    expect(transport.connectionCount).toBe(0)
    for (const socket of sockets) expect(socket.readyState).toBe("closed")
  })

  it("times out and reports stragglers when sockets never acknowledge the close", async () => {
    const transport = await startedTransport()
    // These sockets flip to "closed" but never fire onClose → never unregister.
    for (let i = 0; i < 2; i++) {
      transport.handleConnection({
        socket: createMockSocket({ fireCloseOnClose: false }),
      })
    }
    expect(transport.connectionCount).toBe(2)

    const p = transport.drainConnections({
      windowMs: 1000,
      deadlineMs: 4000,
      randomFn: () => 0,
    })
    await vi.advanceTimersByTimeAsync(4000)
    const result = await p

    expect(result).toEqual({ closed: 0, remaining: 2, timedOut: true })
  })

  it("refuses new connections during a drain (stop-accepting backstop)", async () => {
    const transport = await startedTransport()
    transport.handleConnection({ socket: createMockSocket() })
    expect(transport.connectionCount).toBe(1)

    // Start the drain but do not advance timers — it stays in progress.
    const p = transport.drainConnections({ windowMs: 1000, randomFn: () => 0 })
    expect(transport.isDraining).toBe(true)

    const refused = createMockSocket()
    const { start } = transport.handleConnection({ socket: refused })
    start() // no-op for a refused connection
    expect(refused.readyState).toBe("closed")
    expect(transport.connectionCount).toBe(1) // not registered

    // Let the drain finish so the promise settles.
    await vi.advanceTimersByTimeAsync(1000)
    await p
  })

  it("reports isDraining and resets it on stop (so re-init accepts again)", async () => {
    const transport = await startedTransport()
    expect(transport.isDraining).toBe(false)

    const p = transport.drainConnections({ windowMs: 0 })
    expect(transport.isDraining).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    await p

    await transport._stop()
    expect(transport.isDraining).toBe(false)
  })
})
