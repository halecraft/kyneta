// factory — MergeStrategy and ExchangeSubstrateFactory.
//
// `MergeStrategy` declares the sync algorithm the exchange should run
// on behalf of a substrate. It is a property of the factory, not the
// substrate — the substrate is passive (state algebra), the exchange
// is active (sync algebra).
//
// `ExchangeSubstrateFactory<V>` extends `SubstrateFactory<V>` with:
// - `mergeStrategy` — dispatch key for the sync algorithm
// - `_initialize({ peerId })` — lifecycle hook for peer identity injection
//
// The exchange calls `_initialize` during its own construction, passing
// its string peerId. The factory translates it deterministically into
// substrate-native identity (e.g. Loro numeric PeerID via hash).

import type { SubstrateFactory, Version } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// MergeStrategy — dispatch key for the sync algorithm
// ---------------------------------------------------------------------------

/**
 * Declares the sync algorithm the exchange runs for a substrate type.
 *
 * These are genuinely different protocols matched to the mathematical
 * properties of the substrate, not transport optimizations:
 *
 * - **causal**: Bidirectional exchange. `compare()` may return
 *   `"concurrent"`. Uses `exportSince()` for fine-grained deltas.
 *   Example: Loro CRDT substrate.
 *
 * - **sequential**: Request/response. Total order — `compare()` never
 *   returns `"concurrent"`. Uses `exportSince()` or `exportSnapshot()`.
 *   Example: Plain substrate with monotonic version counter.
 *
 * - **lww**: Unidirectional push/broadcast. Timestamp-based. Always
 *   uses `exportSnapshot()`. Receiver compares timestamps and discards
 *   stale arrivals. Example: Ephemeral presence state.
 */
export type MergeStrategy =
  | { type: "causal" }
  | { type: "sequential" }
  | { type: "lww" }

// ---------------------------------------------------------------------------
// ExchangeSubstrateFactory — SubstrateFactory + sync metadata + identity
// ---------------------------------------------------------------------------

/**
 * A `SubstrateFactory` extended with exchange-specific metadata and
 * lifecycle hooks.
 *
 * The exchange uses `mergeStrategy` to select the correct sync algorithm.
 * It calls `_initialize` during construction to inject the repo-level
 * peer identity, which the factory may translate into substrate-native
 * form (e.g. hashing a string into a Loro numeric PeerID).
 *
 * Factories that don't need peer identity (e.g. plain substrate) can
 * implement `_initialize` as a no-op.
 */
export interface ExchangeSubstrateFactory<V extends Version = Version>
  extends SubstrateFactory<V> {
  /** The sync algorithm the exchange should run for this substrate type. */
  readonly mergeStrategy: MergeStrategy

  /**
   * Lifecycle hook called by the exchange during construction.
   *
   * The exchange provides its canonical string peerId. The factory
   * translates it deterministically into substrate-native identity
   * if needed (e.g. hash → Loro numeric PeerID).
   *
   * Called exactly once per factory instance, before any `create()`
   * or `fromSnapshot()` calls.
   */
  _initialize(context: { peerId: string }): void
}