// utils — shared utilities for @kyneta/exchange.

// ---------------------------------------------------------------------------
// Randomness — single point of dependency on crypto APIs
// ---------------------------------------------------------------------------

/**
 * Generate a random peer ID string.
 *
 * Produces a 16-character hex string from `crypto.getRandomValues()`.
 * This is sufficient for uniqueness within an exchange network
 * without requiring a UUID library.
 */
export function randomPeerId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]?.toString(16).padStart(2, "0")
  }
  return hex
}

/**
 * Generate an opaque random token string.
 *
 * Used for session nonces, CAS tokens, and other identifiers where
 * the only requirement is uniqueness — not a stable peer identity.
 * Wraps `crypto.randomUUID()`.
 */
export function randomToken(): string {
  return crypto.randomUUID()
}

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
