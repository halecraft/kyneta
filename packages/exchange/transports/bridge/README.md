# @kyneta/bridge-transport

In-process transport for testing — alias-aware delivery.

`BridgeTransport` is a real transport that runs the production alias transformer
and `WireMessage` pipeline end-to-end and applies the docId/schemaHash alias
transformer at the channel send/receive boundary — exactly like every other binary
transport. Async delivery is preserved via `queueMicrotask()` to keep test behavior
representative of real network adapters.

## Usage

```typescript
import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { Exchange } from "@kyneta/exchange"

const bridge = new Bridge()

const exchangeA = new Exchange({
  transports: [createBridgeTransport({ transportId: "peer-a", bridge })],
})

const exchangeB = new Exchange({
  transports: [createBridgeTransport({ transportId: "peer-b", bridge })],
})
```

## Peer Dependencies

```json
{
  "peerDependencies": {
    "@kyneta/transport": "^1.4.0",
    "@kyneta/wire": "^1.4.0"
  }
}
```

`BridgeTransport` extends the `Transport<G>` base class from
`@kyneta/transport` and uses the alias transformer + `WireMessage` pipeline from
`@kyneta/wire` to exercise the production wire path in tests.

## License

MIT