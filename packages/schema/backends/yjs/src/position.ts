// position — YjsPosition implementation.
//
// Wraps Yjs's RelativePosition to implement @kyneta/schema's Position interface.
// Relative positions bind to specific item IDs in the Yjs document, making
// resolve() a stateless query — transform() is a no-op.

import type { Instruction, Position, Side } from "@kyneta/schema"
import * as Y from "yjs"

/** Map kyneta Side to Yjs assoc. Left → -1 (left-sticky), Right → 0 (right-sticky). */
export function toYjsAssoc(side: Side): number {
  return side === "left" ? -1 : 0
}

/** Map Yjs assoc to kyneta Side. Negative → left, non-negative → right. */
export function fromYjsAssoc(assoc: number): Side {
  return assoc < 0 ? "left" : "right"
}

export class YjsPosition implements Position {
  readonly side: Side

  constructor(
    private readonly rpos: Y.RelativePosition,
    private readonly doc: Y.Doc,
  ) {
    this.side = fromYjsAssoc(rpos.assoc)
  }

  resolve(): number | null {
    const abs = Y.createAbsolutePositionFromRelativePosition(this.rpos, this.doc)
    return abs ? abs.index : null
  }

  encode(): Uint8Array {
    return Y.encodeRelativePosition(this.rpos)
  }

  transform(_instructions: readonly Instruction[]): void {
    // No-op — Yjs relative positions resolve statelessly against the document.
  }
}