// yjs-escape — Yjs-specific escape hatch for accessing the Y.Doc
// backing a ref.
//
// `yjs(ref)` returns the `Y.Doc` backing a root document ref.
//
// The mapping is maintained via a WeakMap from Substrate → Y.Doc,
// populated by `registerYjsSubstrate()` (called during substrate
// creation). The `yjs()` function uses `unwrap()` from `@kyneta/schema`
// to get the substrate, then looks up the Y.Doc.
//
// This two-step approach (ref → substrate → Y.Doc) avoids duplicating
// the ref-tracking WeakMap and composes cleanly with the general
// `unwrap()` escape hatch.
//
// Usage:
//   import { yjs } from "@kyneta/yjs-schema"
//
//   const doc = exchange.get("my-doc", TodoDoc)
//   const yjsDoc = yjs(doc)  // Y.Doc
//   yjsDoc.getMap("root").toJSON()  // raw Yjs inspection

import type { Substrate } from "@kyneta/schema"
import { unwrap } from "@kyneta/schema"
import type { Doc as YDoc } from "yjs"

// ---------------------------------------------------------------------------
// Substrate → Y.Doc mapping
// ---------------------------------------------------------------------------

const substrateToYjsDoc = new WeakMap<Substrate<any>, YDoc>()

// ---------------------------------------------------------------------------
// registerYjsSubstrate — called during substrate creation
// ---------------------------------------------------------------------------

/**
 * Register the Y.Doc backing a Yjs substrate.
 *
 * Called by `createYjsSubstrate()` and by `bindYjs`'s factory builder
 * to enable the `yjs()` escape hatch. Must be called once per substrate
 * at construction time.
 */
export function registerYjsSubstrate(
  substrate: Substrate<any>,
  doc: YDoc,
): void {
  substrateToYjsDoc.set(substrate, doc)
}

// ---------------------------------------------------------------------------
// yjs — Yjs-specific escape hatch
// ---------------------------------------------------------------------------

/**
 * Returns the `Y.Doc` backing the given ref.
 *
 * This is the Yjs-specific escape hatch for accessing substrate-level
 * capabilities: raw Yjs API, y-prosemirror/y-codemirror bindings,
 * undo manager, awareness protocol, Yjs providers (y-websocket,
 * y-indexeddb, y-webrtc, Hocuspocus, Liveblocks), etc.
 *
 * Currently supports root document refs only. Child-level resolution
 * (e.g. `yjs(doc.title)` → `Y.Text`) is future work.
 *
 * @param ref - A root document ref backed by a Yjs substrate
 * @returns The `Y.Doc` backing the ref
 * @throws If the ref is not backed by a Yjs substrate
 *
 * @example
 * ```ts
 * import { yjs } from "@kyneta/yjs-schema"
 *
 * const doc = exchange.get("my-doc", TodoDoc)
 * const yjsDoc = yjs(doc)
 * console.log(yjsDoc.getMap("root").toJSON())  // raw state
 * console.log(yjsDoc.clientID)                  // client ID
 * ```
 */
export function yjs(ref: object): YDoc {
  let substrate: Substrate<any>
  try {
    substrate = unwrap(ref)
  } catch {
    throw new Error(
      "yjs() requires a ref backed by a Yjs substrate. " +
        "Use a doc created by exchange.get() with a bindYjs() schema, " +
        "or by createYjsDoc().",
    )
  }

  const doc = substrateToYjsDoc.get(substrate)
  if (!doc) {
    throw new Error(
      "yjs() requires a ref backed by a Yjs substrate. " +
        "The ref has a substrate but it is not a Yjs substrate. " +
        "Use a doc created with a bindYjs() schema or createYjsDoc().",
    )
  }
  return doc
}
