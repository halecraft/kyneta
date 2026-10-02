// position — LoroPosition implementation.
//
// Wraps Loro's Cursor object to implement @kyneta/schema's Position interface.
// Cursors bind to specific character IDs in the Loro operation log, so
// resolve() asks the document where that character is now — transform() is a
// no-op.

import type { Instruction, Position, Releasable, Side } from "@kyneta/schema"
import type {
  Cursor,
  LoroDoc as LoroDocType,
  Side as LoroSide,
} from "loro-crdt"

// ---------------------------------------------------------------------------
// Side conversion
// ---------------------------------------------------------------------------

/** Map kyneta Side to Loro Side. Left → -1, Right → 0. */
export function toLoroSide(side: Side): LoroSide {
  return side === "left" ? -1 : 0
}

/** Map Loro Side to kyneta Side. -1 → left, 0|1 → right. */
export function fromLoroSide(loroSide: LoroSide): Side {
  return loroSide === -1 ? "left" : "right"
}

// ---------------------------------------------------------------------------
// LoroPosition
// ---------------------------------------------------------------------------

/**
 * A Position backed by a Loro Cursor.
 *
 * Loro cursors are bound to character IDs in the operation log, so
 * `resolve()` asks the document where the cursor's character is now, and
 * `transform()` is a no-op — the CRDT runtime handles position tracking. The
 * document is read through its substrate's slot, so a position made before
 * the substrate is disposed throws `DocumentClosedError` rather than reaching
 * a freed document.
 */
export class LoroPosition implements Position {
  readonly side: Side

  constructor(
    private readonly cursor: Cursor,
    private readonly doc: Releasable<LoroDocType>,
  ) {
    this.side = fromLoroSide(cursor.side())
  }

  resolve(): number | null {
    const result = this.doc.get().getCursorPos(this.cursor)
    return result ? result.offset : null
  }

  encode(): Uint8Array {
    return this.cursor.encode()
  }

  transform(_instructions: readonly Instruction[]): void {
    // No-op — Loro cursors resolve statelessly against the operation log.
  }
}
