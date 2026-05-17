// frame-stream-parser-core — pure step function for extracting binary frames
// from a byte stream, returning Result-shaped outputs.
//
// Extracts length-prefixed binary frames from a continuous byte stream.
// Each successfully extracted frame is wrapped in ok(); future version/size
// checks will return err().
//
// FC/IS design: feedBytesStep is the functional core (pure, no side effects,
// no mutation of inputs). FrameStreamParser is the imperative shell.

import { HEADER_SIZE, ok, type Result, type WireError } from "@kyneta/wire"

// ---------------------------------------------------------------------------
// Parser state
// ---------------------------------------------------------------------------

/**
 * Discriminated union representing the parser's current phase.
 *
 * - `"header"`: accumulating bytes until we have a complete 6-byte header
 * - `"payload"`: header parsed, accumulating payload bytes
 *
 * The buffer holds accumulated bytes for the current phase. The offset
 * tracks how many bytes have been written into the buffer.
 */
export type StreamParserState =
  | { phase: "header"; buffer: Uint8Array; offset: number }
  | {
      phase: "payload"
      header: Uint8Array
      payloadLength: number
      buffer: Uint8Array
      offset: number
    }

/**
 * Create a fresh parser state in the "header" phase.
 *
 * Call this once when setting up a new stream connection. Pass the
 * returned state to `feedBytesStep` on each data event.
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
export interface FeedBytesStepResult {
  /** The new parser state (pass to the next feedBytesStep call). */
  state: StreamParserState
  /** Zero or more complete frames extracted from the stream. */
  frames: readonly Result<Uint8Array, WireError>[]
}

/**
 * Feed bytes into the parser, extracting zero or more complete frames.
 *
 * Pure function — no side effects, no mutation of inputs. Returns the
 * new parser state and any complete frames extracted from the stream.
 *
 * This is the functional core for stream-oriented binary transports.
 * The imperative shell (FrameStreamParser) calls this on each data
 * event and dispatches the resulting frames.
 *
 * Each emitted frame is a complete binary wire frame (header + payload),
 * wrapped in `ok()`, ready to pass directly to `decodeBinaryFrame`.
 *
 * @param state - Current parser state (from `initialParserState()` or previous call)
 * @param chunk - New bytes from the stream (may be empty)
 * @returns New state and any complete frames (each wrapped in Result)
 */
export function feedBytesStep(
  state: StreamParserState,
  chunk: Uint8Array,
): FeedBytesStepResult {
  const frames: Result<Uint8Array, WireError>[] = []
  let pos = 0
  let current = state

  while (pos < chunk.length) {
    if (current.phase === "header") {
      const remaining = HEADER_SIZE - current.offset
      const available = chunk.length - pos
      const toCopy = Math.min(remaining, available)

      const headerBuffer = current.buffer
      headerBuffer.set(chunk.subarray(pos, pos + toCopy), current.offset)
      pos += toCopy

      const newOffset = current.offset + toCopy

      if (newOffset < HEADER_SIZE) {
        current = { phase: "header", buffer: headerBuffer, offset: newOffset }
      } else {
        // Header complete — read payload length from bytes 2–5 (4 bytes, big-endian)
        const view = new DataView(
          headerBuffer.buffer,
          headerBuffer.byteOffset,
          headerBuffer.byteLength,
        )
        const payloadLength = view.getUint32(2, false)

        if (payloadLength === 0) {
          // Edge case: zero-length payload — emit header-only frame immediately
          const frame = new Uint8Array(HEADER_SIZE)
          frame.set(headerBuffer)
          frames.push(ok(frame))
          current = {
            phase: "header",
            buffer: new Uint8Array(HEADER_SIZE),
            offset: 0,
          }
        } else {
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
      const remaining = current.payloadLength - current.offset
      const available = chunk.length - pos
      const toCopy = Math.min(remaining, available)

      current.buffer.set(chunk.subarray(pos, pos + toCopy), current.offset)
      pos += toCopy

      const newOffset = current.offset + toCopy

      if (newOffset < current.payloadLength) {
        current = {
          phase: "payload",
          header: current.header,
          payloadLength: current.payloadLength,
          buffer: current.buffer,
          offset: newOffset,
        }
      } else {
        const frame = new Uint8Array(HEADER_SIZE + current.payloadLength)
        frame.set(current.header, 0)
        frame.set(current.buffer, HEADER_SIZE)
        frames.push(ok(frame))

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
