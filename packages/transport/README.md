# @kyneta/transport

Transport infrastructure for `@kyneta/exchange` — base class, channel types, message vocabulary, identity types, client utilities, wire pipeline, and bridge transport.

## What's in this package

| Module | Contents |
|--------|----------|
| **Identity types** | `PeerId`, `DocId`, `ChannelId`, `TransportType`, `PeerIdentityDetails` |
| **Message vocabulary** | `ChannelMsg`, `PresentMsg`, `InterestMsg`, `OfferMsg`, `DismissMsg`, `EstablishmentMsg`, `AddressedEnvelope`, `ReturnEnvelope` |
| **Channel types** | `Channel`, `ConnectedChannel`, `EstablishedChannel`, `GeneratedChannel`, `ChannelDirectory` |
| **Transport base class** | `Transport<G>`, `TransportFactory`, `TransportContext` |
| **Wire pipeline** | `Pipeline<S, R>`, `FrameStreamParser`, `Encoding`, `PayloadOf`, `WireOpts` |
| **Client state machine** | `ClientStateMachine<S>`, `StateTransition<S>`, `TransitionListener<S>` |
| **Reconnection** | `computeBackoffDelay`, `createReconnectScheduler`, `ReconnectOptions`, `DEFAULT_RECONNECT` |
| **Re-exports from wire** | `Result`, `Ok`, `Err`, `ok`, `err`, `WireError` |
| **Bridge transport** | Moved to `@kyneta/bridge-transport` — codec-faithful + alias-aware in-process testing |

## Wire pipeline

The `Pipeline<S, R>` class is the single wire pipeline for all transports. It composes alias resolution, wire-message encoding, fragmentation, and validation into a `send`/`receive` pair that transforms `ChannelMsg ↔ wire pieces`.

Four shapes cover every transport:

```/dev/null/pipeline-shapes.ts#L1-11
import { Pipeline } from "@kyneta/transport"

// Most transports (WebSocket, WebRTC, Unix socket)
const symmetric = new Pipeline({ send: "binary" })

// Symmetric text (if needed)
const text = new Pipeline({ send: "text" })

// SSE server — sends text downstream, receives binary CBOR uploads
const sseServer = new Pipeline({ send: "text", receive: "binary" })

// SSE client — sends binary CBOR uploads, receives text downstream
const sseClient = new Pipeline({ send: "binary", receive: "text" })
```

The type parameter `S` is the send encoding and `R` is the receive encoding (defaults to `S` for symmetric pipelines). `PayloadOf<E>` maps `"binary"` → `Uint8Array` and `"text"` → `string`.

## Who depends on this

```/dev/null/dependency-graph.txt#L1-6
@kyneta/transport  (defines Transport, Channel, ChannelMsg, Pipeline, ...)
    ↑           ↑           ↑            ↑
@kyneta/exchange  @kyneta/bridge-transport  @kyneta/websocket-transport  ...
(Synchronizer)    (in-process testing)       (extends Transport)
```

- **`@kyneta/wire`** — `@kyneta/transport` depends on `@kyneta/wire` (workspace). Wire is a leaf — it provides format primitives. Transport builds the pipeline on top.
- **`@kyneta/exchange`** — depends on `@kyneta/transport` and re-exports its infrastructure (identity types, message vocabulary, channel types, Transport base class, reconnection utilities). The exchange adds the sync runtime (`Synchronizer`, `Exchange`, `TransportManager`) on top.
- **Transport implementations** (`@kyneta/bridge-transport`, `@kyneta/websocket-transport`, `@kyneta/sse-transport`, `@kyneta/unix-socket-transport`, `@kyneta/webrtc-transport`) — peer-depend on `@kyneta/transport` for the `Transport<G>` base class, channel types, message vocabulary, and `Pipeline`.

## Creating a transport

Extend the `Transport<G>` base class:

```/dev/null/transport-example.ts#L1-20
import { Transport, type GeneratedChannel } from "@kyneta/transport"

class MyTransport extends Transport<void> {
  constructor() {
    super({ transportType: "my-transport" })
  }

  generate(): GeneratedChannel {
    return {
      transportType: this.transportType,
      send: (msg) => { /* send over your wire */ },
      stop: () => { /* cleanup */ },
    }
  }

  async onStart() {
    const channel = this.addChannel(undefined)
    this.establishChannel(channel.channelId)
  }

  async onStop() {
    // cleanup
  }
}
```

## Dependencies

```/dev/null/package.json#L1-6
{
  "dependencies": {
    "@kyneta/wire": "workspace:^",
    "@kyneta/random": "workspace:^"
  }
}
```

`@kyneta/schema` and `@kyneta/machine` are peer dependencies (needed for `SyncProtocol`, `ReplicaType`, `SubstratePayload`, and the state-machine types used in message definitions).

## License

MIT
