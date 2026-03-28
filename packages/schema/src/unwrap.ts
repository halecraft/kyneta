// unwrap — general escape hatch for accessing the Substrate backing a ref.
//
// `unwrap(ref)` returns the `Substrate<any>` that backs a given ref.
// `registerSubstrate(ref, substrate)` populates the mapping.
//
// The WeakMap is populated by the exchange (or any other system that
// constructs refs from substrates) via `registerSubstrate`. This is
// a schema-level utility so that any consumer of `@kyneta/schema` can
// access the substrate without depending on `@kyneta/exchange`.

import type { Substrate } from "./substrate.js"

// ---------------------------------------------------------------------------
// Module-scoped WeakMap — maps refs to their backing substrates
// ---------------------------------------------------------------------------

const refToSubstrate = new WeakMap<object, Substrate<any>>()

// ---------------------------------------------------------------------------
// registerSubstrate — called by the exchange (or equivalent) after
// building a ref from a substrate
// ---------------------------------------------------------------------------

/**
 * Register the substrate backing a ref.
 *
 * Called by the exchange (or any ref-constructing system) after
 * building the interpreter stack from a substrate. This enables
 * `unwrap(ref)` to retrieve the substrate later.
 *
 * Overwrites any previous registration for the same ref.
 */
export function registerSubstrate(
  ref: object,
  substrate: Substrate<any>,
): void {
  refToSubstrate.set(ref, substrate)
}

// ---------------------------------------------------------------------------
// unwrap — retrieve the Substrate backing a ref
// ---------------------------------------------------------------------------

/**
 * Returns the `Substrate<any>` backing the given ref.
 *
 * This is the general escape hatch for accessing substrate-level
 * capabilities (versioning, export/import) from a ref. For
 * substrate-specific escape hatches (e.g. accessing the underlying
 * `LoroDoc`), see the substrate's package (e.g. `loro()` from
 * `@kyneta/loro-schema`).
 *
 * @param ref - A ref created by `exchange.get()` or equivalent
 * @returns The `Substrate<any>` backing the ref
 * @throws If the ref has no registered substrate
 *
 * @example
 * ```ts
 * import { unwrap } from "@kyneta/schema"
 *
 * const doc = exchange.get("my-doc", MyDoc)
 * const substrate = unwrap(doc)
 * substrate.version().serialize()   // current version
 * substrate.exportSnapshot()         // full state snapshot
 * ```
 */
export function unwrap(ref: object): Substrate<any> {
  const substrate = refToSubstrate.get(ref)
  if (!substrate) {
    throw new Error(
      "unwrap() requires a ref with a registered substrate. " +
        "Refs created by exchange.get() are automatically registered. " +
        "For manually constructed refs, call registerSubstrate(ref, substrate) first.",
    )
  }
  return substrate
}
