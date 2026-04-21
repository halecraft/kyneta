# Kyneta Wire Protocol Specification

Wire protocol for `@kyneta/transport` message transport. Defines the universal `Frame<T>` abstraction, two encoding pipelines (binary and text), framing, fragmentation, and reassembly for the exchange's 6-message protocol.

## Overview

Every message sent over a transport is wrapped in a **frame**. The frame is the universal delivery unit — there is no unframed path. A frame carries a protocol version, an optional content hash, and content that is either **complete** (the full payload) or a **fragment** (one piece of a larger payload).

Two encoding pipelines share this frame abstraction:

| Pipeline | Payload type `T` | Wire format | Codec | Use case |
|----------|-------------------|-------------|-------|----------|
| **Binary** | `Uint8Array` | Binary bytes | `cborCodec` (BinaryCodec) | WebSocket, WebRTC |
| **Text** | `string` | JSON string | `textCodec` (TextCodec) | SSE, HTTP |

Batching is **orthogonal to framing**. The frame layer does not distinguish single messages from batches. The payload's own structure (CBOR array vs map, JSON array vs object) determines singular vs plural. The codec decides how to encode/decode; the frame just carries the payload.

## Message Types

Six message types form the exchange protocol:

| Discriminator (CBOR) | Type | Direction | Purpose |
|----------------------|------|-----------|---------|
| `0x01` | `establish` | Bidirectional | Announce peer identity |
| `0x02` | `depart` | Bidirectional | Signal peer departure |
| `0x10` | `present` | Bidirectional | Announce document IDs and metadata |
| `0x11` | `interest` | Bidirectional | Request a specific document's state |
| `0x12` | `offer` | Bidirectional | Deliver document state (snapshot or delta) |
| `0x13` | `dismiss` | Bidirectional | Retract interest in a document |

Discriminator ranges:
- `0x01–0x0F` — Lifecycle messages (establish, depart)
- `0x10–0x1F` — Sync messages (present, interest, offer, dismiss)

The text codec uses human-readable type strings (`"establish"`, `"present"`, etc.) instead of integer discriminators.

## Frame<T> — Universal Frame Abstraction

```typescript
type Frame<T> = {
  version: number
  hash: string | null       // null today; hex SHA-256 digest in the future
  content: Complete<T> | Fragment<T>
}

type Complete<T> = {
  kind: "complete"
  payload: T
}

type Fragment<T> = {
  kind: "fragment"
  frameId: string           // groups fragments of the same payload
  index: number             // 0-based position
  total: number             // total fragment count
  totalSize: number         // total payload size (bytes or characters)
  payload: T                // this fragment's chunk
}
```

Binary pipeline: `Frame<Uint8Array>`. Text pipeline: `Frame<string>`.

Fragments are **fully self-describing**. Every fragment carries `frameId`, `index`, `total`, and `totalSize`. There is no separate "fragment header" message — the receiver auto-creates collection state on first contact with a new `frameId`.

## Codec Interfaces

### BinaryCodec (Uint8Array in/out)

```typescript
interface BinaryCodec {
  encode(msg: ChannelMsg): Uint8Array
  decode(data: Uint8Array): ChannelMsg
  encodeBatch(msgs: ChannelMsg[]): Uint8Array
  decodeBatch(data: Uint8Array): ChannelMsg[]
}
```

Implementation: `cborCodec` — compact CBOR with integer discriminators and short field names. `Uint8Array` data in `SubstratePayload` is encoded natively as CBOR byte strings (no base64).

### TextCodec (JSON-safe objects in/out)

```typescript
interface TextCodec {
  encode(msg: ChannelMsg): unknown        // JSON-safe object
  decode(obj: unknown): ChannelMsg
  encodeBatch(msgs: ChannelMsg[]): unknown[]
  decodeBatch(objs: unknown[]): ChannelMsg[]
}
```

Implementation: `textCodec` — human-readable JSON with full type strings. `Uint8Array` data in `SubstratePayload` is transparently base64-encoded on write and base64-decoded on read. JSON `SubstratePayload` data passes through as-is.

