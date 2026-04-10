// base64 — platform-agnostic binary ↔ base64 encoding.
//
// Pure functions, zero dependencies. Uses btoa/atob which are available
// in browsers, Node 16+, Bun, and Deno.
//
// Used by backend version implementations (LoroVersion, YjsVersion) for
// serializing version vectors into text-safe strings.

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/**
 * Encode a `Uint8Array` to a base64 string.
 *
 * Platform-agnostic — uses the built-in `btoa()`.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/**
 * Decode a base64 string back to a `Uint8Array`.
 *
 * Platform-agnostic — uses the built-in `atob()`.
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
