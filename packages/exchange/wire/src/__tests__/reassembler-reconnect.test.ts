// reassembler-reconnect.test — verifies the reassembler can reset between
// connections so that stale fragments from a prior connection don't collide
// with fragments from a new connection.
//
// Both FragmentReassembler and TextReassembler are created once per
// transport instance (client transports). When the underlying connection
// drops and reconnects, the reassembler's internal FragmentCollector
// still holds pending batches from the old connection. The frameId
// counter resets on the remote side, so frameId collisions are
// guaranteed. Without a reset, a new fragment with a reused frameId
// hits the stale batch and gets a total_mismatch error instead of
// starting a fresh batch.
//
// The transport's reconnect path calls reset() to clear the collector
// before the new connection starts receiving fragments.

import { describe, expect, it } from "vitest"
import { fragment } from "../frame-types.js"
import { encodeTextFrame, TEXT_WIRE_VERSION } from "../text-frame.js"
import { TextReassembler } from "../text-reassembler.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Encode a text wire frame from fragment metadata, for use in tests
 * that need to simulate specific fragment arrival patterns.
 */
function encodeFragment(
  frameId: number,
  index: number,
  total: number,
  totalSize: number,
  payload: string,
): string {
  return encodeTextFrame(
    fragment(TEXT_WIRE_VERSION, frameId, index, total, totalSize, payload),
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TextReassembler — reconnect resilience", () => {
  it("starts a fresh batch after reset, avoiding frameId collisions across connections", () => {
    // Without reset(), fragments from an old connection persist in the
    // collector. When a new connection reuses the same frameId with
    // different fragment parameters (total, totalSize), the stale batch
    // causes a total_mismatch error.
    //
    // The transport's reconnect handler calls reset() to clear the
    // collector, so the first fragment of the new connection starts
    // a fresh batch regardless of frameId reuse.

    const reassembler = new TextReassembler({ timeoutMs: 10_000 })

    // Old connection: receive fragments 0 and 1 of a 4-fragment message
    const oldTotalSize = 200
    const result1 = reassembler.receive(
      encodeFragment(42, 0, 4, oldTotalSize, '"old-connection-data-part-0"'),
    )
    expect(result1.status).toBe("pending")

    const result2 = reassembler.receive(
      encodeFragment(42, 1, 4, oldTotalSize, '"old-connection-data-part-1"'),
    )
    expect(result2.status).toBe("pending")

    // Connection drops. On reconnect, the transport calls reset().
    reassembler.reset()

    // New connection: fragment 0 of a 3-fragment message — same frameId=42
    // but different total and totalSize.
    const newTotalSize = 120
    const result3 = reassembler.receive(
      encodeFragment(42, 0, 3, newTotalSize, '"new-connection-data-part-0"'),
    )

    expect(result3.status).toBe("pending")
  })
})
