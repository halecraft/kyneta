# @kyneta/wire — Technical Reference

> **Package**: `@kyneta/wire`
> **Role**: Wire-format primitives — frame envelopes, CBOR/JSON wire codecs, generic fragmentation and reassembly, wire-message validation, identifier validation, and the `Result`/`WireError` types. A pure leaf package with no transport dependency. The orchestrator (`Pipeline`) lives in `@kyneta/transport`.
> **Depends on**: `@kyneta/schema`
> **Depended on by**: `@kyneta/transport` (workspace dependency), and through it every concrete transport
> **Canonical symbols**: `Frame<T>`, `Complete<T>`, `Fragment<T>`, `complete`, `fragment`, `isComplete`, `isFragment`, `encodeBinaryFrame`, `decodeBinaryFrame`, `encodeTextFrame`, `decodeTextFrame`, `BINARY_CODEC`, `TEXT_CODEC`, `SubstrateOps<T>`, `WireCodec<T>`, `fragmentGeneric`, `createFrameIdCounter`, `FRAGMENT_TOTAL_MAX`, `Reassembler<T>`, `FragmentCollector<T>`, `decideFragment`, `encodeWireMessage`, `decodeWireMessage`, `encodeTextWireMessage`, `decodeTextWireMessage`, `validateWireMessage`, `WireValidationFailure`, `validateDocId`, `validateSchemaHash`, `WireError`, `Result`, `Ok`, `Err`, `ok`, `err`, `WIRE_VERSION`, `HEADER_SIZE`, `FRAGMENT_META_SIZE`, `FrameDecodeError`, `TextFrameDecodeError`
> **Key invariant(s)**: Every byte that crosses a transport is a `Frame<T>`. Wire is a leaf — it defines the format but never orchestrates the pipeline. The orchestrator (`Pipeline`) composes wire's codecs, fragmentation, and validation into a send/receive path.

A small kit for turning `WireMessage` values into bytes (or JSON-safe strings) that can travel over any wire, and turning them back. It is pure format mechanics — encoding, framing, fragmentation, reassembly, validation — with no transport-specific logic and no transport dependency.

Consumed by `@kyneta/transport` (which re-exports `Result`/`WireError` and uses `WireCodec<T>` to build the `Pipeline`). Not used directly by concrete transports — they import from `@kyneta/transport` instead.

---

## Questions this document answers

