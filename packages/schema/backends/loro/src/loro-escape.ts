// loro-escape — Loro-specific escape hatch for accessing the LoroDoc
// backing a ref.
//
// `loro(ref)` returns the `LoroDoc` backing a root document ref.
//
// The substrate exposes its backing LoroDoc via the `BACKING_DOC` symbol
// (from `@kyneta/schema`). The `loro()` function uses `unwrap()` to get
// the substrate, then reads `[BACKING_DOC]` to get the LoroDoc.
//
// This two-step approach (ref → substrate → LoroDoc) avoids duplicating
// the ref-tracking WeakMap and composes cleanly with the general
// `unwrap()` escape hatch.
//
// Child-level resolution (e.g. `loro(doc.title)` → `LoroText`) is
// documented as future work — it requires refs to carry their path,
// which the current interpreter stack doesn't expose.
//
// Context: jj:smmulzkm (BACKING_DOC replaces WeakMap + registerLoroSubstrate)
//
// Usage:
//   import { loro } from "@kyneta/loro-schema"
//
//   const doc = exchange.get("my-doc", TodoDoc)
//   const loroDoc = loro(doc)  // LoroDoc
//   loroDoc.toJSON()           // raw Loro inspection

import { BACKING_DOC, unwrap } from "@kyneta/schema"
import type { LoroDoc } from "loro-crdt"

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
 * import { loro } from "@kyneta/loro-schema"
 *
 * const doc = exchange.get("my-doc", TodoDoc)
 * const loroDoc = loro(doc)
 * console.log(loroDoc.toJSON())       // raw state
 * console.log(loroDoc.version())      // VersionVector
 * console.log(loroDoc.peerIdStr)      // peer ID
 * ```
 */
export function loro(ref: object): LoroDoc {
  let substrate: any
  try {
    substrate = unwrap(ref)
  } catch {
    throw new Error(
      "loro() requires a ref backed by a Loro substrate. " +
        "Use a doc created by exchange.get() with a bindLoro() schema, " +
        "or by createLoroDoc().",
    )
  }

  const doc = substrate[BACKING_DOC]
  // Duck-type check: LoroDoc has toJSON, version, and import methods.
  // A PlainState (plain object) or Y.Doc would not have all three.
  if (
    !doc ||
    typeof doc !== "object" ||
    typeof (doc as any).toJSON !== "function" ||
    typeof (doc as any).version !== "function" ||
    typeof (doc as any).import !== "function"
  ) {
    throw new Error(
      "loro() requires a ref backed by a Loro substrate. " +
        "The ref has a substrate but it is not a Loro substrate. " +
        "Use a doc created with a bindLoro() schema or createLoroDoc().",
    )
  }
  return doc as LoroDoc
}