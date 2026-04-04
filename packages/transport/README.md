# @kyneta/transport

Transport infrastructure for `@kyneta/exchange` — base class, channel types, message vocabulary, identity types, client utilities, and bridge transport.

## What's in this package

| Module | Contents |
|--------|----------|
| **Identity types** | `PeerId`, `DocId`, `ChannelId`, `TransportType`, `PeerIdentityDetails` |
| **Message vocabulary** | `ChannelMsg`, `PresentMsg`, `InterestMsg`, `OfferMsg`, `DismissMsg`, `EstablishmentMsg`, `AddressedEnvelope`, `ReturnEnvelope` |
| **Channel types** | `Channel`, `ConnectedChannel`, `EstablishedChannel`, `GeneratedChannel`, `ChannelDirectory` |
| **Transport base class** | `Transport<G>`, `TransportFactory`, `TransportContext` |
| **Client state machine** | `ClientStateMachine<S>`, `StateTransition<S>`, `TransitionListener<S>` |
| **Reconnection** | `computeBackoffDelay`, `createReconnectScheduler`, `ReconnectOptions`, `DEFAULT_RECONNECT` |
| **Bridge transport** | `Bridge`, `BridgeTransport`, `createBridgeTransport` — in-process testing |

## Who depends on this

```
@kyneta/transport  (defines Transport, Channel, ChannelMsg, ...)
    ↑           ↑           ↑
@kyneta/exchange  @kyneta/wire  @kyneta/websocket-transport
(Synchronizer)    (codecs)      (extends Transport)
```

- **`@kyneta/wire`** — peer-depends on `@kyneta/transport` for `ChannelMsg` and message type variants (type-only imports for codec definitions).
- **`@kyneta/exchange`** — depends on `@kyneta/transport` and re-exports everything. The exchange adds the sync runtime (`Synchronizer`, `Exchange`, `TransportManager`) on top.
- **Transport implementations** (`@kyneta/websocket-transport`, `@kyneta/sse-transport`, `@kyneta/unix-socket-transport`, `@kyneta/webrtc-transport`) — peer-depend on `@kyneta/transport` for the `Transport<G>` base class, channel types, and message vocabulary.

## Creating a transport

Extend the `Transport<G>` base class:

```ts
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

## Peer Dependencies

```json
{
  "peerDependencies": {
    "@kyneta/schema": "^1.1.0"
  }
}
```

`@kyneta/schema` is needed for `MergeStrategy`, `ReplicaType`, and `SubstratePayload` used in message type definitions.

## License

MIT