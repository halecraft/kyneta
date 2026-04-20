# @kyneta/wire — Technical Reference

> **Package**: `@kyneta/wire`
> **Role**: The universal wire format — one `Frame<T>` abstraction, two codecs (binary CBOR + text JSON), two framings (7-byte binary header + 2-char text prefix), one fragmentation protocol, and a pure byte-stream parser for stream-oriented transports.
> **Depends on**: `@kyneta/transport` (peer)
> **Depended on by**: `@kyneta/websocket-transport`, `@kyneta/sse-transport`, `@kyneta/webrtc-transport`, `@kyneta/unix-socket-transport`
> **Canonical symbols**: `Frame<T>`, `Complete<T>`, `Fragment<T>`, `complete`, `fragment`, `isComplete`, `isFragment`, `BinaryCodec`, `TextCodec`, `cborCodec`, `textCodec`, `encodeBinaryFrame`, `decodeBinaryFrame`, `encodeComplete`, `encodeCompleteBatch`, `encodeTextFrame`, `decodeTextFrame`, `FragmentCollector<T>`, `decideFragment`, `FragmentReassembler`, `TextReassembler`, `encodeBinaryAndSend`, `decodeBinaryMessages`, `feedBytes`, `initialParserState`, `StreamParserState`, `WIRE_VERSION`, `HEADER_SIZE`, `FRAGMENT_META_SIZE`, `FrameDecodeError`, `TextFrameDecodeError`, `SyncProtocolWire`, `SyncProtocolWireValue`, `SyncProtocolWireToProtocol`, `syncProtocolToWire`
> **Key invariant(s)**: Every byte that crosses a transport is a `Frame<T>`. A frame is either `Complete<T>` (full payload) or `Fragment<T>` (one chunk of a larger payload). Batching is not a frame concern — the codec's payload is self-describing (CBOR array vs map, JSON array vs object).

A small kit for turning `ChannelMsg` values from `@kyneta/transport` into bytes (or JSON-safe strings) that can travel over any wire, and turning them back. It is pure protocol mechanics — encoding, framing, fragmentation, reassembly — with no transport-specific logic.

Consumed by every concrete transport package. Not used by application code. `@kyneta/exchange` does not import this package directly; it produces `ChannelMsg` values that transports then encode via wire.

---

## Questions this document answers