## Binary Wire Format

### Frame Header (7 bytes)

```
Offset  Size   Field
──────  ─────  ──────────────────
0       1      Version (0x00)
1       1      Type (0x00 = complete, 0x01 = fragment)
2       1      Hash algorithm (0x00 = none, 0x01 = SHA-256 reserved)
3       4      Payload length (Uint32 big-endian)
```

### Complete Frame

```
[7-byte header]
[payload: codec-encoded bytes]
```

The type byte is `0x00`. Payload length covers the codec-encoded bytes.

### Fragment Frame

```
[7-byte header]
[frameId: 8 bytes]
[index: 4 bytes big-endian]
[total: 4 bytes big-endian]
[totalSize: 4 bytes big-endian]
[payload: chunk bytes]
```

The type byte is `0x01`. Payload length covers the **chunk data only** (not the 20 bytes of fragment metadata). Total frame size = 7 (header) + 20 (metadata) + payload length.

### Transport Prefixes

Binary frames are wrapped with a single-byte transport prefix for fast-path discrimination:

| Prefix | Name | Description |
|--------|------|-------------|
| `0x00` | `MESSAGE_COMPLETE` | A complete frame (single message or batch) |
| `0x01` | `FRAGMENT` | A fragment frame (self-describing) |

The receiver checks byte 0 to decide whether fragment collection is needed, without parsing the full frame header.

### CBOR Compact Encoding

The `cborCodec` encodes `ChannelMsg` objects as compact wire objects with short field names:

| Wire field | Full name | Type | Used by |
|------------|-----------|------|---------|
| `t` | type | integer discriminator | All messages |
| `id` | peerId | `string` | establish |
| `n` | name | `string` (optional) | establish |
| `y` | type | `"user" \| "bot" \| "service"` | establish |
| `docs` | docs | `Array<{d, rt, ms, sh}>` | present |
| `doc` | docId | `string` | interest, offer, dismiss |
| `sh` | schemaHash | `string` (34-char hex) | present (doc entry, required) |
| `d` | docId / data | `string` (present doc entry) or `string \| Uint8Array` (offer) | present, offer |
| `rt` | replicaType | `[string, number, number]` | present (doc entry) |
| `ms` | syncProtocol | `SyncProtocolWireValue` (`0x00` collaborative, `0x01` authoritative, `0x02` ephemeral) | present (doc entry) |
| `v` | version | `string` | interest (optional), offer |
| `r` | reciprocate | `boolean` (optional) | interest, offer |
| `pk` | payload kind | `0x00` (entirety) or `0x01` (since) | offer |
| `pe` | payload encoding | `0x00` (json) or `0x01` (binary) | offer |

### Binary Encoding Flow

```
Encode:
  ChannelMsg → cborCodec.encode(msg) → Uint8Array
  → encodeBinaryFrame(complete(0, payload)) → framed bytes
  → wrapCompleteMessage(framed) → transport payload

Decode:
  transport payload → parseTransportPayload → { kind: "complete", data }
  → decodeBinaryFrame(data) → Frame<Uint8Array> { content: Complete }
  → cborCodec.decode(payload) → ChannelMsg
```

## Text Wire Format

### Frame Prefix (2 characters)

The first element of the JSON array is a 2-character string:

```
Position 0: version character ('0' = version 0, '1' = version 1, ...)
Position 1: type + hash (case-encoded)
  'c' = complete, no hash
  'C' = complete, with SHA-256 hash (digest in next element)
  'f' = fragment, no hash
  'F' = fragment, with SHA-256 hash (digest in next element)
```

### Complete Frame

```json
["0c", <payload>]
```

The payload is a native JSON value — an object for a single message, an array for a batch. It is embedded directly (not as a string within a string).

With hash:

```json
["0C", "hexdigest", <payload>]
```

### Fragment Frame

```json
["0f", "frameId", index, total, totalSize, "chunk"]
```

The chunk is a JSON substring of the serialized payload. The receiver concatenates chunks in index order and `JSON.parse` the result.

With hash:

