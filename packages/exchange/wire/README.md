# @kyneta/wire

Frame envelopes, CBOR/JSON wire codecs, generic fragmentation, stream parsing, wire-message validation. Bytes-and-format primitives — the orchestrator lives in `@kyneta/transport`.

## What this package provides

| Primitive | Description | Key exports |
|-----------|-------------|-------------|
| **Frame envelopes** | 6-byte binary header, 2-char text prefix | `encodeBinaryFrame`, `decodeBinaryFrame`, `encodeTextFrame`, `decodeTextFrame` |
| **Wire codecs** | CBOR (binary) and JSON (text) wire-message encoding | `BINARY_CODEC`, `TEXT_CODEC`, `encodeWireMessage`, `decodeWireMessage` |
| **Generic fragmentation** | Substrate-agnostic chunk loop + reassembler | `fragmentGeneric<T>`, `Reassembler<T>`, `SubstrateOps<T>` |
| **Wire-message validation** | Runtime shape checks at the decoder seam | `validateWireMessage`, `WireValidationFailure` |
| **Identifier validation** | UTF-8 byte-length caps for doc IDs and schema hashes | `validateDocId`, `validateSchemaHash` |
| **Result type** | Typed success/failure union for fallible operations | `Result<T, E>`, `ok`, `err` |
| **Wire error** | Discriminated union of all wire-pipeline errors | `WireError` |

## Dependencies

```/dev/null/package.json#L1-3
{
  "dependencies": { "@kyneta/schema": "workspace:^" }
}
```

No transport peer-dependency. `@kyneta/wire` is a pure leaf.

## Quick start

### Binary frame encode/decode

```/dev/null/frame-example.ts#L1-14
import {
  encodeBinaryFrame, decodeBinaryFrame,
  complete, WIRE_VERSION,
} from "@kyneta/wire"

// Build a complete frame with a raw payload
const payload = new Uint8Array([0x01, 0x02, 0x03])
const frame = complete(WIRE_VERSION, payload)

// Encode → 6-byte header + payload bytes
const wire = encodeBinaryFrame(frame)

// Decode back
const decoded = decodeBinaryFrame(wire) // Frame<Uint8Array>
```

### Generic reassembly

```/dev/null/reassembler-example.ts#L1-17
import { Reassembler, BINARY_CODEC } from "@kyneta/wire"

const reassembler = new Reassembler(BINARY_CODEC, {
  timeoutMs: 10_000,
  maxConcurrentFrames: 32,
  maxTotalSize: 50 * 1024 * 1024,
})

// Feed wire pieces (complete frames or fragments)
const result = reassembler.receive(wirePiece)

if (result.status === "complete") {
  // result.frame is a Frame<Uint8Array> with kind: "complete"
}

reassembler.dispose()
```

### Fragmentation

```/dev/null/fragment-example.ts#L1-15
import {
  fragmentGeneric, createFrameIdCounter, BINARY_CODEC,
} from "@kyneta/wire"

const nextFrameId = createFrameIdCounter()

const result = fragmentGeneric(
  encodedPayload,
  100 * 1024,          // 100 KB threshold
  nextFrameId(),
  BINARY_CODEC,
)

if (result.kind === "fragments") {
  // result.pieces: readonly Uint8Array[] — each is a fully encoded fragment frame
}
```

### Wire-message validation

```/dev/null/validate-example.ts#L1-10
import { validateWireMessage } from "@kyneta/wire"

const result = validateWireMessage(decodedObject)

if (result.ok) {
  // result.value: WireMessage — structurally valid
} else {
  // result.error: WireValidationError — { reason, path? }
}
```

## Frame format

Each message is wrapped in a **6-byte binary frame** before transmission:

```/dev/null/frame-layout.txt#L1-7
┌──────────┬──────────┬──────────────────────────────────────────┐
│ Version  │  Type    │         Payload Length                   │
│ (1 byte) │ (1 byte) │         (4 bytes, big-endian)            │
├──────────┴──────────┴──────────────────────────────────────────┤
│                 Payload (codec-encoded)                        │
└────────────────────────────────────────────────────────────────┘
```

- **Version** — `WIRE_VERSION = 2`
- **Type** — `0x00` complete, `0x01` fragment
- **Payload length** — `Uint32` big-endian byte count

Text frames use a 2-character `"Vx"` prefix (`c` = complete, `f` = fragment) followed by a JSON string.

## CBOR compact wire format

The CBOR codec uses integer type discriminators and short field names to minimize payload size. See [PROTOCOL.md](./PROTOCOL.md) for the full wire protocol specification.

## License

MIT
