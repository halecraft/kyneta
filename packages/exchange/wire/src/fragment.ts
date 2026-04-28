// fragment — transport-level fragmentation for large payloads.
//
// Pure functions for splitting a payload into self-describing fragment
// frames. Each fragment is encoded via the standard binary frame
// pipeline (frame-types constructor → encodeBinaryFrame), eliminating
// the duplicated manual encoding that lived here in v0.
//
// Stateful reassembly logic lives in the FragmentCollector.

import { FRAGMENT_META_SIZE, HEADER_SIZE, WIRE_VERSION } from "./constants.js"
import { encodeBinaryFrame } from "./frame.js"
import { fragment } from "./frame-types.js"

// ---------------------------------------------------------------------------
// Fragmentation
// ---------------------------------------------------------------------------

/**
 * Fragment a payload into multiple self-describing binary fragment frames.
 *
 * Each returned element is a fully encoded binary frame (header +
 * fragment metadata + chunk data), ready to send over the transport
 * with no additional wrapping.
 *
 * @param frameData    - The complete payload to fragment
 * @param maxChunkSize - Maximum bytes of payload data per fragment
 * @param frameId      - Caller-owned frame identifier grouping fragments
 * @returns One encoded fragment frame per chunk
 */
export function fragmentPayload(
  frameData: Uint8Array,
  maxChunkSize: number,
  frameId: number,
): Uint8Array<ArrayBuffer>[] {
  if (maxChunkSize <= 0) {
    throw new Error("maxChunkSize must be positive")
  }

  const totalSize = frameData.length
  const fragmentCount = Math.ceil(totalSize / maxChunkSize)
  const result: Uint8Array<ArrayBuffer>[] = []

  for (let i = 0; i < fragmentCount; i++) {
    const chunkStart = i * maxChunkSize
    const chunkEnd = Math.min(chunkStart + maxChunkSize, totalSize)
    const chunk = frameData.subarray(chunkStart, chunkEnd)

    const frame = fragment(
      WIRE_VERSION,
      frameId,
      i,
      fragmentCount,
      totalSize,
      chunk,
    )
    result.push(encodeBinaryFrame(frame))
  }

  return result
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
 * to `fragmentPayload` / `fragmentTextPayload` / `encodeBinaryAndSend`.
 */
export function createFrameIdCounter(): () => number {
  let id = 0
  return () => (id = (id + 1) & 0xffff)
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function shouldFragment(
  payloadSize: number,
  threshold: number,
): boolean {
  return payloadSize > threshold
}

/**
 * Calculate the total overhead of fragmenting a payload.
 *
 * @param payloadSize  - Size of the original payload in bytes
 * @param maxChunkSize - Maximum bytes of payload data per fragment
 * @returns Total overhead in bytes (per-fragment header + metadata)
 */
export function calculateFragmentationOverhead(
  payloadSize: number,
  maxChunkSize: number,
): number {
  const fragmentCount = Math.ceil(payloadSize / maxChunkSize)
  const perFragmentOverhead = HEADER_SIZE + FRAGMENT_META_SIZE
  return fragmentCount * perFragmentOverhead
}
