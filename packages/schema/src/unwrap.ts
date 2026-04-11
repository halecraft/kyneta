// unwrap — typed escape hatch for accessing the native container backing a ref.
//
// `unwrap(ref)` reads `ref[NATIVE]` — the substrate-native container
// attached during interpretation via the nativeResolver protocol.
//
// Fully typed: the return type is inferred from the ref's [NATIVE] property.
// For example, `unwrap(loroRef.title)` returns `LoroText`, not `unknown`.

import { isPropertyHost } from "./guards.js"
import { NATIVE } from "./native.js"

// ---------------------------------------------------------------------------
// HasNativeAny — minimal constraint for unwrap()
// ---------------------------------------------------------------------------

/**
 * Minimal constraint for `unwrap()` — any object with a `[NATIVE]` property.
 */
export interface HasNativeAny {
  readonly [NATIVE]: unknown
}

// ---------------------------------------------------------------------------
// unwrap — typed escape hatch
// ---------------------------------------------------------------------------

/**
 * Returns the substrate-native container backing a ref.
 *
 * Reads the `[NATIVE]` symbol property set during interpretation by
 * the `nativeResolver` protocol. Fully typed via conditional return:
 *
 * ```ts
 * const doc = createDoc(loro.bind(schema))
 * unwrap(doc)           // LoroDoc
 * unwrap(doc.title)     // LoroText
 * unwrap(doc.items)     // LoroList
 * unwrap(doc.theme)     // undefined (scalar)
 * ```
 *
 * @param ref - Any ref with a `[NATIVE]` property
 * @returns The native container (LoroText, Y.Map, PlainState, etc.) or undefined
 */
export function unwrap<R extends HasNativeAny>(ref: R): R[typeof NATIVE] {
  if (!isPropertyHost(ref)) {
    throw new Error("unwrap() requires a ref object.")
  }
  return (ref as any)[NATIVE]
}
