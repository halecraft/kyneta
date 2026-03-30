# Kyneta Wire Protocol Specification

Binary wire protocol for `@kyneta/exchange` message transport. Defines encoding, framing, fragmentation, and transport-level signaling for the exchange's 5-message protocol.

## Message Types

Five message types with integer discriminators for compact CBOR encoding:

| Discriminator | Type | Direction | Purpose |
|---------------|------|-----------|---------|
| `0x01` | `establish-request` | Client → Server | Initiate peer identity handshake |
| `0x02` | `establish-response` | Server → Client | Confirm peer identity |
| `0x10` | `discover` | Bidirectional | Announce or query document IDs |
| `0x11` | `interest` | Bidirectional | Request a specific document's state |
| `0x12` | `offer` | Bidirectional | Deliver document state (snapshot or delta) |

Discriminator ranges:
- `0x01–0x0F` — Connection establishment
- `0x10–0x1F` — Exchange messages

## CBOR Compact Encoding

The CBOR codec encodes `ChannelMsg` objects as compact wire objects with short field names and integer discriminators. The JSON codec uses the full `ChannelMsg` shape directly and does not use these compact names.

### Field Name Map

| Wire field | Full name | Type | Used by |
|------------|-----------|------|---------|
| `t` | type | `MessageTypeValue` (integer) | All messages |
| `id` | peerId | `string` | establish-request, establish-response |
| `n` | name | `string` (optional) | establish-request, establish-response |
| `y` | type | `"user" \| "bot" \| "service"` | establish-request, establish-response |
| `docs` | docIds | `string[]` | discover |
| `doc` | docId | `string` | interest, offer |
| `v` | version | `string` | interest (optional), offer |
| `r` | reciprocate | `boolean` (optional) | interest, offer |
| `ot` | offerType | `0x00` (snapshot) or `0x01` (delta) | offer |
| `pe` | payload encoding | `0x00` (json) or `0x01` (binary) | offer |
| `d` | data | `string \| Uint8Array` | offer |

### Wire Object Shapes

**establish-request / establish-response:**

```/dev/null/wire-establish.cbor#L1-4
{
  t: 0x01 | 0x02,
  id: "peer-id-string",
  n: "optional-name",
  y: "user" | "bot" | "service"
}
```

**discover:**

```/dev/null/wire-discover.cbor#L1-3
{
  t: 0x10,
  docs: ["doc-id-1", "doc-id-2"]
}
```

**interest:**

```/dev/null/wire-interest.cbor#L1-5
{
  t: 0x11,
  doc: "doc-id",
  v: "version-string",       // optional
  r: true                    // optional
}
```

**offer:**

```/dev/null/wire-offer.cbor#L1-8
{
  t: 0x12,
  doc: "doc-id",
  ot: 0x00 | 0x01,           // snapshot | delta
  pe: 0x00 | 0x01,           // json | binary
  d: <string or byte-string>,
  v: "version-string",
  r: true                    // optional
}
```

### Binary Payload Handling

`SubstratePayload` with `encoding: "binary"` contains a `Uint8Array`:

- **CBOR codec** — encoded natively as a CBOR byte string (major type 2). No base64 overhead.
- **JSON codec** — transparently base64-encoded on write, base64-decoded on read. The `d` field is always a JSON string.

## Frame Structure

Every encoded message (or batch of messages) is wrapped in a 6-byte binary frame header before transmission.

```/dev/null/frame-layout.txt#L1-6
Offset  Size   Field
──────  ─────  ──────────────────────────────
0       1      Version (currently 0x02)
1       1      Flags
2       4      Payload length (Uint32 big-endian)
6       N      Payload (codec-encoded bytes)
```

### Version

Current protocol version: **2** (`0x02`). Receivers reject frames with an unrecognized version.

### Flags

| Bit | Name | Meaning |
|-----|------|---------|
| `0x00` | `NONE` | Payload is a single encoded message |
| `0x01` | `BATCH` | Payload is an encoded array of messages |
| `0x02` | `COMPRESSED` | Reserved for future compression support |

### Encoding Flow

```/dev/null/encoding-flow.txt#L1-3
ChannelMsg → codec.encode() → payload bytes → frame header + payload → transport
ChannelMsg[] → codec.encodeBatch() → payload bytes → frame header (BATCH) + payload → transport
```

### Decoding Flow

```/dev/null/decoding-flow.txt#L1-5
transport → frame bytes
         → parse header (version, flags, payload length)
         → extract payload slice
         → flags & BATCH ? codec.decodeBatch(payload) : [codec.decode(payload)]
         → ChannelMsg[]
```

`decodeFrame` always returns `ChannelMsg[]` — a single-element array for non-batch frames.

## Transport Layer

The transport layer sits between framing and the Websocket. It uses a single-byte prefix on every binary message to distinguish complete messages from fragment streams.

### Binary Message Prefixes

