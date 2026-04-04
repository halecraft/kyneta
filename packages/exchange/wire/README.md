# @kyneta/wire

Wire format codecs, framing, and fragmentation for `@kyneta/transport`. Serializes the transport's 5-message protocol (`establish-request`, `establish-response`, `discover`, `interest`, `offer`) for transport over binary and text channels.

## Codecs

Two `MessageCodec` implementations handle serialization. Adapters choose the codec that fits their transport — the exchange layer never touches serialization directly.

| Codec | Transport | Binary data handling | Import |
|-------|-----------|---------------------|--------|
| `cborCodec` | Binary (Websocket, WebRTC) | `Uint8Array` native as CBOR byte strings | `@kyneta/wire` |
| `jsonCodec` | Text (SSE, HTTP) | `Uint8Array` base64-encoded transparently | `@kyneta/wire` |

> **Note:** `SubstratePayload` with `encoding: "binary"` is base64-encoded in the JSON codec and passed natively in the CBOR codec. This is transparent to consumers — the codec handles conversion in both directions.

### MessageCodec Interface

```kyneta/packages/wire/src/codec.ts#L27-L37
export interface MessageCodec {
  /** Encode a single message to bytes. */
  encode(msg: ChannelMsg): Uint8Array

  /** Decode bytes back to a single message. */
  decode(data: Uint8Array): ChannelMsg

  /** Encode multiple messages to bytes (for batch frames). */
  encodeBatch(msgs: ChannelMsg[]): Uint8Array

  /** Decode bytes back to multiple messages (from batch frames). */
  decodeBatch(data: Uint8Array): ChannelMsg[]
}
```

### Usage

```/dev/null/codec-example.ts#L1-L14
import { cborCodec, jsonCodec } from "@kyneta/wire"
import type { ChannelMsg } from "@kyneta/transport"

const msg: ChannelMsg = {
  type: "discover",
  docIds: ["doc-1", "doc-2"],
}

// Binary transport — compact CBOR encoding
const binary = cborCodec.encode(msg)
const decoded = cborCodec.decode(binary)

// Text transport — human-readable JSON encoding
const json = jsonCodec.encode(msg)
```

## Frame Format

Each message (or batch) is wrapped in a **6-byte binary frame** before transmission:

```/dev/null/frame-layout.txt#L1-L7
┌──────────┬──────────┬──────────────────────────────────────────┐
│ Version  │  Flags   │         Payload Length                   │
│ (1 byte) │ (1 byte) │         (4 bytes, big-endian)            │
├──────────┴──────────┴──────────────────────────────────────────┤
│                 Payload (codec-encoded)                        │
└────────────────────────────────────────────────────────────────┘
```

- **Version** — currently `2`
- **Flags** — `0x00` for single message, `0x01` for batch (CBOR/JSON array)
- **Payload length** — `Uint32` big-endian byte count of the encoded payload

### Usage

```/dev/null/frame-example.ts#L1-L13
import { cborCodec, encodeFrame, encodeBatchFrame, decodeFrame } from "@kyneta/wire"

// Encode a single message into a framed binary payload
const frame = encodeFrame(cborCodec, msg)

// Encode multiple messages as a batch frame
const batch = encodeBatchFrame(cborCodec, [msg1, msg2])

// Decode always returns an array (single-element for non-batch)
const messages = decodeFrame(cborCodec, frame)      // [msg]
const batched = decodeFrame(cborCodec, batch)        // [msg1, msg2]
```

## Fragmentation

Cloud infrastructure imposes per-message size limits (e.g. AWS API Gateway: 128KB, Cloudflare: 1MB). The fragmentation protocol splits large framed payloads into transport-safe chunks.

### Transport Payload Prefixes

Each binary payload sent over the transport is prefixed with a single discriminator byte:

