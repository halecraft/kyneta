// Avoids crypto.randomUUID() which is restricted to secure contexts
// (HTTPS or localhost) and throws on plain HTTP over LAN addresses.
// crypto.getRandomValues() has no such restriction.

/**
 * Generate a random hex string from `n` cryptographically random bytes.
 */
export function randomHex(byteCount: number): string {
  if (byteCount === 0) return ""
  const bytes = new Uint8Array(byteCount)
  crypto.getRandomValues(bytes)
  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, "0")
  }
  return hex
}

/**
 * Generate a random peer ID — a 16-character hex string.
 *
 * Used as keys in CRDT version vectors, so must be unique
 * but does not require cryptographic unpredictability.
 */
export function randomPeerId(): string {
  return randomHex(8)
}
