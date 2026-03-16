// substrate — the minimal mutation contract for substrates.
//
// A substrate owns the backing state and knows how to apply changes to it.
// `SubstratePrepare` is the ground floor of the prepare/flush pipeline:
// caching and changefeed layers wrap these primitives — the substrate
// never needs to know about those layers.
//
// This is the minimal interface for Phase 0. The full `Substrate` interface
// (`Frontier`, `exportSnapshot`, etc.) comes in Phase 2 and will extend
// `SubstratePrepare`.
//
// Context: jj:wmyomqzw

import type { Store } from "./store.js"
import type { Path } from "./interpret.js"
import type { ChangeBase } from "./change.js"

// ---------------------------------------------------------------------------
// SubstratePrepare — mutation primitives for the WritableContext
// ---------------------------------------------------------------------------

/**
 * The mutation primitives a substrate exposes to the WritableContext.
 *
 * `prepare` applies a single addressed delta to the substrate's state.
 * `onFlush` is called once per flush cycle, after the changefeed layer
 * has delivered notifications to subscribers.
 *
 * These are the ground floor of the prepare/flush pipeline. Caching and
 * changefeed layers wrap them — the substrate never needs to know about
 * those layers.
 */
export interface SubstratePrepare {
  /** The readable store for the interpreter's RefContext. */
  readonly store: Store

  /** Apply a single (path, change) to the backing state. */
  prepare(path: Path, change: ChangeBase): void

  /**
   * Called once per flush cycle after all prepares and after changefeed
   * notification delivery (since the changefeed wraps flush and calls
   * originalFlush at the end).
   *
   * For PlainSubstrate in this phase: no-op.
   * In Phase 2: bumps version, appends to operation log.
   */
  onFlush(origin?: string): void
}