| Prefix | Meaning | Layout |
|--------|---------|--------|
| `0x00` | Complete message | `prefix (1) + framed payload` |
| `0x01` | Fragment header | `prefix (1) + batchId (8) + count (4 BE) + totalSize (4 BE)` |
| `0x02` | Fragment data | `prefix (1) + batchId (8) + index (4 BE) + data (variable)` |

### Fragmenting a Payload

```/dev/null/fragment-example.ts#L1-L16
import {
  encodeFrame, cborCodec,
  shouldFragment, fragmentPayload, wrapCompleteMessage,
} from "@kyneta/wire"

const frame = encodeFrame(cborCodec, largeMsg)
const THRESHOLD = 100 * 1024 // 100KB

if (shouldFragment(frame.length, THRESHOLD)) {
  // Returns [header, chunk0, chunk1, ...] — send each over the transport
  const fragments = fragmentPayload(frame, THRESHOLD)
  for (const fragment of fragments) {
    socket.send(fragment)
  }
} else {
  socket.send(wrapCompleteMessage(frame))
}
```

### FragmentReassembler

The `FragmentReassembler` is the stateful receiver that tracks in-flight batches, enforces timeouts, and reassembles fragments into the original framed payload.

```/dev/null/reassembler-example.ts#L1-L20
import { FragmentReassembler, decodeFrame, cborCodec } from "@kyneta/wire"

const reassembler = new FragmentReassembler({
  timeoutMs: 10_000,            // abandon incomplete batches after 10s
  maxConcurrentBatches: 32,     // track up to 32 in-flight batches
  maxTotalReassemblyBytes: 50 * 1024 * 1024,  // 50MB memory cap
  onTimeout: (batchId) => console.warn("Fragment batch timed out"),
})

// Feed raw transport payloads from the network
const result = reassembler.receiveRaw(data)

if (result.status === "complete") {
  // result.data is the reassembled framed payload
  const messages = decodeFrame(cborCodec, result.data)
}
// "pending" — waiting for more fragments
// "error" — duplicate, invalid index, timeout, etc.

reassembler.dispose() // clean up timers when done
```

### Reassembler Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `timeoutMs` | `10000` | Abandon incomplete batches after this duration |
| `maxConcurrentBatches` | `32` | Maximum in-flight batches tracked simultaneously |
| `maxTotalReassemblyBytes` | `50MB` | Memory cap across all in-flight batches (oldest evicted first) |
| `onTimeout` | — | Callback when a batch times out |
| `onEvicted` | — | Callback when a batch is evicted due to memory pressure |

## CBOR Compact Wire Format

The CBOR codec uses integer type discriminators and short field names to minimize payload size:

| Field | Meaning | Used by |
|-------|---------|---------|
| `t` | Message type discriminator | All messages |
| `id` | Peer ID | establish-request, establish-response |
| `n` | Peer name (optional) | establish-request, establish-response |
| `y` | Peer type (`"user"` / `"bot"` / `"service"`) | establish-request, establish-response |
| `docs` | Present doc entries array (`Array<{d, rt, ms, sh}>`) | present |
| `d` | Doc ID (within present entry) / payload data (offer) | present, offer |
| `rt` | Replica type tuple `[string, number, number]` | present (doc entry) |
| `ms` | Merge strategy (`0x00` causal, `0x01` sequential, `0x02` lww) | present (doc entry) |
| `sh` | Schema hash (34-char hex string, required) | present (doc entry) |
| `doc` | Document ID | interest, offer, dismiss |
| `v` | Version | interest (optional), offer |
| `r` | Reciprocate flag (optional) | interest, offer |
| `pk` | Payload kind (`0x00` entirety, `0x01` since) | offer |
| `pe` | Payload encoding (`0x00` json, `0x01` binary) | offer |

See [PROTOCOL.md](./PROTOCOL.md) for the full wire protocol specification.

## Peer Dependencies

```/dev/null/package.json#L1-3
{
  "peerDependencies": {
    "@kyneta/transport": ">=1.0.0"
  }
}
```

## License

MIT