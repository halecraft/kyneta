// client-transport.test — tests for SseClientTransport edge cases.
//
// Verifies two properties that are critical for correct transport behavior
// across reconnections:
//
//   1. Alias state is reset on each new channel (matching the pattern in
//      WebsocketClientTransport). Without this, stale alias bindings from
//      a prior connection carry into a new one — the server's alias table
//      was also reset on reconnect, so the stale alias references point to
//      nothing, causing messages to be silently dropped.
//
//   2. Failed POST sends do not produce unhandled promise rejections.
//      The send callback is synchronous and uses `void` to fire async
//      POSTs, so any thrown error escapes the promise chain.

import { SYNC_AUTHORITATIVE } from "@kyneta/schema"
import type {
  ChannelMsg,
  PeerIdentityDetails,
  TransportContext,
} from "@kyneta/transport"
import * as wireModule from "@kyneta/wire"
import { describe, expect, it, vi } from "vitest"
import type { SseClientOptions } from "../client-transport.js"
import { SseClientTransport } from "../client-transport.js"

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const testIdentity: PeerIdentityDetails = {
  peerId: "test-peer",
  name: "Test Peer",
  type: "user",
}

function createContext(
  overrides?: Partial<TransportContext>,
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
 * A minimal EventSource mock that stays in CONNECTING state and never fires
 * events. This prevents the SSE transport from doing real HTTP I/O during
 * tests.
 */
class MockEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  readyState = 0 // CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data?: string }) => void) | null = null
  onerror: (() => void) | null = null
  url: string

  constructor(url: string | URL) {
    this.url = url.toString()
  }

  close(): void {
    this.readyState = 2 // CLOSED
  }

  addEventListener(_type: string, _fn: unknown): void {}
  removeEventListener(_type: string, _fn: unknown): void {}
}

// ---------------------------------------------------------------------------
// Alias state reset on reconnect
// ---------------------------------------------------------------------------

describe("SseClientTransport — alias state on reconnect", () => {
  it("resets alias state when generating a new channel", async () => {
    // Each call to generate() must produce a send function with a fresh
    // alias table. We verify this by spying on `emptyAliasState`: after
    // two addChannel() calls (simulating initial connect + reconnect),
    // the spy should count 3 invocations — 1 from the constructor field
    // initializer, plus 1 per generate().

    const spy = vi.spyOn(wireModule, "emptyAliasState")

    const oldEventSource = (globalThis as Record<string, unknown>).EventSource
    ;(globalThis as Record<string, unknown>).EventSource = MockEventSource
    const oldFetch = globalThis.fetch
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ) as unknown as typeof globalThis.fetch

    try {
      const options: SseClientOptions = {
        postUrl: "/api/sync",
        eventSourceUrl: "/api/events",
        reconnect: { enabled: false },
      }

      const transport = new SseClientTransport(options)
      // Constructor field init: #aliasState = emptyAliasState()
      const afterConstructor = spy.mock.calls.length

      const ctx = createContext()
      transport._initialize(ctx)
      await transport._start()

      // Connection 1: addChannel calls generate()
      // addChannel and generate() are protected; use any-cast in tests.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const channel1 = (transport as any).addChannel()
      const afterFirstAddChannel = spy.mock.calls.length

      // Simulate reconnect: remove old channel, add new one
      // removeChannel is also protected.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(transport as any).removeChannel(channel1.channelId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(transport as any).addChannel()
      const afterSecondAddChannel = spy.mock.calls.length

      expect(afterConstructor).toBe(1) // field init only
      expect(afterFirstAddChannel).toBe(2) // + 1 from first generate()
      expect(afterSecondAddChannel).toBe(3) // + 1 from second generate()
    } finally {
      spy.mockRestore()
      globalThis.fetch = oldFetch
      if (oldEventSource === undefined) {
        delete (globalThis as Record<string, unknown>).EventSource
      } else {
        ;(globalThis as Record<string, unknown>).EventSource = oldEventSource
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Unhandled promise rejection on POST failure
// ---------------------------------------------------------------------------

describe("SseClientTransport — unhandled rejections", () => {
  it("does not produce unhandled promise rejections when POSTs fail", async () => {
    // The send callback is synchronous and dispatches async POSTs via
    // `void sendTextWithRetry(...)`. If sendTextWithRetry throws after
    // exhausting retries, that rejection must not escape the promise
    // chain — the error is logged instead.

    const unhandledRejections: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandledRejections.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)

    // Mock fetch to always fail
    const oldFetch = globalThis.fetch
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        new Error("Network failure"),
      ) as unknown as typeof globalThis.fetch

    const oldEventSource = (globalThis as Record<string, unknown>).EventSource
    ;(globalThis as Record<string, unknown>).EventSource = MockEventSource

    try {
      const options: SseClientOptions = {
        postUrl: "/api/sync",
        eventSourceUrl: "/api/events",
        reconnect: { enabled: false },
        // Single attempt, instant — keeps the test fast.
        postRetry: {
          maxAttempts: 1,
          baseDelay: 1,
        },
      }

      const transport = new SseClientTransport(options)
      const ctx = createContext()

      transport._initialize(ctx)
      await transport._start()

      // addChannel is protected; use any-cast.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const channel = (transport as any).addChannel()

      // Set EventSource to OPEN so the guard doesn't block sends
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const es = (transport as any)["#eventSource"] as
        | MockEventSource
        | undefined
      if (es) {
        es.readyState = 1
      }

      // Connected channels only accept LifecycleMsg, but we need a sync
      // message to exercise the inner send path.
      const msg: ChannelMsg = {
        type: "present",
        docs: [
          {
            docId: "doc-abc",
            replicaType: ["plain", 1, 0],
            syncProtocol: SYNC_AUTHORITATIVE,
            schemaHash: "sha-001",
          },
        ],
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(channel as any).send(msg)

      // Wait for the async send to fail
      await new Promise(resolve => setTimeout(resolve, 200))

      expect(unhandledRejections.length).toBe(0)
    } finally {
      globalThis.fetch = oldFetch
      process.off("unhandledRejection", onUnhandled)
      if (oldEventSource === undefined) {
        delete (globalThis as Record<string, unknown>).EventSource
      } else {
        ;(globalThis as Record<string, unknown>).EventSource = oldEventSource
      }
    }
  })
})