- What is a `Frame<T>` and why parameterize by `T`? → [Frame — the universal abstraction](#framet--the-universal-abstraction)
- Why do we have our own CBOR encoder instead of an npm library? → [Why an internal CBOR codec](#why-an-internal-cbor-codec)
- How does generic fragmentation work? → [Fragmentation](#fragmentation)
- What is the trust boundary and how does validation work? → [Inbound trust boundary](#inbound-trust-boundary)
- What are `BINARY_CODEC` and `TEXT_CODEC`? → [Substrate codecs](#substrate-codecs)
- What's the binary frame layout on the wire? → [Binary frame layout](#binary-frame-layout)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `Frame<T>` | `{ version, hash, content: Complete<T> \| Fragment<T> }` — the universal delivery unit. | A networking "frame" in the ISO-OSI sense; an HTML/animation frame |
| `Complete<T>` | `{ kind: "complete", payload: T }` — the frame carries the whole message. | `Fragment<T>` |
| `Fragment<T>` | `{ kind: "fragment", frameId, index, total, totalSize, payload }` — one chunk of a larger payload. | A TCP/IP network fragment; a URL fragment |
| `WIRE_VERSION` | The current binary wire protocol version (`2`). | A schema version, a package version |
| `SubstrateOps<T>` | Bytes-level operations interface for fragmentation/reassembly, parameterized by substrate type. | `WireCodec<T>`, which extends it with wire-message encode/decode |
| `WireCodec<T>` | Full codec: `SubstrateOps<T>` + `encodeWire`/`decodeWire`. One record per substrate. | A general-purpose codec library |
| `Reassembler<T>` | Generic fragment reassembler parameterized by `SubstrateOps<T>`. Replaces the former per-substrate reassemblers. | `FragmentCollector<T>`, which is the underlying collection engine |
| `FragmentCollector<T>` | Generic stateful fragment-collection shell, parameterized on chunk type. | `Reassembler<T>`, which wraps it with frame decode/encode |
| `decideFragment` | The pure decision function at the heart of `FragmentCollector`. | The collector itself — the collector mutates state; `decideFragment` does not |
| `fragmentGeneric<T>` | Substrate-agnostic chunk loop. Returns a tagged result instead of throwing. | The deprecated `fragmentPayload` — now replaced by this generic version |
| `WireValidationFailure` | Exception class for peer bugs (structurally invalid wire message). | Generic `Error` (wire corruption) |
| `WireError` | Discriminated union of all wire-pipeline error variants. | A thrown exception — `WireError` is a value, not a class |
| `Result<T, E>` | `Ok<T> \| Err<E>` — forces callers to inspect before accessing the payload. | Exceptions — `Result` is explicit, not thrown |

---

## Architecture

**Thesis**: one abstract frame type covers every wire. The binary codec and the text codec share all structural logic — only the payload type and frame formatting differ. Wire is a leaf; all orchestration (aliasing, pipeline lifecycle, stream parsing) lives in `@kyneta/transport`.

| Layer | Package | Responsibility |
|-------|---------|----------------|
| Format | `@kyneta/wire` | Encode/decode frames, encode/decode wire messages, fragment/reassemble, validate |
| Orchestration | `@kyneta/transport` | Alias transformer, `Pipeline<S, R>`, `FrameStreamParser`, re-exports |

### What wire is NOT

- **Not an orchestrator.** Wire has no `Pipeline`, no alias transformer, no send/receive step function. Those live in `@kyneta/transport`.
- **Not transport-aware.** Wire does not know about WebSocket, SSE, Unix sockets, or any concrete transport. It operates on `T` — either `Uint8Array` or `string`.
- **Not a dependency of concrete transports.** Concrete transports import from `@kyneta/transport`, which re-exports the wire primitives they need.

### What a `Frame` is NOT

- **Not an ISO-OSI frame.** No link-layer semantics, no addressing. A kyneta frame is a single application-level delivery unit with a version byte.
- **Not self-addressed.** A frame has no sender or receiver in its header. Routing is the transport's concern.

### What fragmentation is NOT

- **Not TCP/IP fragmentation.** Cloud WebSocket gateways impose message-size caps orders of magnitude above the network MTU. Fragmentation exists so one semantic message that exceeds the gateway cap can be delivered as several cap-sized pieces.
- **Not automatic for all transports.** Unix sockets have no message-size cap — they use stream framing instead.

---

## `Frame<T>` — the universal abstraction

Source: `packages/exchange/wire/src/frame-types.ts`.

```/dev/null/frame.txt#L1-5
Frame<T> = {
  version: number
  hash: string | null          // null today; reserved for hex SHA-256 digest
  content: Complete<T> | Fragment<T>
}
```

`Complete<T>` carries a single `payload: T`. `Fragment<T>` carries `frameId`, `index`, `total`, `totalSize`, and a chunk. Constructors: `complete(version, payload, hash?)` and `fragment(version, frameId, index, total, totalSize, payload, hash?)`. Type guards: `isComplete(frame)`, `isFragment(frame)`.

The two type parameters actually used are `Frame<Uint8Array>` and `Frame<string>` — one per substrate.

---

## Binary frame layout

Source: `packages/exchange/wire/src/constants.ts`, `packages/exchange/wire/src/frame.ts`.

```/dev/null/frame-layout.txt#L1-6
 0       1       2                                     6
┌───────┬───────┬─────────────────────────────────────┐
│ Vers  │ Type  │        Payload length (u32 BE)       │
└───────┴───────┴─────────────────────────────────────┘
  (if Type == FRAGMENT: 10 bytes of fragment metadata)
  payload bytes...
```

| Byte(s) | Field | Values |
|---------|-------|--------|
| 0 | `version` | `WIRE_VERSION = 2` |
| 1 | `type` | `BinaryFrameType.COMPLETE = 0x00` / `BinaryFrameType.FRAGMENT = 0x01` |
| 2–5 | `payloadLength` | `u32` big-endian |
| 6+ | *fragment meta* | if `type == FRAGMENT`: `frameId(u16 BE) + index(u16 BE) + total(u16 BE) + totalSize(u32 BE)` = 10 bytes |
| … | `payload` | `payloadLength` bytes |

`encodeBinaryFrame(frame)` writes this layout; `decodeBinaryFrame(bytes)` reads it. Truncation, version mismatch, and unknown frame type all raise `FrameDecodeError` (with a typed `code` discriminant).

---

## Why an internal CBOR codec

Source: `packages/exchange/wire/src/cbor-encoding.ts`.

`@kyneta/wire` does not depend on any external CBOR library. The internal implementation covers RFC 8949 major types 0–7 — exactly the subset kyneta uses. The replacement fixes two bugs in the library it replaced:

1. `encodeString` used JavaScript `.length` (UTF-16 code units) instead of UTF-8 byte length for the CBOR text-string header — any non-ASCII string was corrupted on encode.
2. `decodePartialCBOR` constructed `DataView` without `byteOffset`, so a `Uint8Array` view into a shared `ArrayBuffer` (Node's pooled `Buffer`, Bun's internal buffers) would read from the wrong position.

### What `encodeWireMessage` is NOT

- **Not a general-purpose CBOR library.** It encodes only the `WireMessage` shape.
- **Not symmetric with `encodeTextWireMessage` byte-for-byte.** Both functions produce the *same* `WireMessage` on decode, but the bytes/strings they emit are completely different formats.

### Compact wire-message shape

Source: `packages/exchange/wire/src/wire-types.ts`. `encodeWireMessage` maps `WireMessage` fields to integer discriminants and short field names to minimize bytes on the wire. The public `MessageType`, `PayloadEncoding`, `PayloadKind` enums (and their `*ToString` / `StringTo*` reverse maps) are exported for any code that must match the wire representation directly.

---

## Substrate codecs

Source: `packages/exchange/wire/src/frame.ts` (`BINARY_CODEC`), `packages/exchange/wire/src/text-frame.ts` (`TEXT_CODEC`).

Each codec is a record satisfying `WireCodec<T>`, which extends `SubstrateOps<T>` with wire-message encode/decode:

```/dev/null/codec-interfaces.txt#L1-14
SubstrateOps<T> = {
  wireVersion: number
  maxPayload: number
  sizeOf:      (chunk: T) => number
  concatenate: (chunks: readonly T[]) => T
  slice:       (payload: T, start: number, end: number) => T
  encodeFrame: (frame: Frame<T>) => T
  decodeFrame: (wire: T) => Frame<T>
}

WireCodec<T> extends SubstrateOps<T> = {
  encodeWire: (m: WireMessage) => T
  decodeWire: (p: T) => WireMessage
}
```

| Codec | `T` | Wire version | Transports (via Pipeline) |
|-------|-----|--------------|---------------------------|
| `BINARY_CODEC` | `Uint8Array` | `WIRE_VERSION = 2` | WebSocket, WebRTC, Unix socket |
| `TEXT_CODEC` | `string` | `TEXT_WIRE_VERSION = 1` | SSE |

`Pipeline` in `@kyneta/transport` accepts a `WireCodec<T>` and wires it into the send/receive path. Concrete transports never call these codecs directly.

---

## Fragmentation

### Wire-v2 fragmentation algorithm

Binary fragmentation in v2 slices the **unframed payload** (the encoded `WireMessage` bytes), not the framed bytes. Each resulting chunk is individually wrapped in a `Fragment` frame by `SubstrateOps.encodeFrame`. This simplifies the receiver: the reassembler concatenates payloads to reconstruct the original encoded `WireMessage`, then decodes once.

### `Reassembler<T>` + `fragmentGeneric<T>` + `SubstrateOps<T>`

Source: `packages/exchange/wire/src/fragment-generic.ts`, `packages/exchange/wire/src/reassembler-generic.ts`.

`fragmentGeneric<T>` is the single chunk-loop for both substrates. It returns a tagged `FragmentResult<T>` instead of throwing, surfacing uint16 overflow (`too-many-fragments`) and empty payload (`empty-payload`) as typed data:

```/dev/null/fragment-result.txt#L1-4
FragmentResult<T> =
  | { kind: "fragments"; pieces: readonly T[] }
  | { kind: "empty-payload" }
  | { kind: "too-many-fragments"; total: number; max: number }
```

`Reassembler<T>` wraps `FragmentCollector<T>` with frame decode/encode logic. Complete frames pass through; fragment frames are collected and reassembled into a synthetic `Complete<T>` frame. One class replaces the former `FragmentReassembler` (binary) and `TextReassembler` (text).

### `FragmentCollector<T>` — functional core / imperative shell

`decideFragment(state, fragment, config)` is pure (source: `src/fragment-collector.ts`). It takes the collector's state and a new fragment, and returns a `FragmentDecision` describing what to do. `FragmentCollector<T>` is the imperative shell that applies decisions, schedules timers via an injected `TimerAPI`, and enforces `maxConcurrentFrames` + `maxTotalSize`.

| Config field | Default | Purpose |
|--------------|---------|---------|
| `timeoutMs` | `10000` | Abandon a frame not fully received within this window |
| `maxConcurrentFrames` | `32` | Cap on in-flight frame IDs; oldest evicted on overflow |
| `maxTotalSize` | `50 × 1024 × 1024` | Cap on summed bytes across all in-flight frames |

---

## Inbound trust boundary

Source: `packages/exchange/wire/src/validate-wire-message.ts`.

`validateWireMessage` runs at the decoder seam — immediately after CBOR/JSON decode, before alias resolution. It accepts `unknown` and returns `Result<WireMessage, WireValidationError>`.

### Two-throw contract

Both `decodeWireMessage` and `decodeTextWireMessage` (in `wire-message-helpers.ts`) enforce the trust boundary and produce exactly two exception types:

| Exception | Meaning | Peer's fault? |
|-----------|---------|---------------|
| `WireValidationFailure` | Structurally invalid `WireMessage` — missing fields, wrong types, invalid discriminants | Yes (peer bug) |
| `Error` | CBOR/JSON parse failure, unexpected decode error | No (wire corruption, truncation) |

The `Pipeline` in `@kyneta/transport` catches both and routes them through the `WireError` union's `invalid-wire-message` and `decode-failed` variants respectively.

### Identifier validation

`validateDocId` and `validateSchemaHash` enforce UTF-8 byte-length caps (`DOC_ID_MAX_UTF8_BYTES = 512`, `SCHEMA_HASH_MAX_UTF8_BYTES = 256`). These are called during wire-message decode to reject oversized identifiers at the trust boundary.

---

## Result and WireError

### `Result<T, E>`

Source: `packages/exchange/wire/src/result.ts`.

A minimal discriminated union for fallible operations:

```/dev/null/result.txt#L1-5
type Ok<T>  = { ok: true;  value: T }
type Err<E> = { ok: false; error: E }
type Result<T, E> = Ok<T> | Err<E>

// Constructors: ok(value), err(error)
```

Used throughout the wire pipeline and re-exported from `@kyneta/transport`.

### `WireError`

Source: `packages/exchange/wire/src/wire-error.ts`.

Discriminated union of all wire-pipeline error variants:

| Code | Detail type | Source |
|------|-------------|--------|
| `alias-resolution-failed` | `AliasResolutionError` | Alias transformer (in transport) |
| `decode-failed` | `unknown` | CBOR/JSON parse |
| `frame-decode-failed` | `FrameDecodeErrorCode \| TextFrameDecodeErrorCode` | Frame decode |
| `reassembly-failed` | `ReassembleError` | Reassembler |
| `reassembly-timeout` | `{ frameId, partialCount }` | Reassembler timeout |
| `reassembly-evicted` | `{ frameId }` | Reassembler memory pressure |
| `frame-too-large` | `{ size, limit }` | Send-side size check |
| `empty-payload` | `{ totalSize: 0 }` | Fragmentation edge case |
| `too-many-fragments` | `{ total, max }` | Fragmentation overflow |
| `invalid-wire-message` | `WireValidationError` | Trust boundary validation |

---

## Key Types

| Type | File | Role |
|------|------|------|
| `Frame<T>`, `Complete<T>`, `Fragment<T>` | `src/frame-types.ts` | Universal frame algebra + constructors + guards. |
| `WireMessage`, `Wire*Msg`, `MessageType`, `PayloadEncoding`, `PayloadKind` | `src/wire-types.ts` | Compact wire-message shape + enum discriminants. |
| `SyncProtocolWire`, `SyncProtocolWireValue`, `SyncProtocolWireToProtocol`, `syncProtocolToWire` | `src/wire-types.ts` | Wire encoding for `SyncProtocol`. |
| `SubstrateOps<T>`, `WireCodec<T>`, `FragmentResult<T>` | `src/fragment-generic.ts` | Generic fragmentation interfaces. |
| `Reassembler<T>`, `ReassemblerConfig`, `ReassembleResult<T>`, `ReassembleError` | `src/reassembler-generic.ts` | Generic reassembler. |
| `FragmentCollector<T>`, `decideFragment`, `FragmentDecision`, `CollectorConfig` | `src/fragment-collector.ts` | Generic collector (FC/IS). |
| `WIRE_VERSION`, `HEADER_SIZE`, `FRAGMENT_META_SIZE`, `BinaryFrameType` | `src/constants.ts` | Wire constants. |
| `encodeBinaryFrame`, `decodeBinaryFrame`, `BINARY_CODEC`, `FrameDecodeError` | `src/frame.ts` | Binary frame I/O + binary codec record. |
| `encodeTextFrame`, `decodeTextFrame`, `TEXT_CODEC`, `TextFrameDecodeError` | `src/text-frame.ts` | Text frame I/O + text codec record. |
| `encodeWireMessage`, `decodeWireMessage`, `encodeTextWireMessage`, `decodeTextWireMessage` | `src/wire-message-helpers.ts` | Direct WireMessage encode/decode (bypasses ChannelMsg conversion). |
| `validateWireMessage`, `WireValidationFailure`, `WireValidationError` | `src/validate-wire-message.ts` | Runtime shape checks at the decoder seam. |
| `validateDocId`, `validateSchemaHash`, `IdentifierValidationError` | `src/validate-identifiers.ts` | UTF-8 byte-length validation for identifiers. |
| `AliasResolutionError`, `Alias` | `src/alias-error.ts` | Alias error types (for `WireError`'s alias variant). |
| `WireError` | `src/wire-error.ts` | Discriminated union of all pipeline errors. |
| `Result<T, E>`, `Ok<T>`, `Err<E>`, `ok`, `err` | `src/result.ts` | Typed success/failure union. |

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | ~170 | Public exports. |
| `src/constants.ts` | ~70 | Wire protocol constants (`WIRE_VERSION = 2`, header/fragment sizes, identifier caps). |
| `src/frame-types.ts` | ~120 | `Frame<T>`, `Complete<T>`, `Fragment<T>` + guards. |
| `src/cbor-encoding.ts` | ~550 | Internal CBOR encoder/decoder (RFC 8949, major types 0–7). |
| `src/wire-types.ts` | ~250 | Compact wire-message shape + enums. |
| `src/wire-message-helpers.ts` | ~170 | `encodeWireMessage`/`decodeWireMessage` + text variants — WireMessage ↔ bytes/string. |
| `src/frame.ts` | ~220 | Binary frame encode/decode + `BINARY_CODEC` record. |
| `src/text-frame.ts` | ~300 | Text frame encode/decode + `TEXT_CODEC` record. |
| `src/fragment-generic.ts` | ~130 | `SubstrateOps<T>`, `WireCodec<T>`, `fragmentGeneric<T>`, `createFrameIdCounter`. |
| `src/fragment-collector.ts` | ~550 | Generic `FragmentCollector<T>` + pure `decideFragment`. |
| `src/reassembler-generic.ts` | ~160 | `Reassembler<T>` — generic reassembler wrapping `FragmentCollector<T>`. |
| `src/validate-wire-message.ts` | ~250 | `validateWireMessage` — runtime shape validation at the decoder seam. |
| `src/validate-identifiers.ts` | ~60 | `validateDocId`, `validateSchemaHash` — UTF-8 byte-length caps. |
| `src/alias-error.ts` | ~40 | `AliasResolutionError` discriminated union (for `WireError`). |
| `src/wire-error.ts` | ~25 | `WireError` discriminated union. |
| `src/result.ts` | ~25 | `Result<T, E>`, `Ok<T>`, `Err<E>`, `ok`, `err`. |

## Testing

All tests are pure. No sockets, no real timers (injected `TimerAPI`). Round-trip tests assert that `decode(encode(msg)) === msg` structurally for every wire-message variant. Error paths for malformed frames are tested exhaustively via the typed `code` discriminants on `FrameDecodeError` and `TextFrameDecodeError`.

Run with `cd packages/exchange/wire && pnpm exec vitest run`.
