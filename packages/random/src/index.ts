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
 * Generate a random peer ID: 128 bits as a 32-character hex string.
 *
 * A peer ID is a seat, the key of a writer's entries in CRDT version vectors.
 * It must be unique with overwhelming probability across every writing session
 * a document ever sees. It need not be unpredictable.
 */
export function randomPeerId(): string {
  return randomHex(16)
}