| Prefix | Name | Followed by |
|--------|------|-------------|
| `0x00` | `MESSAGE_COMPLETE` | Framed payload (header + encoded data) |
| `0x01` | `FRAGMENT_HEADER` | `batchId (8)` + `count (4 BE)` + `totalSize (4 BE)` |
| `0x02` | `FRAGMENT_DATA` | `batchId (8)` + `index (4 BE)` + `data (variable)` |

### Complete Message Layout

```/dev/null/complete-message.txt#L1-4
Offset  Size   Field
──────  ─────  ──────────────────────────
0       1      0x00 (MESSAGE_COMPLETE)
1       N      Framed payload (6-byte header + encoded bytes)
```

### Fragment Header Layout

```/dev/null/fragment-header.txt#L1-6
Offset  Size   Field
──────  ─────  ──────────────────────────
0       1      0x01 (FRAGMENT_HEADER)
1       8      Batch ID (random, crypto.getRandomValues)
9       4      Fragment count (Uint32 big-endian)
13      4      Total payload size in bytes (Uint32 big-endian)
```

Total: **17 bytes**

### Fragment Data Layout

```/dev/null/fragment-data.txt#L1-6
Offset  Size   Field
──────  ─────  ──────────────────────────
0       1      0x02 (FRAGMENT_DATA)
1       8      Batch ID (matches header)
9       4      Fragment index (Uint32 big-endian, 0-based)
13      N      Fragment data bytes
```

Per-fragment overhead: **13 bytes**

## Fragmentation Protocol

Large framed payloads that exceed a transport's size limit are split into fragments. The sender transmits a fragment header followed by sequentially indexed data chunks. The receiver reassembles them by batch ID.

### Sender Algorithm

```/dev/null/sender-algorithm.txt#L1-8
1. Encode message → framed payload (frame header + codec bytes)
2. If framed payload size <= threshold:
     Send as MESSAGE_COMPLETE (0x00 prefix + framed payload)
3. If framed payload size > threshold:
     a. Generate random 8-byte batch ID
     b. Calculate fragment count = ceil(payload size / max fragment size)
     c. Send FRAGMENT_HEADER (batch ID, count, total size)
     d. For each chunk i in 0..count: send FRAGMENT_DATA (batch ID, i, chunk bytes)
```

### Receiver Algorithm (FragmentReassembler)

```/dev/null/receiver-algorithm.txt#L1-12
1. Parse transport prefix byte
2. If MESSAGE_COMPLETE (0x00):
     Return payload immediately → decodeFrame
3. If FRAGMENT_HEADER (0x01):
     Create batch state (expected count, total size, start timer)
4. If FRAGMENT_DATA (0x02):
     a. Look up batch by ID
     b. Store fragment at index
     c. If all fragments received:
          Concatenate in index order
          Verify total size matches header
          Return reassembled payload → decodeFrame
```

### Reassembler Limits

| Parameter | Default | Purpose |
|-----------|---------|---------|
| Batch timeout | 10s | Abandon incomplete batches |
| Max concurrent batches | 32 | Limit tracking overhead |
| Max total reassembly bytes | 50MB | Memory cap (oldest batch evicted first) |

### Fragment Thresholds by Environment

Cloud WebSocket gateways impose per-frame size limits. Set the fragment threshold below the infrastructure limit to ensure reliable delivery.

| Environment | Frame limit | Recommended threshold |
|-------------|-------------|----------------------|
| AWS API Gateway | 128KB | **100KB** (default) |
| Cloudflare Workers | 1MB | **500KB** |
| Self-hosted (Bun, Node.js) | Unlimited | **0** (disabled) |

A threshold of `0` disables fragmentation entirely — all messages are sent as `MESSAGE_COMPLETE`.

## Text Frame Signaling

Three text (non-binary) frame types provide transport-level signaling outside the binary protocol:

### Keepalive

The client sends a text `"ping"` frame at a configurable interval (default: 30s). The server responds with a text `"pong"` frame. This keeps connections alive through proxies and load balancers that terminate idle TCP connections.

```/dev/null/keepalive.txt#L1-2
Client → Server:  "ping"  (text frame)
Server → Client:  "pong"  (text frame)
```

These are application-level text messages, not WebSocket protocol-level ping/pong frames.

### Ready Signal

After the WebSocket connection opens, the server sends a text `"ready"` frame to indicate it is prepared to receive protocol messages. The client waits for this signal before creating its channel and sending `establish-request`.

```/dev/null/ready-signal.txt#L1-6
1. Client opens WebSocket          → state: connecting
2. WebSocket open event fires      → state: connected
3. Server sends text "ready"       → state: ready
4. Client sends establish-request  (binary, 0x01)
5. Server sends establish-response (binary, 0x02)
6. Protocol messages flow freely
```

This prevents a race condition where the client's binary `establish-request` could arrive before the server has finished setting up the connection's channel.

## Protocol Version History

| Version | Changes |
|---------|---------|
| 2 | Current. 6-byte frame header, CBOR/JSON codecs, transport-level fragmentation. |