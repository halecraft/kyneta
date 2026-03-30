// frame-types — universal frame abstraction for @kyneta/wire.
//
// A frame is the delivery unit for the wire protocol. Every message
// sent over a transport is wrapped in a frame. The frame carries:
// - A protocol version
// - An optional content hash (reserved for future SHA-256 support)
// - Content that is either complete or a fragment of a larger payload
//
// The frame is parameterized on payload type T:
// - Binary pipeline: Frame<Uint8Array>
// - Text pipeline:   Frame<string>
//
// Batching is orthogonal to framing. The frame layer does not
// distinguish single messages from batches — that's the codec's
// concern. The payload's own structure (CBOR array vs map, JSON
// array vs object) determines singular vs plural.

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

/**
 * A complete payload — the frame carries the entire message or batch.
 */
export type Complete<T> = {
  readonly kind: "complete"
  readonly payload: T
}

/**
 * A fragment — the frame carries one piece of a larger payload.
 *
 * Fragments are fully self-describing: each carries the frameId,
 * its index, the total fragment count, and the total payload size.
 * The receiver collects fragments by frameId and concatenates them
 * in index order to reconstruct the original payload.
 */
export type Fragment<T> = {
  readonly kind: "fragment"
  /** Identifier grouping fragments of the same payload. */
  readonly frameId: string
  /** Zero-based index of this fragment. */
  readonly index: number
  /** Total number of fragments in this group. */
  readonly total: number
  /** Total size of the original payload (bytes for binary, characters for text). */
  readonly totalSize: number
  /** This fragment's chunk of the payload. */
  readonly payload: T
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

/**
 * The universal frame type.
 *
 * Everything sent over a wire transport is a frame. A frame has a
 * protocol version, an optional hash, and content that is either
 * a complete payload or a fragment of one.
 *
 * @typeParam T - The payload type: `Uint8Array` for binary, `string` for text.
 */
export type Frame<T> = {
  readonly version: number
  /** Content hash (null today, hex-encoded SHA-256 digest in the future). */
  readonly hash: string | null
  readonly content: Complete<T> | Fragment<T>
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Create a complete frame. */
export function complete<T>(
  version: number,
  payload: T,
  hash: string | null = null,
): Frame<T> {
  return { version, hash, content: { kind: "complete", payload } }
}

/** Create a fragment frame. */
export function fragment<T>(
  version: number,
  frameId: string,
  index: number,
  total: number,
  totalSize: number,
  payload: T,
  hash: string | null = null,
): Frame<T> {
  return {
    version,
    hash,
    content: { kind: "fragment", frameId, index, total, totalSize, payload },
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Check if a frame's content is complete (not fragmented). */
export function isComplete<T>(
  frame: Frame<T>,
): frame is Frame<T> & { content: Complete<T> } {
  return frame.content.kind === "complete"
}

/** Check if a frame's content is a fragment. */
export function isFragment<T>(
  frame: Frame<T>,
): frame is Frame<T> & { content: Fragment<T> } {
  return frame.content.kind === "fragment"
}