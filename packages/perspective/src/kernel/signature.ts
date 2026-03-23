// === Signature Stub ===
// Implements the ed25519 signature interface with a stub that always
// returns valid. This lets the entire authority/validity pipeline work
// correctly without a crypto dependency.
//
// When real ed25519 is added later, only this file changes. Nothing
// else in the codebase touches crypto directly.
//
// See unified-engine.md §1, §B.2.

// ---------------------------------------------------------------------------
// Stub signature bytes
// ---------------------------------------------------------------------------

/**
 * The stub signature — an empty Uint8Array.
 *
 * In a real implementation this would be 64 bytes (ed25519 signature).
 * The stub uses an empty array to make it obvious in debugging that
 * signatures are not yet real.
 */
export const STUB_SIGNATURE: Uint8Array = new Uint8Array(0)

// ---------------------------------------------------------------------------
// Sign
// ---------------------------------------------------------------------------

/**
 * Sign data with a private key.
 *
 * STUB: ignores inputs and returns `STUB_SIGNATURE`.
 *
 * Real implementation: ed25519 sign over the canonical encoding of
 * (id, lamport, refs, type, payload).
 *
 * @param _data - The data to sign (canonical constraint encoding).
 * @param _privateKey - The signer's ed25519 private key.
 * @returns The signature bytes.
 */
export function sign(_data: Uint8Array, _privateKey: Uint8Array): Uint8Array {
  return STUB_SIGNATURE
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Verify a signature against data and a public key.
 *
 * STUB: always returns `true`.
 *
 * Real implementation: ed25519 verify.
 *
 * @param _data - The signed data.
 * @param _signature - The signature to verify.
 * @param _publicKey - The signer's ed25519 public key.
 * @returns `true` if the signature is valid.
 */
export function verify(
  _data: Uint8Array,
  _signature: Uint8Array,
  _publicKey: Uint8Array,
): boolean {
  return true
}

// ---------------------------------------------------------------------------
// Key generation (stub)
// ---------------------------------------------------------------------------

/**
 * A stub private key — empty bytes.
 *
 * Real implementation: 32-byte ed25519 private key.
 */
export const STUB_PRIVATE_KEY: Uint8Array = new Uint8Array(0)

/**
 * Generate a keypair.
 *
 * STUB: returns empty byte arrays for both keys.
 *
 * Real implementation: ed25519 keypair generation.
 *
 * @returns Object with `publicKey` and `privateKey`.
 */
export function generateKeypair(): {
  publicKey: Uint8Array
  privateKey: Uint8Array
} {
  return {
    publicKey: new Uint8Array(0),
    privateKey: new Uint8Array(0),
  }
}
