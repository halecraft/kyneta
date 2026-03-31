// utils — shared utilities for @kyneta/exchange.

// ---------------------------------------------------------------------------
// Peer ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a random peer ID string.
 *
 * Produces a 16-character hex string from crypto.getRandomValues().
 * This is sufficient for uniqueness within an exchange network
 * without requiring a UUID library.
 */
export function generatePeerId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0")
  }
  return hex
}

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
