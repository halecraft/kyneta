// client-transport.test — unit tests for the websocket client transport's
// constructor injection and header-passing behavior.
//
// These tests verify two properties:
//   1. The transport uses the caller-provided WebSocket constructor.
//   2. When `headers` are provided, they're passed as `{ headers }` in the
//      second argument. When absent, the constructor is called with just the URL.

import { describe, expect, it, vi } from "vitest"
import type { TransportContext } from "@kyneta/transport"
import type { PeerIdentityDetails } from "@kyneta/transport"
import { WebsocketClientTransport } from "../client-transport.js"
import type { WebSocketConstructor, WebSocketLike } from "../types.js"

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

interface MockCall {
  url: string
  rest: any[]
}

/**
 * Create a mock WebSocket class that records constructor invocations
 * and implements WebSocketLike with no-op methods.
 */
function createMockWebSocketClass() {
  const calls: MockCall[] = []

  const MockWebSocket = vi.fn(function (
    this: WebSocketLike,
    url: string,
    ...rest: any[]
  ) {
    calls.push({ url, rest })
    ;(this as any).readyState = 0
    ;(this as any).binaryType = "blob"
    ;(this as any).send = vi.fn()
    ;(this as any).close = vi.fn()
    ;(this as any).addEventListener = vi.fn()
    ;(this as any).removeEventListener = vi.fn()
  }) as unknown as WebSocketConstructor

  return { MockWebSocket, calls }
}

// ---------------------------------------------------------------------------
// Transport lifecycle helpers
// ---------------------------------------------------------------------------

const testIdentity: PeerIdentityDetails = {
  peerId: "test-peer-123",
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
 * Initialize and start a WebsocketClientTransport through the full
 * Transport lifecycle so the program's "create-websocket" effect fires.
 */
async function startTransport(transport: WebsocketClientTransport) {
  const ctx = createTransportContext()
  transport._initialize(ctx)
  await transport._start()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebsocketClientTransport — constructor injection", () => {
  it("calls the provided WebSocket constructor with the URL", async () => {
    const { MockWebSocket, calls } = createMockWebSocketClass()

    const transport = new WebsocketClientTransport({
      url: "ws://localhost:9999/ws",
      WebSocket: MockWebSocket,
      reconnect: { enabled: false },
    })

    await startTransport(transport)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe("ws://localhost:9999/ws")
  })

  it("resolves URL function with peerId before passing to constructor", async () => {
    const { MockWebSocket, calls } = createMockWebSocketClass()

    const transport = new WebsocketClientTransport({
      url: (peerId) => `ws://localhost:9999/ws/${peerId}`,
      WebSocket: MockWebSocket,
      reconnect: { enabled: false },
    })

    await startTransport(transport)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`ws://localhost:9999/ws/${testIdentity.peerId}`)
  })
})

describe("WebsocketClientTransport — header passing", () => {
  it("passes { headers } as second arg when headers are non-empty", async () => {
    const headers = {
      Authorization: "Bearer test-token",
      "X-Custom": "value",
    }
    const { MockWebSocket, calls } = createMockWebSocketClass()

    const transport = new WebsocketClientTransport({
      url: "ws://localhost:9999/ws",
      WebSocket: MockWebSocket,
      headers,
      reconnect: { enabled: false },
    })

    await startTransport(transport)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.rest).toEqual([{ headers }])
  })

  it("omits second arg when headers are not provided", async () => {
    const { MockWebSocket, calls } = createMockWebSocketClass()

    const transport = new WebsocketClientTransport({
      url: "ws://localhost:9999/ws",
      WebSocket: MockWebSocket,
      reconnect: { enabled: false },
    })

    await startTransport(transport)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.rest).toEqual([])
  })

  it("omits second arg when headers is an empty object", async () => {
    const { MockWebSocket, calls } = createMockWebSocketClass()

    const transport = new WebsocketClientTransport({
      url: "ws://localhost:9999/ws",
      WebSocket: MockWebSocket,
      headers: {},
      reconnect: { enabled: false },
    })

    await startTransport(transport)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.rest).toEqual([])
  })
})