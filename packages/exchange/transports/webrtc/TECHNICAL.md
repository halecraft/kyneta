# @kyneta/webrtc-transport — Technical Reference

> **Package**: `@kyneta/webrtc-transport`
> **Role**: WebRTC data-channel transport for `@kyneta/exchange` — attaches to application-owned data channels and runs the same alias-aware binary pipeline as the WebSocket transport over them. "Bring Your Own Data Channel" (BYODC).
> **Depends on**: `@kyneta/transport`, `@kyneta/wire` (both peer)
> **Depended on by**: `@kyneta/exchange` (through application configuration)
> **Canonical symbols**: `WebrtcTransport`, `createWebrtcTransport`, `WebrtcTransportOptions`, `DataChannelLike`, `DEFAULT_FRAGMENT_THRESHOLD`
> **Key invariant(s)**: The transport never creates, negotiates, or closes a data channel. It only *attaches* to channels the application provides via `attachDataChannel(remotePeerId, channel)` and *detaches* via `detachDataChannel(remotePeerId)`. Closing the data channel, tearing down `RTCPeerConnection`, handling ICE, and running signalling are all the application's job.

A tiny WebRTC transport kit. It accepts any object satisfying a five-member `DataChannelLike` interface, runs `ChannelMsg` through the same `@kyneta/wire` alias-aware binary pipeline used by the WebSocket transport, and stays completely out of the signalling layer. Native `RTCDataChannel` satisfies `DataChannelLike` structurally with zero wrapping; `simple-peer` and other libraries conform through ~20 lines of bridge code.

Imported by applications that have already established a peer-to-peer connection via their own signalling infrastructure and now want document sync to flow over the existing data channel.

---

## Questions this document answers

