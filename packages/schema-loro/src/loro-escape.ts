// loro-escape — Loro-specific escape hatch for accessing the LoroDoc
// backing a ref.
//
// `loro(ref)` returns the `LoroDoc` backing a root document ref.
//
// The mapping is maintained via a WeakMap from Substrate → LoroDoc,
// populated by `registerLoroSubstrate()` (called during substrate
// creation). The `loro()` function uses `unwrap()` from `@kyneta/schema`
// to get the substrate, then looks up the LoroDoc.
//
// This two-step approach (ref → substrate → LoroDoc) avoids duplicating
// the ref-tracking WeakMap and composes cleanly with the general
// `unwrap()` escape hatch.
//
// Child-level resolution (e.g. `loro(doc.title)` → `LoroText`) is
// documented as future work — it requires refs to carry their path,
// which the current interpreter stack doesn't expose.
//
// Usage:
//   import { loro } from "@kyneta/schema-loro"
//
//   const doc = exchange.get("my-doc", TodoDoc)
//   const loroDoc = loro(doc)  // LoroDoc
//   loroDoc.toJSON()           // raw Loro inspection

import type { LoroDoc } from "loro-crdt"
import type { Substrate } from "@kyneta/schema"
import { unwrap } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Substrate → LoroDoc mapping
// ---------------------------------------------------------------------------

const substrateToLoroDoc = new WeakMap<Substrate<any>, LoroDoc>()

// ---------------------------------------------------------------------------
// registerLoroSubstrate — called during substrate creation
// ---------------------------------------------------------------------------

/**
 * Register the LoroDoc backing a Loro substrate.
 *
 * Called by `createLoroSubstrate()` and by `bindLoro`'s factory builder
 * to enable the `loro()` escape hatch. Must be called once per substrate
 * at construction time.
 */
export function registerLoroSubstrate(
  substrate: Substrate<any>,
  doc: LoroDoc,
): void {
  substrateToLoroDoc.set(substrate, doc)
}

// ---------------------------------------------------------------------------
// loro — Loro-specific escape hatch
// ---------------------------------------------------------------------------

/**
 * Returns the `LoroDoc` backing the given ref.
 *
 * This is the Loro-specific escape hatch for accessing substrate-level
 * capabilities: raw Loro API, prosemirror/codemirror bindings, undo
 * manager, time travel, etc.
 *
 * Currently supports root document refs only. Child-level resolution
 * (e.g. `loro(doc.title)` → `LoroText`) is future work.
 *
 * @param ref - A root document ref backed by a Loro substrate
 * @returns The `LoroDoc` backing the ref
 * @throws If the ref is not backed by a Loro substrate
 *
 * @example
 * ```ts
 * import { loro } from "@kyneta/schema-loro"
 *
 * const doc = exchange.get("my-doc", TodoDoc)
 * const loroDoc = loro(doc)
 * console.log(loroDoc.toJSON())       // raw state
 * console.log(loroDoc.version())      // VersionVector
 * console.log(loroDoc.peerIdStr)      // peer ID
 * ```
 */
export function loro(ref: object): LoroDoc {
  let substrate: Substrate<any>
  try {
    substrate = unwrap(ref)
  } catch {
    throw new Error(
      "loro() requires a ref backed by a Loro substrate. " +
        "Use a doc created by exchange.get() with a bindLoro() schema, " +
        "or by createLoroDoc().",
    )
  }

  const doc = substrateToLoroDoc.get(substrate)
  if (!doc) {
    throw new Error(
      "loro() requires a ref backed by a Loro substrate. " +
        "The ref has a substrate but it is not a Loro substrate. " +
        "Use a doc created with a bindLoro() schema or createLoroDoc().",
    )
  }
  return doc
}