```json
["0F", "hexdigest", "frameId", index, total, totalSize, "chunk"]
```

### Text Encoding Flow

```
Encode:
  ChannelMsg → textCodec.encode(msg) → JSON-safe object
  → JSON.stringify(object) → payload string
  → encodeTextFrame(complete(0, payload)) → wire string

Decode:
  wire string → decodeTextFrame → Frame<string> { content: Complete }
  → JSON.parse(payload) → JSON-safe object
  → textCodec.decode(object) → ChannelMsg
```

### Text Fragmentation

Large payloads are split into JSON substring chunks:

```
Encode:
  payload string → fragmentTextPayload(payload, maxChunkSize) → wire string[]

Each wire string is a complete, self-describing fragment frame:
  ["0f", "a1b2c3d4", 0, 3, 1500, "{\"type\":\"offer\",\"docId\":\"doc"]
  ["0f", "a1b2c3d4", 1, 3, 1500, "-1\",\"offerType\":\"snapshot\",\"pa"]
  ["0f", "a1b2c3d4", 2, 3, 1500, "yload\":{\"encoding\":\"binary\"}}"]
```

## Fragmentation Protocol

### Self-Describing Fragments

Every fragment — binary or text — carries its full metadata:

| Field | Binary | Text |
|-------|--------|------|
| Frame ID | 8 bytes | JSON string (16 hex chars) |
| Index | 4 bytes big-endian | JSON number |
| Total | 4 bytes big-endian | JSON number |
| Total Size | 4 bytes big-endian | JSON number |
| Chunk | Raw bytes | JSON string (substring) |

There is no separate "fragment header" message. The `FragmentCollector` auto-creates tracking state when it first encounters a new frame ID.

### FragmentCollector<T> — Generic Reassembly

The `FragmentCollector<T>` is parameterized on the chunk type:

- Binary: `FragmentCollector<Uint8Array>` with byte concatenation
- Text: `FragmentCollector<string>` with `chunks.join("")`

**Design: Functional Core / Imperative Shell**

The pure `decideFragment()` function takes the current batch state and fragment metadata, returning a decision with zero side effects:

```typescript
type FragmentDecision =
  | { action: "create_and_accept" }
  | { action: "accept" }
  | { action: "complete" }
  | { action: "reject_duplicate" }
  | { action: "reject_invalid_index" }
  | { action: "reject_total_mismatch" }
  | { action: "reject_size_mismatch" }
```

The `FragmentCollector` class (imperative shell) executes decisions by mutating state, managing timers, and enforcing limits.

### Collector Limits

| Parameter | Default | Purpose |
|-----------|---------|---------|
| Timeout | 10s | Abandon incomplete frames |
| Max concurrent frames | 32 | Limit tracking overhead |
| Max total size | 50MB / 50M chars | Memory cap (oldest frame evicted first) |

### Reassembler Wrappers

- `FragmentReassembler` — binary wrapper. Parses transport prefixes and binary frame headers, delegates to `FragmentCollector<Uint8Array>`.
- `TextReassembler` — text wrapper. Parses JSON text frames, delegates to `FragmentCollector<string>`.

Both are thin wrappers (~80–100 lines) that handle format-specific parsing and delegate all collection logic to the generic collector.

### Binary Fragmentation

```
Sender:
  1. Encode message → complete binary frame (7-byte header + payload)
  2. If frame size ≤ threshold: wrapCompleteMessage(frame) → send
  3. If frame size > threshold:
     a. Generate random 8-byte frame ID (hex string)
     b. Split payload into chunks of maxChunkSize bytes
     c. For each chunk: build fragment frame (header + metadata + chunk)
     d. wrapFragment(fragmentFrame) → send each

Receiver:
  1. parseTransportPayload(data)
  2. If complete: decodeBinaryFrame(data) → Frame<Uint8Array> → codec.decode
  3. If fragment: decodeBinaryFrame(data) → Frame<Uint8Array> with Fragment content
     → collector.addFragment(frameId, index, total, totalSize, chunk)
     → eventually: complete data → codec.decode
```

### Fragment Thresholds by Environment

