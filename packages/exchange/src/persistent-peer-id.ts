// persistent-peer-id — browser-only per-tab unique peerId via localStorage CAS lease.
//
// The lease protocol ensures each browser tab gets a unique peerId while
// maintaining stability across page reloads within the same tab. The first
// tab to open claims the stable "device" peerId stored in localStorage;
// subsequent concurrent tabs receive fresh random peerIds.
//
// Architecture: functional core / imperative shell (FC/IS).
//
//   resolveLease(state)  — pure decision function, no side effects
//   persistentPeerId(key) — imperative shell: GATHER → PLAN → EXECUTE
//   releasePeerId(key)    — clears the lease holder (pagehide, testing)
//
// Storage keys per namespace:
//
//   localStorage[key]          — stable device peerId (permanent)
//   localStorage[key + ":held"] — session token of the tab holding primary
//   sessionStorage[key]         — this tab's active peerId (survives reload)
//   sessionStorage[key + ":tk"] — this tab's unique session token
//
// This is intentionally browser-only. Server-side peerIds should be
// explicit strings passed via `ExchangeParams.identity.peerId`.

import { randomPeerId, randomToken } from "./utils.js"

// ---------------------------------------------------------------------------
// Functional Core — pure lease decision
// ---------------------------------------------------------------------------

/**
 * All storage state needed to decide which peerId this tab should use.
 *
 * Gathered by the imperative shell from localStorage and sessionStorage,
 * then passed to `resolveLease` for a pure decision.
 */
export type LeaseState = {
  /** The stable device peerId from `localStorage[key]`. */
  devicePeerId: string
  /** This tab's unique session token from `sessionStorage[key + ":tk"]`. */
  sessionToken: string
  /** This tab's cached peerId from `sessionStorage[key]`, or null on first visit. */
  cachedPeerId: string | null
  /** The session token of the current lease holder from `localStorage[key + ":held"]`, or null if unheld. */
  holder: string | null
  /**
   * The value of `localStorage[key + ":held"]` AFTER writing our token (CAS readback).
   * Only meaningful when `holder` is null (the CAS path). When `holder` is
   * present, this field is ignored.
   */
  casReadback: string | null
}

/**
 * The lease decision: what action the imperative shell should take.
 *
 * - `"cached"` — return the peerId from sessionStorage (reload stability)
 * - `"claim-primary"` — we hold the lease; use the device peerId
 * - `"generate-fresh"` — someone else holds; generate a new random peerId
 */
export type LeaseDecision =
  | { action: "cached"; peerId: string }
  | { action: "claim-primary"; peerId: string }
  | { action: "generate-fresh" }

/**
 * Pure lease decision function. No storage reads, no storage writes, no side effects.
 *
 * Decision logic:
 * 1. If `cachedPeerId` is non-null → `"cached"` (reload stability)
 * 2. If `holder === sessionToken` → `"claim-primary"` (we already hold)
 * 3. If `holder` is null and `casReadback === sessionToken` → `"claim-primary"` (CAS won)
 * 4. If `holder` is null and `casReadback !== sessionToken` → `"generate-fresh"` (CAS lost)
 * 5. If `holder` is non-null and foreign → `"generate-fresh"` (someone else holds)
 */
export function resolveLease(state: LeaseState): LeaseDecision {
  // 1. Reload stability — sessionStorage survives reloads
  if (state.cachedPeerId !== null) {
    return { action: "cached", peerId: state.cachedPeerId }
  }

  // 2. We already hold the lease (e.g. re-called within the same tab session)
  if (state.holder === state.sessionToken) {
    return { action: "claim-primary", peerId: state.devicePeerId }
  }

  // 3–4. No holder — CAS path
  if (state.holder === null) {
    if (state.casReadback === state.sessionToken) {
      return { action: "claim-primary", peerId: state.devicePeerId }
    }
    return { action: "generate-fresh" }
  }

  // 5. Foreign holder
  return { action: "generate-fresh" }
}

// ---------------------------------------------------------------------------
// Imperative Shell — storage I/O + pagehide listener
// ---------------------------------------------------------------------------

/** Track which keys have a registered `pagehide` listener to avoid duplicates. */
const registeredKeys = new Set<string>()

/**
 * Release the peerId lease for the given storage key.
 *
 * Clears only `localStorage[key + ":held"]` — the holder token.
 * Does NOT touch `sessionStorage` keys (the cached peerId and session
 * token survive for reload stability).
 *
 * Idempotent — safe to call multiple times or when not holding.
 *
 * @param storageKey - The localStorage namespace. Defaults to `"kyneta-peer-id"`.
 */
export function releasePeerId(storageKey = "kyneta-peer-id"): void {
  localStorage.removeItem(storageKey + ":held")
}

/**
 * Get or create a persistent, per-tab-unique peerId.
 *
 * Uses a localStorage CAS (compare-and-swap) lease protocol to elect a
 * primary tab that receives the stable device peerId. Subsequent concurrent
 * tabs receive fresh random peerIds. All tabs preserve their peerId across
 * page reloads via `sessionStorage`.
 *
 * **Browser-only** — uses `localStorage` and `sessionStorage`. Will throw
 * in environments where these are not available (Node.js, SSR). Server-side
 * peerIds should be explicit strings, not generated.
 *
 * @param storageKey - The localStorage namespace. Defaults to `"kyneta-peer-id"`.
 *   Use a unique key per application to avoid collisions when multiple
 *   kyneta apps share the same origin.
 * @returns A stable 16-char hex peerId string, unique per tab.
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
  const heldKey = storageKey + ":held"
  const tokenKey = storageKey + ":tk"

  // ── GATHER ──────────────────────────────────────────────────────────────

  // Ensure device peerId exists in localStorage (permanent, never changes).
  let devicePeerId = localStorage.getItem(storageKey)
  if (!devicePeerId) {
    devicePeerId = randomPeerId()
    localStorage.setItem(storageKey, devicePeerId)
  }

  // Ensure session token exists in sessionStorage (unique per tab, survives reload).
  let sessionToken = sessionStorage.getItem(tokenKey)
  if (!sessionToken) {
    sessionToken = randomToken()
    sessionStorage.setItem(tokenKey, sessionToken)
  }

  // Read cached peerId (non-null on reload within the same tab).
  const cachedPeerId = sessionStorage.getItem(storageKey)

  // Read current holder.
  const holder = localStorage.getItem(heldKey)

  // If no holder, attempt CAS: write our token, then read back.
  let casReadback: string | null = null
  if (holder === null) {
    localStorage.setItem(heldKey, sessionToken)
    casReadback = localStorage.getItem(heldKey)
  }

  // ── PLAN ────────────────────────────────────────────────────────────────

  const decision = resolveLease({
    devicePeerId,
    sessionToken,
    cachedPeerId,
    holder,
    casReadback,
  })

  // ── EXECUTE ─────────────────────────────────────────────────────────────

  let peerId: string
  switch (decision.action) {
    case "cached":
      return decision.peerId
    case "claim-primary":
      peerId = decision.peerId
      break
    case "generate-fresh":
      peerId = randomPeerId()
      break
  }

  // Cache in sessionStorage for reload stability.
  sessionStorage.setItem(storageKey, peerId)

  // Register pagehide listener (once per key) to release the lease on
  // tab close, navigation, or bfcache eviction. sessionStorage keys
  // survive reload — only the holder token is cleared.
  if (!registeredKeys.has(storageKey)) {
    registeredKeys.add(storageKey)
    globalThis.addEventListener("pagehide", () => releasePeerId(storageKey))
  }

  return peerId
}
