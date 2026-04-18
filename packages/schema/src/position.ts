// Position — cursor-anchoring primitives for text and sequence refs.
//
// A Position is a stable reference to a location within a text or sequence.
// Positions survive concurrent edits: they track a logical spot between
// characters, not an absolute index.
//
// What lives here:
// - Side — left or right bias for conflict resolution at boundaries
// - Position — the universal position interface
// - POSITION — capability symbol (follows CHANGEFEED, TRANSACT, NATIVE, CALL)
// - PositionCapable — factory interface for creating/decoding positions
// - HasPosition — runtime-detectable capability on text/sequence refs
// - hasPosition() — type guard for HasPosition
// - PlainPosition — lightweight index-tracking implementation for plain substrate
// - decodePlainPosition() — deserializer for PlainPosition's wire format

import type { Instruction } from "./change.js"
import { transformIndex } from "./change.js"

// ---------------------------------------------------------------------------
// Side — boundary bias
// ---------------------------------------------------------------------------

/**
 * Determines which side of a boundary a position anchors to.
 *
 * When an insertion occurs exactly at a position's resolved index:
 * - `"left"` — the position stays to the left of the new content
 *   (index unchanged; new content appears after the position)
 * - `"right"` — the position moves to the right of the new content
 *   (index advances past the insertion)
 *
 * Analogous to cursor affinity in text editors.
 */
export type Side = "left" | "right"

// ---------------------------------------------------------------------------
// Position — the universal position interface
// ---------------------------------------------------------------------------

/**
 * A stable reference to a location within a text or sequence.
 *
 * Each substrate provides its own implementation:
 * - **Plain** (`PlainPosition`): tracks an integer index, updated explicitly
 *   via `transform()`.
 * - **CRDT** (Loro, Yjs): wraps the substrate's native cursor/relative
 *   position. `resolve()` queries the CRDT state; `transform()` is a no-op
 *   because resolution is stateless.
 *
 * Positions are serializable (`encode`/`decode`) for persistence and
 * transmission across peers.
 */
export interface Position {
  /** The side bias of this position. */
  readonly side: Side

  /**
   * Resolve the position to a current integer index.
   *
   * Returns `null` if the anchored item has been deleted and the position
   * can no longer be meaningfully resolved.
   */
  resolve(): number | null

  /** Serialize to a compact binary representation. */
  encode(): Uint8Array

  /**
   * Advance through a delta.
   *
   * For plain positions this updates the tracked index via `transformIndex`.
   * For CRDT positions this is a no-op — `resolve()` is stateless because
   * the CRDT runtime handles position tracking internally.
   */
  transform(instructions: readonly Instruction[]): void
}

// ---------------------------------------------------------------------------
// POSITION — capability symbol
// ---------------------------------------------------------------------------

/**
 * Symbol property on refs that support position creation and decoding.
 *
 * Follows the established capability pattern: `CHANGEFEED`, `TRANSACT`,
 * `NATIVE`, `CALL`. Uses `Symbol.for` so multiple copies of this module
 * share identity.
 */
export const POSITION: unique symbol = Symbol.for("kyneta:position") as any

// ---------------------------------------------------------------------------
// PositionCapable — factory interface
// ---------------------------------------------------------------------------

/**
 * Factory for creating and decoding positions against a specific ref.
 *
 * Returned by `ref[POSITION]` on refs that support position anchoring
 * (text, sequence).
 */
export interface PositionCapable {
  /**
   * Create a new position anchored at the given index.
   *
   * @param index  The integer index to anchor at.
   * @param side   Boundary bias — determines behavior when content is
   *               inserted exactly at this index.
   */
  createPosition(index: number, side: Side): Position

  /**
   * Decode a position from its binary representation.
   *
   * The bytes must have been produced by `Position.encode()` from the
   * same substrate type.
   */
  decodePosition(bytes: Uint8Array): Position
}

// ---------------------------------------------------------------------------
// HasPosition — runtime-detectable capability
// ---------------------------------------------------------------------------

/**
 * Marker interface for refs that carry a `[POSITION]` capability.
 *
 * Intersected into text and sequence ref types by substrates that support
 * position anchoring. Detected at runtime via `hasPosition()`.
 */
export interface HasPosition {
  readonly [POSITION]: PositionCapable
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/**
 * Returns `true` if `value` has a `[POSITION]` property — i.e. it
 * implements `HasPosition` and supports position creation/decoding.
 */
export function hasPosition(value: unknown): value is HasPosition {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    POSITION in (value as object)
  )
}

// ---------------------------------------------------------------------------
// PlainPosition — lightweight index-tracking implementation
// ---------------------------------------------------------------------------

/**
 * A position implementation for the plain (non-CRDT) substrate.
 *
 * Stores a mutable integer index and a fixed side bias. The index is
 * updated explicitly via `transform()`, which delegates to `transformIndex`
 * from the change module.
 *
 * Wire format (5 bytes): `[side_byte, index_u32_be]`
 * - side byte: `0x00` = left, `0x01` = right
 * - index: unsigned 32-bit big-endian
 */
export class PlainPosition implements Position {
  /** Current tracked index. Updated by `transform()`. */
  private _index: number

  /** Boundary bias — immutable after construction. */
  readonly side: Side

  constructor(index: number, side: Side) {
    this._index = index
    this.side = side
  }

  /**
   * Resolve to the current tracked index.
   *
   * For plain positions this always succeeds — deletion awareness is not
   * modeled. Returns the current integer index.
   */
  resolve(): number | null {
    return this._index
  }

  /**
   * Serialize to a 5-byte binary representation.
   *
   * Layout: `[side_byte, index_u32_be]`
   */
  encode(): Uint8Array {
    const bytes = new Uint8Array(5)
    bytes[0] = this.side === "left" ? 0 : 1
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    view.setUint32(1, this._index, false) // big-endian
    return bytes
  }

  /**
   * Advance the tracked index through a set of instructions.
   *
   * Delegates to `transformIndex` which computes the new index position
   * after retain/insert/delete operations, respecting the side bias.
   */
  transform(instructions: readonly Instruction[]): void {
    this._index = transformIndex(this._index, this.side, instructions)
  }
}

// ---------------------------------------------------------------------------
// decodePlainPosition — deserializer
// ---------------------------------------------------------------------------

/**
 * Decode a `PlainPosition` from its 5-byte wire format.
 *
 * @throws {Error} If `bytes` is not exactly 5 bytes.
 */
export function decodePlainPosition(bytes: Uint8Array): PlainPosition {
  if (bytes.length !== 5) throw new Error("PlainPosition: expected 5 bytes")
  const side: Side = bytes[0] === 0 ? "left" : "right"
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const index = view.getUint32(1, false) // big-endian
  return new PlainPosition(index, side)
}