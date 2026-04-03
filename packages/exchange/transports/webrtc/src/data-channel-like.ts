// data-channel-like — minimal interface for WebRTC-style data channels.
//
// Native `RTCDataChannel` satisfies this structurally — no wrapper needed.
// Libraries like simple-peer can conform via a trivial bridge function.
//
// This interface captures the exact surface the transport uses:
//   - readyState (read)
//   - binaryType (write, best-effort hint)
//   - send (call)
//   - addEventListener / removeEventListener (4 event types)
//
// It does NOT import any DOM types. The `event: any` parameter avoids
// coupling to `MessageEvent`, `Event`, etc. — the transport inspects
// `event.data` at runtime.

// ---------------------------------------------------------------------------
// DataChannelLike — the BYODC contract
// ---------------------------------------------------------------------------

/**
 * Minimal interface for a WebRTC-style data channel.
 *
 * Native `RTCDataChannel` satisfies this structurally (no wrapper needed).
 * Libraries like simple-peer can conform via a ~20-line bridge function
 * that maps EventEmitter events to addEventListener calls.
 *
 * The transport uses exactly these members — nothing else. This is
 * intentional: the narrower the interface, the easier it is to bridge
 * from any WebRTC library.
 *
 * ## Event types used
 *
 * The transport registers listeners for exactly four event types:
 * - `"open"` — data channel became ready for sending
 * - `"close"` — data channel was closed
 * - `"error"` — data channel encountered an error
 * - `"message"` — data arrived; the transport reads `event.data`
 *
 * ## Ownership contract
 *
 * The transport does NOT own the data channel. Calling
 * `detachDataChannel()` removes the sync channel but does not close
 * the data channel or the peer connection. The application manages
 * the WebRTC connection lifecycle independently.
 */
export interface DataChannelLike {
  /**
   * Current state of the data channel.
   *
   * The transport treats `"open"` as sendable; all other values
   * (including `"connecting"`, `"closing"`, `"closed"`) as not sendable.
   *
   * For native `RTCDataChannel`, this is one of:
   * `"connecting" | "open" | "closing" | "closed"`.
   *
   * Wrappers may return any string — the transport only checks `=== "open"`.
   */
  readonly readyState: string

  /**
   * Binary type hint for incoming data.
   *
   * The transport writes `"arraybuffer"` on attach as a best-effort hint.
   * It does NOT depend on this being respected — the message handler
   * accepts both `ArrayBuffer` and `Uint8Array` data regardless.
   *
   * For native `RTCDataChannel`, this controls whether `MessageEvent.data`
   * is an `ArrayBuffer` or a `Blob`. For wrappers that ignore this
   * property (e.g. simple-peer bridges), the write is harmless.
   */
  binaryType: string

  /**
   * Send binary data through the data channel.
   *
   * The transport always sends `Uint8Array` instances (CBOR-encoded
   * wire frames, optionally fragmented). Native `RTCDataChannel.send`
   * accepts `ArrayBufferView` (which `Uint8Array` satisfies), so
   * conformance is structural.
   */
  send(data: Uint8Array): void

  /**
   * Register an event listener.
   *
   * The transport uses this for `"open"`, `"close"`, `"error"`, and
   * `"message"` events. For `"message"` events, the transport reads
   * `event.data` and handles both `ArrayBuffer` and `Uint8Array`.
   *
   * @param type - Event type string
   * @param listener - Callback. The `event` parameter is untyped to
   *   avoid coupling to DOM `Event` / `MessageEvent` types.
   */
  addEventListener(type: string, listener: (event: any) => void): void

  /**
   * Remove a previously registered event listener.
   *
   * Called during `detachDataChannel()` to clean up all four event
   * listeners. The transport always passes the same function reference
   * that was used in `addEventListener`.
   */
  removeEventListener(type: string, listener: (event: any) => void): void
}