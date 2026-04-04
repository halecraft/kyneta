// persistent-peer-id — browser-only localStorage-backed peerId generation.
//
// Produces a stable, unique peerId for browser clients. The peerId is
// generated once via `generatePeerId()` and cached in `localStorage`
// under the given key. Subsequent calls with the same key return the
// cached value — ensuring stability across page reloads while
// maintaining uniqueness per storage key.
//
// This is intentionally browser-only. Server-side peerIds should be
// explicit strings passed via `ExchangeParams.identity.peerId`.

import { generatePeerId } from "./utils.js"

/**
 * Get or create a persistent peerId backed by `localStorage`.
 *
 * On first call, generates a random 16-char hex peerId via
 * `generatePeerId()` and stores it under `storageKey`. Subsequent
 * calls return the cached value.
 *
 * **Browser-only** — uses `localStorage`. Will throw in environments
 * where `localStorage` is not available (Node.js, SSR). Server-side
 * peerIds should be explicit strings, not generated.
 *
 * @param storageKey - The localStorage key. Defaults to `"kyneta-peer-id"`.
 *   Use a unique key per application to avoid collisions when multiple
 *   kyneta apps share the same origin.
 * @returns A stable 16-char hex peerId string.
 *
 * @example
 * ```ts
 * import { persistentPeerId } from "@kyneta/exchange"
 *
 * const exchange = new Exchange({
 *   identity: { peerId: persistentPeerId() },
 *   transports: [...],
 * })
 * ```
 */
export function persistentPeerId(storageKey = "kyneta-peer-id"): string {
  const existing = localStorage.getItem(storageKey)
  if (existing) return existing

  const peerId = generatePeerId()
  localStorage.setItem(storageKey, peerId)
  return peerId
}
