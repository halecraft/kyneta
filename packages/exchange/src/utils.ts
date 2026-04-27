// utils — shared utilities for @kyneta/exchange.

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a peer ID is a non-empty string.
 *
 * @throws If peerId is empty or not a string.
 */
export function validatePeerId(peerId: string): void {
  if (typeof peerId !== "string" || peerId.length === 0) {
    throw new Error(
      `Invalid peerId: expected a non-empty string, got ${JSON.stringify(peerId)}`,
    )
  }
}
