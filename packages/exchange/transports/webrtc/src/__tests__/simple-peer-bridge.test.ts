// simple-peer-bridge.test — demonstrates that a simple-peer-style EventEmitter
// can be trivially bridged to DataChannelLike and used with WebrtcTransport.
//
// The ~20-line fromSimplePeer() bridge function maps simple-peer's
// EventEmitter API (on/off, "connect"/"data"/"close"/"error") to the
// DataChannelLike contract (addEventListener/removeEventListener,
// "open"/"message"/"close"/"error").

import { describe, expect, it, vi } from "vitest"
import type { DataChannelLike } from "../data-channel-like.js"
import { WebrtcTransport } from "../webrtc-transport.js"

// ---------------------------------------------------------------------------
// MockSimplePeer — mimics simple-peer's EventEmitter-style API
// ---------------------------------------------------------------------------

class MockSimplePeer {
  connected = false
  private listeners = new Map<string, Set<(...args: any[]) => void>>()

  on(event: string, fn: (...args: any[]) => void) {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(fn)
    return this
  }

  off(event: string, fn: (...args: any[]) => void) {
    this.listeners.get(event)?.delete(fn)
  }

  send(_data: any) {
    /* no-op for mock */
  }

  /** Test helper to simulate events */
  _emit(event: string, ...args: any[]) {
    for (const fn of this.listeners.get(event) ?? []) fn(...args)
  }
}

// ---------------------------------------------------------------------------
// fromSimplePeer — the ~20-line bridge function under test
// ---------------------------------------------------------------------------

function fromSimplePeer(peer: MockSimplePeer): DataChannelLike {
  // Map: DataChannelLike event → simple-peer event
  const eventMap: Record<string, string> = {
    open: "connect",
    close: "close",
    error: "error",
    message: "data",
  }

  // Track wrapped listeners for cleanup
  const wrapperMap = new Map<Function, Function>()

  return {
    get readyState() {
      return peer.connected ? "open" : "connecting"
    },
    binaryType: "arraybuffer",
    send(data: Uint8Array) {
      peer.send(data)
    },
    addEventListener(type: string, listener: (event: any) => void) {
      const peerEvent = eventMap[type]
      if (!peerEvent) return
      const wrapped =
        type === "message"
          ? (data: any) => listener({ data })
          : () => listener({})
      wrapperMap.set(listener, wrapped)
      peer.on(peerEvent, wrapped)
    },
    removeEventListener(type: string, listener: (event: any) => void) {
      const peerEvent = eventMap[type]
      if (!peerEvent) return
      const wrapped = wrapperMap.get(listener)
      if (wrapped) {
        peer.off(peerEvent, wrapped as any)
        wrapperMap.delete(listener)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function initializeTransport(transport: WebrtcTransport) {
  transport._initialize({
    identity: { peerId: "local", name: "Local", type: "user" as const },
    onChannelReceive: vi.fn(),
    onChannelAdded: vi.fn(),
    onChannelRemoved: vi.fn(),
    onChannelEstablish: vi.fn(),
  })
  await transport._start()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fromSimplePeer bridge", () => {
  it("satisfies DataChannelLike", () => {
    const peer = new MockSimplePeer()
    const dc: DataChannelLike = fromSimplePeer(peer)

    expect(dc.readyState).toBe("connecting")
    expect(dc.binaryType).toBe("arraybuffer")
    expect(typeof dc.send).toBe("function")
    expect(typeof dc.addEventListener).toBe("function")
    expect(typeof dc.removeEventListener).toBe("function")
  })

  it("readyState reflects peer.connected", () => {
    const peer = new MockSimplePeer()
    const dc = fromSimplePeer(peer)

    expect(dc.readyState).toBe("connecting")

    peer.connected = true
    expect(dc.readyState).toBe("open")

    peer.connected = false
    expect(dc.readyState).toBe("connecting")
  })

  it("open event fires when peer emits connect", () => {
    const peer = new MockSimplePeer()
    const dc = fromSimplePeer(peer)
    const spy = vi.fn()

    dc.addEventListener("open", spy)
    peer._emit("connect")

    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith({})
  })

  it("message event wraps data in event object", () => {
    const peer = new MockSimplePeer()
    const dc = fromSimplePeer(peer)
    const spy = vi.fn()
    const payload = new Uint8Array([1, 2, 3, 4])

    dc.addEventListener("message", spy)
    peer._emit("data", payload)

    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith({ data: payload })
  })

  it("removeEventListener cleans up", () => {
    const peer = new MockSimplePeer()
    const dc = fromSimplePeer(peer)
    const spy = vi.fn()

    dc.addEventListener("open", spy)
    dc.removeEventListener("open", spy)
    peer._emit("connect")

    expect(spy).not.toHaveBeenCalled()
  })

  it("works with WebrtcTransport", async () => {
    const transport = new WebrtcTransport()
    await initializeTransport(transport)

    const peer = new MockSimplePeer()
    const dc = fromSimplePeer(peer)

    transport.attachDataChannel("remote-peer", dc)

    // Channel attached but not yet open — no sync channel yet
    expect(transport.hasDataChannel("remote-peer")).toBe(true)
    expect(transport.channels.size).toBe(0)

    // Simulate simple-peer connection
    peer.connected = true
    peer._emit("connect")

    // Transport should now have a sync channel
    expect(transport.channels.size).toBe(1)

    // Clean up
    transport.detachDataChannel("remote-peer")
    expect(transport.hasDataChannel("remote-peer")).toBe(false)
    expect(transport.channels.size).toBe(0)
  })
})
