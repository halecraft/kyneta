# @kyneta/webrtc-transport

BYODC (Bring Your Own Data Channel) WebRTC transport for `@kyneta/exchange`. Your application manages WebRTC connections — signaling, ICE, media streams — and this transport attaches to data channels for kyneta document synchronization.

The key design decision is `DataChannelLike`: a 5-member minimal interface that native `RTCDataChannel` satisfies structurally and that libraries like simple-peer can bridge in ~20 lines.

## Overview

- **BYODC design** — no signaling, no ICE, no connection management. The application establishes WebRTC connections however it likes; this transport hooks into the resulting data channels for sync.
- **Binary CBOR encoding** with transport-level fragmentation — the same `@kyneta/wire` pipeline used by the WebSocket transport.
- **`DataChannelLike` interface** — 5 members out of the ~30-member `RTCDataChannel` API. Native data channels conform structurally (zero wrapper code). Library bridges are trivial.
- **Single export** — no client/server split. Both peers use the same `WebrtcTransport` class.

## Install

```/dev/null/install.sh#L1
pnpm add @kyneta/webrtc-transport
```

## Quick Start

### With native RTCDataChannel

Native `RTCDataChannel` satisfies `DataChannelLike` structurally — pass it directly:

```/dev/null/native-example.ts#L1-14
import { Exchange } from "@kyneta/exchange"
import { createWebrtcTransport, WebrtcTransport } from "@kyneta/webrtc-transport"

const exchange = new Exchange({
  identity: { peerId: "alice", name: "Alice" },
  transports: [createWebrtcTransport()],
})

// When a WebRTC connection is established:
const transport = exchange.getTransport("webrtc-datachannel") as WebrtcTransport
const cleanup = transport.attachDataChannel(remotePeerId, dataChannel)

// When done:
cleanup()
```

### With simple-peer (bridge function)

simple-peer uses an EventEmitter API instead of `addEventListener`. A ~20-line bridge maps it to `DataChannelLike`:

```/dev/null/simple-peer-bridge.ts#L1-39
import type { DataChannelLike } from "@kyneta/webrtc-transport"

function fromSimplePeer(peer: SimplePeer.Instance): DataChannelLike {
  const eventMap: Record<string, string> = {
    open: "connect", close: "close", error: "error", message: "data",
  }
  const wrapperMap = new Map<Function, Function>()
  return {
    get readyState() { return peer.connected ? "open" : "connecting" },
    binaryType: "arraybuffer",
    send(data) { peer.send(data) },
    addEventListener(type, listener) {
      const peerEvent = eventMap[type]
      if (!peerEvent) return
      const wrapped = type === "message"
        ? (data: any) => listener({ data })
        : () => listener({})
      wrapperMap.set(listener, wrapped)
      peer.on(peerEvent, wrapped as any)
    },
    removeEventListener(type, listener) {
      const peerEvent = eventMap[type]
      if (!peerEvent) return
      const wrapped = wrapperMap.get(listener)
      if (wrapped) { peer.off(peerEvent, wrapped as any); wrapperMap.delete(listener) }
    },
  }
}

// Usage:
const channel = fromSimplePeer(peer)
transport.attachDataChannel(remotePeerId, channel)
```

## API Reference

### `createWebrtcTransport(options?)`

Factory function returning a `TransportFactory`. Pass directly to `Exchange({ transports: [...] })`.

| Option | Default | Description |
|--------|---------|-------------|
| `fragmentThreshold` | `204800` (200KB) | Payload size threshold in bytes for SCTP fragmentation. |

```/dev/null/factory-example.ts#L1-3
const exchange = new Exchange({
  transports: [createWebrtcTransport({ fragmentThreshold: 100 * 1024 })],
})
```

To access the transport instance after creation:

```/dev/null/get-transport.ts#L1
const transport = exchange.getTransport("webrtc-datachannel") as WebrtcTransport
```

### `WebrtcTransport`

The transport class. Extends `Transport` from `@kyneta/exchange`.

| Method | Signature | Description |
|--------|-----------|-------------|
| `attachDataChannel` | `(remotePeerId: string, channel: DataChannelLike) => () => void` | Attach a data channel. Returns a cleanup function. If a channel is already attached for this peer, the old one is detached first. |
| `detachDataChannel` | `(remotePeerId: string) => void` | Detach a data channel. Removes event listeners but does **not** close the data channel. |
| `hasDataChannel` | `(remotePeerId: string) => boolean` | Check if a data channel is attached for a peer. |
| `getAttachedPeerIds` | `() => string[]` | List all peer IDs with attached data channels. |

### `DataChannelLike`

The minimal interface — 5 members:

```/dev/null/data-channel-like.ts#L1-7
interface DataChannelLike {
  readonly readyState: string     // transport checks === "open"
  binaryType: string              // transport writes "arraybuffer" on attach
  send(data: Uint8Array): void
  addEventListener(type: string, listener: (event: any) => void): void
  removeEventListener(type: string, listener: (event: any) => void): void
}
```

The transport listens for four event types: `"open"`, `"close"`, `"error"`, `"message"`. For `"message"` events, it reads `event.data` (accepting both `ArrayBuffer` and `Uint8Array`).

## `DataChannelLike` Interface

The full `RTCDataChannel` interface has ~30 members. This transport uses exactly 5. By accepting `DataChannelLike` instead of `RTCDataChannel`:

- **No DOM type dependency** — the interface uses `string` for `readyState` and `any` for event parameters, so there's no import of `lib.dom.d.ts` types like `Event`, `MessageEvent`, or `RTCDataChannelState`.
- **No wrapper for native WebRTC** — `RTCDataChannel` satisfies `DataChannelLike` structurally. Pass it directly.
- **Library bridges are trivial** — simple-peer, `werift`, `node-datachannel`, etc. can be bridged in ~20 lines by mapping their EventEmitter API to `addEventListener`/`removeEventListener`.
- **No double-casts** — without this design you'd need `channel as unknown as RTCDataChannel` to satisfy the type checker when using non-native implementations.

The type is intentionally loose: `readyState` is `string` (not a union), `binaryType` is `string` (not `"arraybuffer" | "blob"`), and event listeners take `any`. This maximizes the set of objects that conform structurally.

## Ownership Contract

The transport does **not** own the data channel.

- `attachDataChannel()` registers event listeners and creates an internal sync channel.
- `detachDataChannel()` removes event listeners and tears down the sync channel.
- Neither method closes the `DataChannelLike` or the peer connection.

The application manages the WebRTC connection lifecycle independently. This means you can:

- Share a peer connection across multiple transports
- Detach and reattach data channels without renegotiation
- Close data channels on your own schedule

## Fragmentation

SCTP (the underlying transport for WebRTC data channels) has a message size limit of approximately 256KB. The transport fragments messages that exceed the configured threshold using the same binary fragmentation pipeline as the WebSocket transport (`@kyneta/wire`).

| Setting | Value | Notes |
|---------|-------|-------|
| Default threshold | 200KB | Safe margin below SCTP's ~256KB limit |
| Disable | `fragmentThreshold: 0` | Not recommended — large messages will fail silently |

This differs from the WebSocket transport's 100KB default, which targets AWS API Gateway's 128KB frame limit. WebRTC has no such gateway constraint.

## Peer Dependencies

```/dev/null/package.json#L1-6
{
  "peerDependencies": {
    "@kyneta/exchange": "^1.1.0",
    "@kyneta/wire": "^1.1.0"
  }
}
```

## License

MIT