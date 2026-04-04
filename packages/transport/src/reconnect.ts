// reconnect — shared reconnection utilities for client transports.
//
// Provides pure backoff computation and default reconnection options.
// The imperative reconnection scheduling that formerly lived here is now
// handled by each transport's pure program + createObservableProgram runtime.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Reconnect configuration — shared across all client transports.
 */
export interface ReconnectOptions {
  enabled: boolean
  maxAttempts: number
  baseDelay: number
  maxDelay: number
}

/**
 * Default reconnection options.
 */
export const DEFAULT_RECONNECT: ReconnectOptions = {
  enabled: true,
  maxAttempts: 10,
  baseDelay: 1000,
  maxDelay: 30000,
}

// ---------------------------------------------------------------------------
// Functional core — pure backoff computation
// ---------------------------------------------------------------------------

/**
 * Compute the reconnection delay for a given attempt number.
 *
 * Uses exponential backoff with jitter, clamped to maxDelay.
 * Pure function — no side effects.
 *
 * @param attempt - The 1-based attempt number
 * @param baseDelay - Base delay in ms
 * @param maxDelay - Maximum delay in ms
 * @param jitter - Random jitter in ms (injected for testability)
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  jitter: number,
): number {
  return Math.min(baseDelay * 2 ** (attempt - 1) + jitter, maxDelay)
}