| Environment | Frame limit | Recommended threshold |
|-------------|-------------|----------------------|
| AWS API Gateway | 128KB | **100KB** (default) |
| Cloudflare Workers | 1MB | **500KB** |
| Self-hosted (Bun, Node.js) | Unlimited | **0** (disabled) |

## Hash Support (Reserved)

Every frame carries a hash slot — `null`/`0x00` today, reserved for future SHA-256 content verification.

**Binary**: Hash algorithm byte in the frame header (byte 2). `0x00` = none, `0x01` = SHA-256 (32-byte digest follows the header).

**Text**: Case-encoded in the prefix character. Lowercase (`c`, `f`) = no hash. Uppercase (`C`, `F`) = SHA-256 hex digest in the next array element.

Per-frame hashing enables **streaming verification**: the sender hashes and sends each frame independently. For fragments, this means per-chunk verification without waiting for reassembly.

## Text Frame Signaling

### Keepalive (WebSocket only)

The client sends a text `"ping"` frame at a configurable interval (default: 30s). The server responds with a text `"pong"`. These are application-level text messages, not WebSocket protocol-level ping/pong frames.

### Ready Signal (WebSocket only)

After the WebSocket connection opens, the server sends a text `"ready"` frame to indicate it is prepared to receive protocol messages. The client waits for this signal before creating its channel and sending `establish-request`.

```
1. Client opens WebSocket          → state: connecting
2. WebSocket open event fires      → state: connected
3. Server sends text "ready"       → state: ready
4. Client sends establish  (binary frame)
5. Server sends establish  (binary frame)
6. Protocol messages flow freely
```

## Pipeline Architecture

```
Binary pipeline (WebSocket, WebRTC):
  BinaryCodec (CBOR) → binary frame (7B header) → binary fragmentation → FragmentReassembler
                                                                           └→ FragmentCollector<Uint8Array>

Text pipeline (SSE, HTTP):
  TextCodec (JSON) → text frame ("Vx" prefix) → text fragmentation → TextReassembler
                                                                       └→ FragmentCollector<string>

Shared:
  Frame<T> type ← universal frame abstraction
  FragmentCollector<T> ← generic reassembly (FC/IS design)
  CollectorOps<T> ← injected { sizeOf, concatenate }
```

## File Map

| File | Purpose |
|------|---------|
| `src/frame-types.ts` | `Frame<T>`, `Complete<T>`, `Fragment<T>` types, constructors, type guards |
| `src/codec.ts` | `BinaryCodec` and `TextCodec` interfaces |
| `src/cbor.ts` | `cborCodec` — CBOR BinaryCodec implementation |
| `src/json.ts` | `textCodec` — JSON TextCodec implementation |
| `src/constants.ts` | Wire version, header size, frame types, transport prefixes, fragment sizes |
| `src/wire-types.ts` | CBOR integer discriminators and compact field names |
| `src/frame.ts` | Binary frame encode/decode (`encodeBinaryFrame`, `decodeBinaryFrame`, convenience functions) |
| `src/text-frame.ts` | Text frame encode/decode (`encodeTextFrame`, `decodeTextFrame`, `fragmentTextPayload`) |
| `src/fragment.ts` | Binary transport payload construction/parsing, `fragmentPayload`, hex/ID helpers |
| `src/fragment-collector.ts` | Generic `FragmentCollector<T>`, pure `decideFragment`, `CollectorOps<T>`, `TimerAPI` |
| `src/reassembler.ts` | `FragmentReassembler` — binary wrapper around `FragmentCollector<Uint8Array>` |
| `src/text-reassembler.ts` | `TextReassembler` — text wrapper around `FragmentCollector<string>` |

## Protocol Version History

| Version | Changes |
|---------|---------|
| 0 | Current. Unified `Frame<T>` architecture. 7-byte binary header (version, type, hashAlgo, payloadLength). Two transport prefixes (complete, fragment). Self-describing fragments. Text wire format with 2-char prefix. Generic `FragmentCollector<T>`. Hash slot reserved. Replaces unreleased v2. |