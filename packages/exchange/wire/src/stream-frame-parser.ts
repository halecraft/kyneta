// stream-frame-parser — pure step function for extracting binary frames from a byte stream.
//
// Unix domain sockets (and any stream-oriented transport) deliver bytes
// as a continuous stream — writes coalesce, reads deliver arbitrary chunks.
// This parser accumulates bytes and extracts complete binary frames using
// the 7-byte header's payload length field.
//
// FC/IS design: feedBytes is the functional core (pure, no side effects,
// no mutation of inputs). The transport's data handler is the imperative
// shell that calls feedBytes on each data event and dispatches the
// resulting frames.
//
// The parser handles:
// - Single complete frame in one chunk
// - Frame split across multiple chunks (partial header, partial payload)
// - Multiple frames in one chunk (write coalescing)
// - Empty chunks (no-op)
// - Arbitrary chunk boundaries

import { HEADER_SIZE } from "./constants.js"

// ---------------------------------------------------------------------------
// Parser state
// ---------------------------------------------------------------------------

/**
 * Discriminated union representing the parser's current phase.
 *
 * - `"header"`: accumulating bytes until we have a complete 7-byte header
 * - `"payload"`: header parsed, accumulating payload bytes
 *
 * The buffer holds accumulated bytes for the current phase. The offset
 * tracks how many bytes have been written into the buffer.
 */
export type StreamParserState =
  | { phase: "header"; buffer: Uint8Array; offset: number }
  | { phase: "payload"; header: Uint8Array; payloadLength: number; buffer: Uint8Array; offset: number }

/**
 * Create a fresh parser state in the "header" phase.
 *
 * Call this once when setting up a new stream connection. Pass the
 * returned state to `feedBytes` on each data event.
 */
export function initialParserState(): StreamParserState {
  return {
    phase: "header",
    buffer: new Uint8Array(HEADER_SIZE),
    offset: 0,
  }
}

// ---------------------------------------------------------------------------
// Pure step function
// ---------------------------------------------------------------------------

/**
 * Result of feeding bytes into the parser.
 */
export interface FeedBytesResult {
  /** The new parser state (pass to the next feedBytes call). */
  state: StreamParserState
  /** Zero or more complete frames extracted from the stream. */
  frames: Uint8Array[]
}

/**
 * Feed bytes into the parser, extracting zero or more complete frames.
 *
 * Pure function — no side effects, no mutation of inputs. Returns the
 * new parser state and any complete frames extracted from the stream.
 *
 * This is the functional core for stream-oriented binary transports.
 * The imperative shell (the transport's data handler) calls this on
 * each data event and dispatches the resulting frames.
 *
 * Each emitted frame is a complete binary wire frame (header + payload),
 * ready to pass directly to `decodeBinaryFrame`.
 *
 * @param state - Current parser state (from `initialParserState()` or previous `feedBytes` call)
 * @param chunk - New bytes from the stream (may be empty)
 * @returns New state and any complete frames
 */
export function feedBytes(
  state: StreamParserState,
  chunk: Uint8Array,
): FeedBytesResult {
  const frames: Uint8Array[] = []
  let pos = 0
  let current = state

  while (pos < chunk.length) {
    if (current.phase === "header") {
      const remaining = HEADER_SIZE - current.offset
      const available = chunk.length - pos
      const toCopy = Math.min(remaining, available)

      // Copy bytes into the header buffer
      const headerBuffer =
        current.offset === 0 && current.buffer.length === HEADER_SIZE
          ? current.buffer
          : current.buffer
      headerBuffer.set(chunk.subarray(pos, pos + toCopy), current.offset)
      pos += toCopy

      const newOffset = current.offset + toCopy

      if (newOffset < HEADER_SIZE) {
        // Still accumulating header bytes
        current = { phase: "header", buffer: headerBuffer, offset: newOffset }
      } else {
        // Header complete — read payload length from bytes 3–6 (4 bytes, big-endian)
        const view = new DataView(
          headerBuffer.buffer,
          headerBuffer.byteOffset,
          headerBuffer.byteLength,
        )
        const payloadLength = view.getUint32(3, false)

        if (payloadLength === 0) {
          // Edge case: zero-length payload — emit header-only frame immediately
          const frame = new Uint8Array(HEADER_SIZE)
          frame.set(headerBuffer)
          frames.push(frame)
          current = {
            phase: "header",
            buffer: new Uint8Array(HEADER_SIZE),
            offset: 0,
          }
        } else {
          // Transition to payload phase
          current = {
            phase: "payload",
            header: new Uint8Array(headerBuffer),
            payloadLength,
            buffer: new Uint8Array(payloadLength),
            offset: 0,
          }
        }
      }
    } else {
      // phase === "payload"
      const remaining = current.payloadLength - current.offset
      const available = chunk.length - pos
      const toCopy = Math.min(remaining, available)

      current.buffer.set(chunk.subarray(pos, pos + toCopy), current.offset)
      pos += toCopy

      const newOffset = current.offset + toCopy

      if (newOffset < current.payloadLength) {
        // Still accumulating payload bytes
        current = {
          phase: "payload",
          header: current.header,
          payloadLength: current.payloadLength,
          buffer: current.buffer,
          offset: newOffset,
        }
      } else {
        // Payload complete — assemble and emit the full frame (header + payload)
        const frame = new Uint8Array(HEADER_SIZE + current.payloadLength)
        frame.set(current.header, 0)
        frame.set(current.buffer, HEADER_SIZE)
        frames.push(frame)

        // Reset to header phase for next frame
        current = {
          phase: "header",
          buffer: new Uint8Array(HEADER_SIZE),
          offset: 0,
        }
      }
    }
  }

  return { state: current, frames }
}