- What is a `Frame<T>` and why parameterize by `T`? → [Frame — the universal abstraction](#frame--the-universal-abstraction)
- Why do we have our own CBOR encoder instead of an npm library? → [Why an internal CBOR codec](#why-an-internal-cbor-codec)
- What is fragmentation for and when does it fire? → [Fragmentation](#fragmentation)
- How are batched messages encoded? → [Batching is a codec concern, not a frame concern](#batching-is-a-codec-concern-not-a-frame-concern)
- How does a stream-oriented transport extract frames from a byte stream? → [Stream framing](#stream-framing)
- What's the binary frame layout on the wire? → [Binary frame layout](#binary-frame-layout)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `Frame<T>` | `{ version, hash, content: Complete<T> \| Fragment<T> }` — the universal delivery unit. | A networking "frame" in the ISO-OSI sense; an HTML/animation frame |
| `Complete<T>` | `{ kind: "complete", payload: T }` — the frame carries the whole message (single or batch). | `Fragment<T>` |
| `Fragment<T>` | `{ kind: "fragment", frameId, index, total, totalSize, payload }` — one chunk of a larger payload. | A TCP/IP network fragment; a URL fragment |
| `BinaryCodec` | `ChannelMsg ↔ Uint8Array` — CBOR encoding for binary transports. | `TextCodec` |
| `TextCodec` | `ChannelMsg ↔ JSON-safe value` — JSON encoding (text transports). Binary `SubstratePayload` is transparently base64'd. | `BinaryCodec`; also: `string` — `TextCodec` produces *objects*, serialized to a string by the text frame layer |
| `cborCodec` | The exported `BinaryCodec` instance. | `cbor-encoding.ts`, which is the internal CBOR encoder/decoder |
| `textCodec` | The exported `TextCodec` instance. | `JSON.stringify` — text codec encoding is JSON-*compatible* but structured (discriminated message shapes, not raw objects) |
| `WIRE_VERSION` | The current binary wire protocol version (`0`). | A schema version, a package version |
| `HEADER_SIZE` | The binary frame header size in bytes (`7`). | The fragment metadata size (`FRAGMENT_META_SIZE` = 20) |
| `FRAGMENT_META_SIZE` | The per-fragment metadata appended after the header: `frameId(8) + index(4) + total(4) + totalSize(4) = 20`. | `FRAGMENT_MIN_SIZE` (= `HEADER_SIZE + FRAGMENT_META_SIZE + 1`) |
| `FragmentCollector<T>` | Generic stateful fragment-collection shell, parameterized on chunk type (`Uint8Array` or `string`). | `FragmentReassembler` / `TextReassembler`, which are concrete wrappers around it |
| `decideFragment` | The pure decision function at the heart of `FragmentCollector`. | The collector itself — the collector mutates state; `decideFragment` does not |
| `StreamParserState` | Discriminated union `{ phase: "header" } \| { phase: "payload" }` — the parser's current accumulation phase. | `FragmentCollector` state — stream framing is orthogonal to fragmentation |
| `feedBytes(state, chunk)` | Pure step function: new state + zero or more extracted frames. | A side-effecting parse loop |

---

## Architecture

**Thesis**: one abstract frame type covers every wire. The binary (CBOR) pipeline and the text (JSON) pipeline share all their structural logic — only the payload type differs.

Two pipelines, one shape:

| Pipeline | `T` | Codec | Frame encoding | Transports |
|----------|-----|-------|----------------|------------|
| Binary | `Uint8Array` | `cborCodec` (`BinaryCodec`) | 7-byte header + payload (+ 20-byte fragment meta if fragment) | WebSocket, WebRTC, Unix socket |
| Text | `string` | `textCodec` (`TextCodec`) | `"Vx"` prefix + JSON string (+ fragment meta inline) | SSE, HTTP |

A message's journey:

```
ChannelMsg ─┬→ codec.encode ──► T (payload bytes/string)
            │
            └→ fragment if payload > limit
                    │
                    ▼
              Frame<T> (Complete or Fragment per piece)
                    │
                    ▼
              encodeBinaryFrame / encodeTextFrame
                    │
                    ▼
              over the wire
```

The reverse path: bytes → `decodeBinaryFrame`/`decodeTextFrame` → `Frame<T>` → reassembler (if fragment) → `codec.decode` → `ChannelMsg[]`.

### What a `Frame` is NOT

- **Not an ISO-OSI frame.** No link-layer semantics, no addressing, no sequence numbers in the traditional sense. A kyneta frame is a single application-level delivery unit with a version byte and an optional content hash.
- **Not an animation frame.** No relation to rAF, repaint cycles, or video frames.
- **Not order-preserving across frames.** One frame holds one payload. Multi-message ordering semantics live in the codec (a batch = one payload with multiple messages) or in the substrate layer above.
- **Not self-addressed.** A frame has no sender or receiver in its header. Routing is the transport's concern (`AddressedEnvelope` / `ReturnEnvelope` from `@kyneta/transport`).

### What fragmentation is NOT

- **Not TCP/IP fragmentation.** It does not split at an MTU boundary and it is not below the transport layer. Cloud WebSocket gateways (AWS API Gateway: 128KB, Cloudflare Workers: 1MB) impose message-size caps that are orders of magnitude above the network MTU. Fragmentation exists so one semantic message that exceeds the gateway cap can be delivered as several cap-sized pieces.
- **Not automatic for all transports.** Unix sockets have no message-size cap — their pipeline uses stream framing instead (see [Stream framing](#stream-framing)). WebRTC uses fragmentation for per-datagram size limits. WebSocket uses fragmentation only when a cloud gateway is in play.
- **Not ordered across frame IDs.** Fragments of *different* `frameId`s may interleave freely; fragments of the *same* `frameId` must all arrive for reassembly to succeed.

---

## `Frame<T>` — the universal abstraction

Source: `packages/exchange/wire/src/frame-types.ts`.

```
Frame<T> = {
  version: number
  hash: string | null          // null today; reserved for hex SHA-256 digest
  content: Complete<T> | Fragment<T>
}
```

`Complete<T>` carries a single `payload: T`. `Fragment<T>` carries `frameId`, `index`, `total`, `totalSize`, and a chunk. Constructors: `complete(version, payload, hash?)` and `fragment(version, frameId, index, total, totalSize, payload, hash?)`. Type guards: `isComplete(frame)`, `isFragment(frame)`.

The two type parameters actually used in the codebase are `Frame<Uint8Array>` and `Frame<string>` — one per pipeline.

### Batching is a codec concern, not a frame concern

A single `ChannelMsg` encodes as a CBOR map or a JSON object; a batch of `ChannelMsg` encodes as a CBOR array or a JSON array. The codec's `encode` accepts either; the codec's `decode` auto-detects and always returns `ChannelMsg[]`. The frame layer never inspects the payload — it is a length-prefixed byte blob or a prefixed string.

This separation is why there is no `BATCH` flag on the wire. Adding batching required zero frame changes.

---

## Binary frame layout

Source: `packages/exchange/wire/src/constants.ts`, `packages/exchange/wire/src/frame.ts`.

```
 0       1       2       3                             7
┌───────┬───────┬───────┬─────────────────────────────┐
│ Vers  │ Type  │ Hash  │   Payload length (u32 BE)   │
└───────┴───────┴───────┴─────────────────────────────┘
  (optional: 32 bytes of SHA-256 digest, if Hash != NONE)
  (if Type == FRAGMENT: 20 bytes of fragment metadata)
  payload bytes...
```

| Byte(s) | Field | Values |
|---------|-------|--------|
| 0 | `version` | `WIRE_VERSION = 0` |
| 1 | `type` | `BinaryFrameType.COMPLETE = 0x00` / `BinaryFrameType.FRAGMENT = 0x01` |
| 2 | `hashAlgo` | `HASH_ALGO.NONE = 0x00` / `HASH_ALGO.SHA256 = 0x01` (reserved — never written today) |
| 3–6 | `payloadLength` | `u32` big-endian, length of the payload bytes that follow |
| 7–38 | *hash digest* | present only when `hashAlgo != NONE`; never today |
| 7+ (or 39+) | *fragment meta* | if `type == FRAGMENT`: `frameId(8) + index(u32 BE) + total(u32 BE) + totalSize(u32 BE)` = 20 bytes |
| … | `payload` | `payloadLength` bytes |

`encodeBinaryFrame(frame)` writes this layout; `decodeBinaryFrame(bytes)` reads it. Truncation, version mismatch, unknown hash algorithm, and unknown frame type all raise `FrameDecodeError` (with a typed `code` discriminant).

### Convenience encoders

| Function | Produces |
|----------|----------|
| `encodeComplete(codec, msg)` | `Uint8Array` — single `ChannelMsg` → complete binary frame |
| `encodeCompleteBatch(codec, msgs)` | `Uint8Array` — array of `ChannelMsg` → complete binary frame (codec auto-detects batch) |
| `encodeBinaryAndSend(codec, msg, sendFn)` | Fragments if necessary, encodes each piece, calls `sendFn` per frame (source: `src/binary-transport.ts`) |
| `decodeBinaryMessages(codec, reassembler, bytes)` | `ChannelMsg[]` — handles fragments via the reassembler and returns any fully-reassembled messages |

---

## Why an internal CBOR codec

Source: `packages/exchange/wire/src/cbor-encoding.ts`.

`@kyneta/wire` does not depend on `@levischuck/tiny-cbor` or any other CBOR library. The comment at the top of `cbor-encoding.ts` records two specific bugs the replacement fixes:

1. `encodeString` used JavaScript `.length` (UTF-16 code units) instead of UTF-8 byte length for the CBOR text-string header — any non-ASCII string was corrupted on encode.
2. `decodePartialCBOR` constructed `DataView` without `byteOffset`, so a `Uint8Array` view into a shared `ArrayBuffer` (Node's pooled `Buffer`, Bun's internal buffers) would read from the wrong position.

The internal implementation covers RFC 8949 major types 0–7 — exactly the subset kyneta uses. No CBOR tags (major type 6), no indefinite-length encoding.

### What `cborCodec` is NOT

- **Not a general-purpose CBOR library.** It encodes only the `WireMessage` shape. Arbitrary CBOR values are not supported and not a goal.
- **Not `@levischuck/tiny-cbor` or `cbor-x`.** It is a focused, self-contained replacement sized to kyneta's needs.
- **Not symmetric with `textCodec` byte-for-byte.** Both codecs produce the *same* `ChannelMsg[]` on decode, but the bytes/strings they emit are completely different formats.

### Compact wire-message shape

Source: `packages/exchange/wire/src/wire-types.ts`. The CBOR codec maps `ChannelMsg` fields to integer discriminants and short field names to minimize bytes on the wire. The public `MessageType`, `PayloadEncoding`, `PayloadKind` enums (and their `*ToString` / `StringTo*` reverse maps) are exported for any code that must match the wire representation directly.

The `ms` field in `present` doc entries carries a `SyncProtocolWireValue` — an integer discriminant that encodes the `SyncProtocol` for wire transport. The lookup tables `SyncProtocolWire`, `SyncProtocolWireToProtocol`, and `syncProtocolToWire` handle the conversion between the structured `SyncProtocol` record and its wire representation.

**Wire-level backward compatibility**: The integer discriminants are unchanged from the former `MergeStrategyWire` enum — `0x00` = Collaborative, `0x01` = Authoritative, `0x02` = Ephemeral. Only the lookup table names and the domain-side type changed (from a string enum to a structured `SyncProtocol` record). Existing wire bytes are fully compatible; no protocol version bump is required.

---

## Text pipeline

Source: `packages/exchange/wire/src/json.ts`, `packages/exchange/wire/src/text-frame.ts`.

The text pipeline mirrors the binary pipeline but with JSON-safe objects and a character-prefix framing. `TEXT_WIRE_VERSION` is the text-pipeline version constant. Text frames use a two-character `"Vx"` prefix (where `x` encodes the version) followed by the JSON string.

Binary `SubstratePayload.bytes` data is base64-encoded by `textCodec` on write and decoded on read, so the resulting object is safely JSON-serializable.

Fragmentation and reassembly work identically to the binary pipeline, via `fragmentTextPayload` / `TextReassembler` (which is a thin wrapper over the generic `FragmentCollector<string>`).

---

## Fragmentation

Source: `packages/exchange/wire/src/fragment.ts`, `packages/exchange/wire/src/fragment-collector.ts`.

`shouldFragment(payloadSize, maxSize)` decides whether a payload needs to be split. `fragmentPayload(payload, maxSize)` splits it and returns `Fragment<T>[]`. Each fragment carries `frameId` (8-byte random), `index`, `total`, and `totalSize` so the receiver can reassemble without side-channel state.

### `FragmentCollector<T>` — functional core / imperative shell

`decideFragment(state, fragment, config)` is pure (source: `src/fragment-collector.ts`). It takes the collector's state and a new fragment, and returns a `FragmentDecision` describing what to do — store the fragment, complete the batch, evict an older frame, reject a duplicate, or timeout.

`FragmentCollector<T>` is the imperative shell that applies decisions: it mutates internal state, schedules timers via an injected `TimerAPI`, and enforces `maxConcurrentFrames` + `maxTotalSize`.

| Config field | Default | Purpose |
|--------------|---------|---------|
| `timeoutMs` | `10000` | Abandon a frame not fully received within this window |
| `maxConcurrentFrames` | `32` | Cap on in-flight frame IDs; oldest evicted on overflow |
| `maxTotalSize` | `50 × 1024 × 1024` | Cap on summed bytes across all in-flight frames |
| `onTimeout` | — | Called when a frame is abandoned |
| `onEvicted` | — | Called when a frame is evicted due to pressure |

The `TimerAPI` is injected (not captured from `globalThis`) so tests can drive time deterministically.

### `FragmentReassembler` and `TextReassembler`

Thin wrappers around `FragmentCollector<Uint8Array>` and `FragmentCollector<string>` respectively. They adapt the generic collector's `CollectorOps<T>` (`sizeOf`, `concatenate`) and return a `ReassembleResult` that either yields a complete payload, a pending state, or an error.

---

## Stream framing

Source: `packages/exchange/wire/src/stream-frame-parser.ts`.

Unix sockets and any stream-oriented transport deliver bytes as a coalesced stream. Writes may merge; reads deliver arbitrary chunks. `feedBytes(state, chunk)` is the pure step function that extracts complete frames:

```
feedBytes(state, chunk) → {
  state:  StreamParserState
  frames: Uint8Array[]
}
```

`StreamParserState` is a two-phase discriminated union: `{ phase: "header", buffer, offset }` while the 7-byte header accumulates, then `{ phase: "payload", header, payloadLength, buffer, offset }` while the declared payload accumulates. When a payload completes, the parser emits the full frame bytes and resets to `"header"`.

The parser handles every edge case by construction:

- Single complete frame in one chunk
- Frame split across multiple chunks (partial header, partial payload)
- Multiple frames in one chunk (write coalescing)
- Empty chunks (no-op)
- Arbitrary chunk boundaries

### What stream framing is NOT

- **Not a decoder.** `feedBytes` emits raw frame bytes; the caller pipes them through `decodeBinaryFrame` + `codec.decode`.
- **Not a fragment collector.** Stream framing and payload fragmentation are orthogonal — a Unix-socket transport uses stream framing because it has no gateway cap, and does not use fragmentation at all.
- **Not a parser for the text pipeline.** SSE has its own event-boundary framing; the text pipeline uses `decodeTextFrame` directly on each event's `data:` field.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `Frame<T>`, `Complete<T>`, `Fragment<T>` | `src/frame-types.ts` | Universal frame algebra + constructors + guards. |
| `BinaryCodec`, `TextCodec` | `src/codec.ts` | Codec interfaces. |
| `cborCodec` | `src/cbor.ts` | The exported `BinaryCodec`. |
| `textCodec` | `src/json.ts` | The exported `TextCodec`. |
| `WireMessage`, `Wire*Msg`, `MessageType`, `PayloadEncoding`, `PayloadKind` | `src/wire-types.ts` | Compact wire-message shape + enum discriminants. |
| `SyncProtocolWire`, `SyncProtocolWireValue`, `SyncProtocolWireToProtocol`, `syncProtocolToWire` | `src/wire-types.ts` | Wire encoding for `SyncProtocol` — integer discriminants (`0x00`/`0x01`/`0x02`) and bidirectional lookup tables. |
| `WIRE_VERSION`, `HEADER_SIZE`, `FRAGMENT_META_SIZE`, `FRAGMENT_MIN_SIZE`, `FRAME_ID_SIZE`, `BinaryFrameType`, `HASH_ALGO`, `MESSAGE_COMPLETE`, `FRAGMENT` | `src/constants.ts` | Wire constants. |
| `encodeBinaryFrame`, `decodeBinaryFrame`, `encodeComplete`, `encodeCompleteBatch`, `FrameDecodeError` | `src/frame.ts` | Binary frame I/O. |
| `encodeTextFrame`, `decodeTextFrame`, `encodeTextComplete`, `encodeTextCompleteBatch`, `fragmentTextPayload`, `TEXT_WIRE_VERSION`, `TextFrameDecodeError` | `src/text-frame.ts` | Text frame I/O. |
| `fragmentPayload`, `shouldFragment`, `wrapCompleteMessage`, `wrapFragment`, `parseTransportPayload`, `calculateFragmentationOverhead`, `generateFrameId`, `bytesToHex`, `hexToBytes`, `FragmentParseError`, `TransportPayload` | `src/fragment.ts` | Fragmentation primitives. |
| `FragmentCollector<T>`, `decideFragment`, `FragmentDecision`, `CollectorConfig`, `CollectorOps<T>`, `CollectorResult`, `CollectorError`, `TimerAPI` | `src/fragment-collector.ts` | Generic collector (FC/IS). |
| `FragmentReassembler`, `ReassembleResult`, `ReassembleError`, `ReassemblerConfig` | `src/reassembler.ts` | Binary-pipeline reassembler wrapper. |
| `TextReassembler`, `TextReassembleResult`, `TextReassembleError`, `TextReassemblerConfig` | `src/text-reassembler.ts` | Text-pipeline reassembler wrapper. |
| `encodeBinaryAndSend`, `decodeBinaryMessages` | `src/binary-transport.ts` | High-level outbound/inbound helpers for binary transports. |
| `feedBytes`, `initialParserState`, `StreamParserState`, `FeedBytesResult` | `src/stream-frame-parser.ts` | Pure stream framing. |

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 188 | Public exports. |
| `src/constants.ts` | 90 | Wire protocol constants. |
| `src/frame-types.ts` | 118 | `Frame<T>`, `Complete<T>`, `Fragment<T>` + guards. |
| `src/codec.ts` | 80 | `BinaryCodec`, `TextCodec` interfaces. |
| `src/cbor.ts` | 315 | `cborCodec` — `ChannelMsg` ↔ CBOR bytes. |
| `src/cbor-encoding.ts` | 549 | Internal CBOR encoder/decoder (RFC 8949, major types 0–7). |
| `src/wire-types.ts` | 240 | Compact wire-message shape + enums. |
| `src/json.ts` | 219 | `textCodec` — `ChannelMsg` ↔ JSON-safe objects. |
| `src/frame.ts` | 282 | Binary frame encode/decode. |
| `src/text-frame.ts` | 393 | Text frame encode/decode. |
| `src/fragment.ts` | 305 | Fragmentation primitives. |
| `src/fragment-collector.ts` | 554 | Generic `FragmentCollector<T>` + pure `decideFragment`. |
| `src/reassembler.ts` | 249 | Binary reassembler wrapper. |
| `src/text-reassembler.ts` | 197 | Text reassembler wrapper. |
| `src/binary-transport.ts` | 85 | `encodeBinaryAndSend`, `decodeBinaryMessages`. |
| `src/stream-frame-parser.ts` | 185 | Pure `feedBytes` stream parser. |
| `src/__tests__/cbor-encoding.test.ts` | 268 | CBOR encoder/decoder — UTF-8 strings, nested maps, pooled buffers. |
| `src/__tests__/cbor.test.ts` | 476 | `cborCodec` round-trips for every `ChannelMsg` type. |
| `src/__tests__/text-codec.test.ts` | 474 | `textCodec` round-trips + base64 transparency. |
| `src/__tests__/frame.test.ts` | 571 | Binary frame encode/decode, truncation, version/hash errors. |
| `src/__tests__/text-frame.test.ts` | 765 | Text frame encode/decode + fragmentation. |
| `src/__tests__/fragment.test.ts` | 379 | Fragmentation primitives. |
| `src/__tests__/fragment-collector.test.ts` | 657 | `decideFragment` purity + `FragmentCollector` shell. |
| `src/__tests__/binary-helpers.test.ts` | 137 | `encodeBinaryAndSend` / `decodeBinaryMessages`. |
| `src/__tests__/stream-frame-parser.test.ts` | 230 | Stream parser edge cases: split headers, split payloads, coalesced writes, large payloads. |

## Testing

All tests are pure. No sockets, no real timers (injected `TimerAPI`). Round-trip tests assert that `decode(encode(msg)) === msg` structurally for every `ChannelMsg` variant. Error paths for malformed frames are tested exhaustively via the typed `code` discriminants on `FrameDecodeError` and `TextFrameDecodeError`.

**Tests**: 232 passed, 0 skipped across 9 files (`cbor-encoding`: 32, `cbor`: 25, `text-codec`: 24, `frame`: 29, `text-frame`: 43, `fragment`: 32, `fragment-collector`: 33, `binary-helpers`: 6, `stream-frame-parser`: 8). Run with `cd packages/exchange/wire && pnpm exec vitest run`.