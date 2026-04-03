// yjs-escape — Yjs-specific escape hatch for accessing the Y.Doc
// backing a ref.
//
// `yjs(ref)` returns the `Y.Doc` backing a root document ref.
//
// The substrate exposes its backing Y.Doc via the `BACKING_DOC` symbol
// (from `@kyneta/schema`). The `yjs()` function uses `unwrap()` to get
// the substrate, then reads `[BACKING_DOC]` to get the Y.Doc.
//
// This two-step approach (ref → substrate → Y.Doc) avoids duplicating
// the ref-tracking WeakMap and composes cleanly with the general
// `unwrap()` escape hatch.
//
// Context: jj:smmulzkm (BACKING_DOC replaces WeakMap + registerYjsSubstrate)
//
// Usage:
//   import { yjs } from "@kyneta/yjs-schema"
//
//   const doc = exchange.get("my-doc", TodoDoc)
//   const yjsDoc = yjs(doc)  // Y.Doc
//   yjsDoc.getMap("root").toJSON()  // raw Yjs inspection

import { BACKING_DOC, unwrap } from "@kyneta/schema"
import type { Doc as YDoc } from "yjs"

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
  let substrate: any
  try {
    substrate = unwrap(ref)
  } catch {
    throw new Error(
      "yjs() requires a ref backed by a Yjs substrate. " +
        "Use a doc created by exchange.get() with a bindYjs() schema, " +
        "or by createYjsDoc().",
    )
  }

  const doc = substrate[BACKING_DOC]
  // Duck-type check: Y.Doc has getMap, encodeStateVector-compatible API,
  // and a numeric clientID. A PlainState (plain object) or LoroDoc would
  // not have getMap as a function.
  if (
    !doc ||
    typeof doc !== "object" ||
    typeof (doc as any).getMap !== "function" ||
    typeof (doc as any).clientID !== "number"
  ) {
    throw new Error(
      "yjs() requires a ref backed by a Yjs substrate. " +
        "The ref has a substrate but it is not a Yjs substrate. " +
        "Use a doc created with a bindYjs() schema or createYjsDoc().",
    )
  }
  return doc as YDoc
}
