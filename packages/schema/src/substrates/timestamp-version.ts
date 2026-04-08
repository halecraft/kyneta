// timestamp-version — Version implementation using wall-clock timestamps.
//
// Used by LWW (last-writer-wins) substrates for ephemeral/presence state.
// Timestamps form a total order — `compare()` never returns `"concurrent"`.
// Ties resolve as `"equal"`.
//
// The LWW algorithm depends on honest & time-synchronized senders to
// encode the timestamp. This is useful because it both filters
// out-of-order packets and allows for a compare-once-at-destination
// semantic for LWW.

import type { Version } from "../substrate.js"

/**
 * A Version wrapping a wall-clock timestamp (milliseconds since epoch).
 *
 * Timestamps form a total order — `compare()` returns `"behind"`,
 * `"equal"`, or `"ahead"` but never `"concurrent"`. This is the
 * correct version type for LWW merge strategy: the receiver compares
 * timestamps and discards stale arrivals.
 *
 * `serialize()` encodes to a decimal string for text-safe embedding.
 * `parse()` is the inverse.
 */
export class TimestampVersion implements Version {
  readonly timestamp: number

  constructor(timestamp: number) {
    this.timestamp = timestamp
  }

  /**
   * Create a TimestampVersion from the current wall clock.
   */
  static now(): TimestampVersion {
    return new TimestampVersion(Date.now())
  }

  /**
   * Serialize the timestamp to a decimal string.
   */
  serialize(): string {
    return String(this.timestamp)
  }

  /**
   * Compare with another version.
   *
   * Timestamps form a total order:
   * - `this.timestamp < other.timestamp` → `"behind"`
   * - `this.timestamp > other.timestamp` → `"ahead"`
   * - `this.timestamp === other.timestamp` → `"equal"`
   *
   * Never returns `"concurrent"`.
   *
   * @throws If `other` is not a `TimestampVersion`.
   */
  /**
   * Greatest lower bound (lattice meet) of two versions.
   *
   * For timestamps (total order), this is simply the minimum.
   *
   * @throws If `other` is not a `TimestampVersion`.
   */
  meet(other: Version): TimestampVersion {
    if (!(other instanceof TimestampVersion)) {
      throw new Error(
        "TimestampVersion can only be meet'd with another TimestampVersion",
      )
    }
    return new TimestampVersion(Math.min(this.timestamp, other.timestamp))
  }

  compare(other: Version): "behind" | "equal" | "ahead" | "concurrent" {
    if (!(other instanceof TimestampVersion)) {
      throw new Error(
        "TimestampVersion can only be compared with another TimestampVersion",
      )
    }
    if (this.timestamp < other.timestamp) return "behind"
    if (this.timestamp > other.timestamp) return "ahead"
    return "equal"
  }

  /**
   * Parse a serialized TimestampVersion string back into an instance.
   *
   * The inverse of `serialize()`: decimal string → number → TimestampVersion.
   *
   * @throws If the string is empty or does not represent a valid non-negative integer.
   */
  static parse(serialized: string): TimestampVersion {
    if (serialized === "") {
      throw new Error("Invalid TimestampVersion value: (empty string)")
    }
    const n = Number(serialized)
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Invalid TimestampVersion value: ${serialized}`)
    }
    return new TimestampVersion(n)
  }
}
