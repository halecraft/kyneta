// fragment-generic — substrate-agnostic fragmentation and codec interfaces.
//
// Two interfaces parameterize the wire layer over substrate type T:
//
//   SubstrateOps<T>  — bytes-level operations for fragmentation/reassembly.
//                      Consumed by Reassembler<T> and fragmentGeneric<T>.
//
//   WireCodec<T>     — extends SubstrateOps<T> with wire-message encode/decode.
//                      Consumed by Pipeline (in @kyneta/transport).
//
// One concrete record per substrate (BINARY_CODEC, TEXT_CODEC in their
// respective frame files) satisfies both via structural subtyping.
//
// fragmentGeneric<T> is the single chunk-loop for both substrates.
// It returns a tagged result instead of throwing, surfacing uint16
// overflow and empty-payload edge cases as typed data.

import type { Frame } from "./frame-types.js"
import type { WireMessage } from "./wire-types.js"

// ---------------------------------------------------------------------------
// Substrate operations
// ---------------------------------------------------------------------------

/**
 * Bytes-level operations for a single substrate (binary or text).
 *
 * Consumed by `Reassembler<T>` and `fragmentGeneric<T>`. A record
 * satisfying this interface carries everything fragmentation and
 * reassembly need to know about the substrate.
 */
export interface SubstrateOps<T> {
  /** Wire version stamped into Fragment frames (encode) and onto
   *  Complete frames synthesized from reassembled chunks (decode). */
  readonly wireVersion: number
  /** Maximum encodable payload size (bytes for binary, chars for text). */
  readonly maxPayload: number
  /** Size of a chunk in substrate units. */
  readonly sizeOf: (chunk: T) => number
  /** Concatenate chunks in arrival order into a single payload. */
  readonly concatenate: (chunks: readonly T[]) => T
  /** Slice a payload (zero-copy when possible). */
  readonly slice: (payload: T, start: number, end: number) => T
  /** Encode a Frame<T> to wire form. */
  readonly encodeFrame: (frame: Frame<T>) => T
  /** Decode wire form to a Frame<T>. Throws on malformed input. */
  readonly decodeFrame: (wire: T) => Frame<T>
}

// ---------------------------------------------------------------------------
// Wire codec — extends substrate ops with message-level encoding
// ---------------------------------------------------------------------------

/**
 * Full codec for a substrate: substrate ops + wire-message encode/decode.
 *
 * Consumed by `Pipeline` in `@kyneta/transport`. One record per
 * substrate (`BINARY_CODEC`, `TEXT_CODEC`) satisfies this interface.
 */
export interface WireCodec<T> extends SubstrateOps<T> {
  readonly encodeWire: (m: WireMessage) => T
  readonly decodeWire: (p: T) => WireMessage
}

// ---------------------------------------------------------------------------
// Fragment total maximum
// ---------------------------------------------------------------------------

/**
 * Maximum fragments per logical message. The Fragment frame's
 * `total` field is uint16 in both binary and text wire formats.
 */
export const FRAGMENT_TOTAL_MAX = 0xffff as const

// ---------------------------------------------------------------------------
// Fragment result
// ---------------------------------------------------------------------------

/**
 * Tagged result from `fragmentGeneric`. Forces callers to inspect the
 * discriminant instead of silently dropping empty payloads (A5) or
 * overflowing uint16 (A4).
 */
export type FragmentResult<T> =
  | { readonly kind: "fragments"; readonly pieces: readonly T[] }
  | { readonly kind: "empty-payload" }
  | {
      readonly kind: "too-many-fragments"
      readonly total: number
      readonly max: number
    }

// ---------------------------------------------------------------------------
// fragmentGeneric
// ---------------------------------------------------------------------------

/**
 * Fragment a payload into multiple substrate-native wire pieces.
 *
 * Each returned piece is a fully encoded fragment frame ready to
 * send over the transport. The chunk loop is substrate-agnostic —
 * `ops.encodeFrame` handles the final serialization.
 *
 * @param payload    - The encoded payload to fragment
 * @param threshold  - Maximum size per chunk (substrate units)
 * @param frameId    - Caller-owned frame identifier grouping fragments
 * @param ops        - Substrate operations
 * @returns Tagged result — `fragments`, `empty-payload`, or `too-many-fragments`
 */
export function fragmentGeneric<T>(
  payload: T,
  threshold: number,
  frameId: number,
  ops: SubstrateOps<T>,
): FragmentResult<T> {
  const totalSize = ops.sizeOf(payload)

  if (totalSize === 0) {
    return { kind: "empty-payload" }
  }

  const total = Math.ceil(totalSize / threshold)

  if (total > FRAGMENT_TOTAL_MAX) {
    return { kind: "too-many-fragments", total, max: FRAGMENT_TOTAL_MAX }
  }

  const pieces: T[] = []

  for (let i = 0; i < total; i++) {
    const start = i * threshold
    const end = Math.min(start + threshold, totalSize)
    const chunk = ops.slice(payload, start, end)

    const frame = {
      version: ops.wireVersion,
      hash: null,
      content: {
        kind: "fragment" as const,
        frameId,
        index: i,
        total,
        totalSize,
        payload: chunk,
      },
    }

    pieces.push(ops.encodeFrame(frame))
  }

  return { kind: "fragments", pieces }
}

// ---------------------------------------------------------------------------
// Frame ID counter
// ---------------------------------------------------------------------------

/**
 * Create a monotonic uint16 frame ID counter.
 *
 * Returns a closure that yields 1, 2, …, 65535, 0, 1, … on each call.
 * The wrapping matches the 2-byte `frameId` field in the binary frame
 * layout — callers never need to know the field width.
 *
 * Create one counter per connection; pass it (or its return value)
 * to `fragmentGeneric` / the Pipeline.
 */
export function createFrameIdCounter(): () => number {
  let id = 0
  return () => (id = (id + 1) & 0xffff)
}