- What does "BYODC" mean in practice? → [The ownership boundary](#the-ownership-boundary)
- Why is `DataChannelLike` so minimal? → [`DataChannelLike` — the five-member contract](#datachannellike--the-five-member-contract)
- How do I attach a `simple-peer` connection? → [Bridging non-spec libraries](#bridging-non-spec-libraries)
- Why 200 KB fragmentation threshold and not 100 KB like WebSocket? → [Fragmentation threshold](#fragmentation-threshold)
- What happens to pending sends while a channel is in `"connecting"`? → [Readiness gating](#readiness-gating)
- How does this transport connect to the six-message protocol? → [Wire pipeline](#wire-pipeline)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| BYODC | "Bring Your Own Data Channel" — the application owns the `RTCPeerConnection` and data-channel lifecycle; this transport only attaches to established channels. | A framework that manages WebRTC end-to-end |
| `DataChannelLike` | Structural interface with `readyState`, `binaryType`, `send`, `addEventListener`, `removeEventListener`. Native `RTCDataChannel` satisfies it with no wrapping. | `RTCDataChannel` specifically — any object with the right shape qualifies |
| `WebrtcTransport` | The concrete `Transport<...>` subclass. One instance manages many attached data channels, one per remote peer. | A single data channel |
| `attachDataChannel(remotePeerId, channel)` | Tell the transport: "this data channel carries sync traffic for this peer." Wires four event listeners and registers a `ConnectedChannel`. | Creating the data channel — the transport never creates one |
| `detachDataChannel(remotePeerId)` | Remove the sync channel. Unsubscribes listeners. Does **not** close the data channel or peer connection. | Closing the peer — the application still owns it |
| `DEFAULT_FRAGMENT_THRESHOLD` | `200 * 1024` bytes — fragmentation kicks in above this. | The WebSocket `100 KB` threshold (different constraint) |

---

## Architecture

**Thesis**: let the application own every WebRTC concern it already has to own, and attach a sync pipeline to the data channel once it exists.

A WebRTC application already has:

- Signalling (offer / answer / ICE candidates over some side channel)
- `RTCPeerConnection` lifecycle
- Possibly media tracks, stats, reconnection policy, TURN configuration

None of that has anything to do with document sync, and none of it is generalizable — every application signals differently. So this transport does zero of it. It expects the application to hand it a data channel that is already (or about to be) open, and runs sync traffic through it.

### The ownership boundary

| Responsibility | Owner |
|----------------|-------|
| Create `RTCPeerConnection` | Application |
| Run signalling (offer / answer / ICE) | Application |
| Create data channel (`pc.createDataChannel(...)` or remote `ondatachannel`) | Application |
| Configure `ordered`, `maxRetransmits`, `negotiated`, etc. | Application |
| Close data channel | Application |
| Close peer connection | Application |
| Attach sync traffic to the data channel | This transport |
| CBOR encode / decode | This transport (via `@kyneta/wire`) |
| Fragment / reassemble | This transport (via `@kyneta/wire`) |
| Apply alias transformer | This transport (via `@kyneta/wire`) |
| Run the six-message protocol | `@kyneta/exchange` (through this transport) |

`detachDataChannel(remotePeerId)` is explicit about its boundary: it removes the four event listeners, drops the reassembler, and removes the `ConnectedChannel` from the exchange — **but it does not call `channel.close()`**. The application may keep using the data channel for other purposes, or may close it later as part of its own teardown.

### What `WebrtcTransport` is NOT

- **Not a WebRTC library.** It neither imports nor produces `RTCPeerConnection`, ICE candidates, or SDP. It is the thinnest possible layer above a data channel.
- **Not a signalling transport.** It does not exchange offer/answer messages. Those are application traffic, not sync traffic.
- **Not a lifecycle manager.** Reconnection, ICE restart, relay selection, and bandwidth estimation are all the application's problem. If a data channel closes, the transport simply detaches; re-establishing is an application concern.
- **Not tied to `simple-peer`, `peerjs`, or any specific library.** `DataChannelLike` is the contract. Any library that can produce something matching it works.

---

## `DataChannelLike` — the five-member contract

Source: `packages/exchange/transports/webrtc/src/data-channel-like.ts`.

```
interface DataChannelLike {
  readonly readyState: string
  binaryType: string
  send(data: Uint8Array): void
  addEventListener(type: string, listener: (event: any) => void): void
  removeEventListener(type: string, listener: (event: any) => void): void
}
```

Five members. No DOM types imported. The `event: any` in the listener signature is deliberate — typing it as `MessageEvent` or `Event` would force DOM lib on every consumer and would not help a `simple-peer` bridge anyway (its events are emitted by an `EventEmitter` and have a different shape).

The transport uses exactly these members, nothing more. Narrower is better: the fewer members the contract demands, the easier it is to bridge non-spec libraries.

### Event types actually used

The transport `addEventListener`s for exactly four event types:

| Event | What the transport does |
|-------|-------------------------|
| `"open"` | Mark the channel as sendable; flush any queued sends |
| `"close"` | Detach; emit disconnect |
| `"error"` | Log and treat like close |
| `"message"` | Read `event.data` (accepts both `ArrayBuffer` and `Uint8Array`), feed to the reassembler, decode, dispatch |

No other events are consumed. Libraries bridging to `DataChannelLike` need only route these four.

### What `DataChannelLike` is NOT

- **Not `RTCDataChannel`.** It is a *structural subset*. A native channel satisfies it — the reverse is not true.
- **Not a class or abstract base.** No `extends`, no `instanceof`. If the shape matches, the transport accepts it.
- **Not typed against `MessageEvent`.** `event: any` is intentional; the transport only reads `event.data` at runtime.

### Bridging non-spec libraries

A `simple-peer` bridge is ~20 lines: map `"open"` / `"close"` / `"error"` / `"data"` EventEmitter events into `addEventListener`-style callbacks and expose `readyState`. The transport's own `simple-peer-bridge.test.ts` exercises this pattern directly.

---

## Wire pipeline

Source: `packages/exchange/transports/webrtc/src/webrtc-transport.ts`. Identical to the WebSocket transport's alias-aware binary pipeline, differing only in the threshold constant.

```
Outbound:
  ChannelMsg
    └─ applyOutboundAliasing
       └─ encodeWireMessage
          └─ encodeWireFrameAndSend (fragment if > threshold)
             └─ channel.send(Uint8Array)

Inbound:
  event.data (ArrayBuffer | Uint8Array)
    └─ FragmentReassembler (per-channel, per-peer)
       └─ decodeBinaryWires
          └─ ChannelMsg[]
             └─ onChannelReceive(channelId, msg)
```

One `FragmentReassembler` per attached channel — fragments from different peers cannot interleave because each peer has its own channel and its own reassembler. The reassembler's default timeout and concurrency limits are inherited from `@kyneta/wire`.

### Readiness gating

When an attach happens before the data channel is `"open"` (common — applications often attach immediately after `pc.createDataChannel`), the transport:

1. Registers the `ConnectedChannel` with the exchange.
2. Starts listening for `"open"`, `"close"`, `"error"`, `"message"`.
3. Sends from the exchange are routed through the channel's `send` method.
4. The spec: `channel.send()` called in `"connecting"` state throws; the transport does **not** queue — it relies on the exchange's send-after-establish ordering to only send once the handshake completes, which itself only fires after `"open"`.

Once `"open"` fires, the transport sends `establish` (kicking off the exchange handshake). The exchange then transitions the channel to established.

### Fragmentation threshold

`DEFAULT_FRAGMENT_THRESHOLD = 200 * 1024` (200 KB).

The WebRTC data-channel underlying transport is SCTP, which negotiates a maximum message size (typically ~256 KB across major implementations). 200 KB provides a safety margin. Some implementations support larger messages; applications that know their peer supports more can raise the threshold via `WebrtcTransportOptions.fragmentThreshold`, or disable fragmentation with `0` (not recommended unless message sizes are known-small).

This differs from the WebSocket transport's 100 KB default, which targets AWS API Gateway's 128 KB cap — an application-layer constraint unrelated to the underlying network. WebRTC has no gateway.

### What fragmentation is NOT (here)

- **Not an SCTP feature.** SCTP does its own fragmentation below our layer. Our fragmentation exists because SCTP *rejects* (not splits) messages above its negotiated max-size at the application API level.
- **Not ordered across fragment IDs.** As in `@kyneta/wire` generally, fragments of *different* frame IDs may interleave; fragments of the *same* ID must all arrive.

---

## Attach / detach lifecycle

```
application code                           WebrtcTransport
─────────────────                          ────────────────
pc.createDataChannel("kyneta")  ──►
transport.attachDataChannel(     ──►       register listeners, create
  remotePeerId, channel)                   ConnectedChannel, reassembler
                                           │
                                 ◄──────── channel.addEventListener("open", ...)
channel becomes "open"           ──────►   onOpen → send establish
exchange handshake completes     ◄──►      channel upgraded to Established

...sync traffic flows...

channel "close" event            ──────►   onClose → detach
  -OR-
transport.detachDataChannel(     ──►       removeEventListener × 4,
  remotePeerId)                            drop reassembler, remove
                                           ConnectedChannel
application may close the
data channel or keep it
for its own purposes
```

Detaching from a remote peer that was never attached is a no-op. Attaching twice to the same `remotePeerId` detaches the previous channel first.

---

## Usage

```
import { createWebrtcTransport } from "@kyneta/webrtc-transport"

// Somewhere during app startup:
const webrtc = createWebrtcTransport()

const exchange = new Exchange({
  peerId: myPeerId,
  transports: [webrtc],
})

// After signalling has completed and the data channel exists:
pc.addEventListener("datachannel", (e) => {
  webrtc.attachDataChannel(remotePeerId, e.channel)
})

// When the application decides this peer is done:
webrtc.detachDataChannel(remotePeerId)
```

Options:

```
createWebrtcTransport({
  fragmentThreshold: 128 * 1024,   // tune for peer's SCTP limit
})
```

---

## Key Types

| Type | File | Role |
|------|------|------|
| `WebrtcTransport` | `src/webrtc-transport.ts` | The `Transport<...>` subclass. |
| `WebrtcTransportOptions` | `src/webrtc-transport.ts` | `{ fragmentThreshold? }`. |
| `createWebrtcTransport` | `src/webrtc-transport.ts` | `TransportFactory` returning a fresh `WebrtcTransport`. |
| `DataChannelLike` | `src/data-channel-like.ts` | The five-member structural contract. |
| `DEFAULT_FRAGMENT_THRESHOLD` | `src/webrtc-transport.ts` | `200 * 1024`. |

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 16 | Public exports. |
| `src/data-channel-like.ts` | 104 | The `DataChannelLike` interface + its doc contract. |
| `src/webrtc-transport.ts` | 434 | `WebrtcTransport`, `createWebrtcTransport`, attach/detach, binary pipeline wiring. |
| `src/__tests__/mock-data-channel.ts` | 94 | A test-only `DataChannelLike` implementation with scripted `readyState` transitions. |
| `src/__tests__/webrtc-transport.test.ts` | 517 | Attach/detach lifecycle, readiness gating, binary pipeline, fragmentation. |
| `src/__tests__/simple-peer-bridge.test.ts` | 197 | Demonstrates bridging an EventEmitter-shaped channel to `DataChannelLike`; verifies the bridge pattern works end-to-end. |

## Testing

No real `RTCPeerConnection`, no real network. Tests drive a mock `DataChannelLike` whose `readyState` and event firings are scripted deterministically. The `simple-peer-bridge.test.ts` file is also a reference implementation for the pattern described in [Bridging non-spec libraries](#bridging-non-spec-libraries).

**Tests**: 27 passed, 0 skipped across 2 files (`webrtc-transport.test.ts`: 21, `simple-peer-bridge.test.ts`: 6). Run with `cd packages/exchange/transports/webrtc && pnpm exec vitest run`.