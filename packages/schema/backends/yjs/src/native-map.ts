// native-map — Yjs NativeMap functor.
//
// Maps schema kinds to Yjs shared types. Used as the `N`
// type parameter in `SchemaRef<S, M, N>` for Yjs-backed documents.

import type { NativeMap } from "@kyneta/schema"
import type * as Y from "yjs"

/**
 * NativeMap for the Yjs CRDT substrate.
 *
 * Maps each schema kind to the corresponding Yjs shared type:
 * - `root → Y.Doc` (the document itself)
 * - `text → Y.Text`
 * - `counter → undefined` (Yjs has no counter type)
 * - `list → Y.Array<unknown>`
 * - `movableList → undefined` (Yjs has no movable list)
 * - `struct → Y.Map<unknown>` (Yjs uses maps for struct fields)
 * - `map → Y.Map<unknown>`
 * - `tree → undefined` (Yjs has no tree type)
 * - `set → undefined` (not yet supported)
 * - `scalar → undefined` (no container; stored in parent map)
 * - `sum → undefined` (no container; stored in parent map)
 */
export interface YjsNativeMap extends NativeMap {
  readonly root: Y.Doc
  readonly text: Y.Text
  readonly counter: undefined
  readonly list: Y.Array<unknown>
  readonly movableList: undefined
  readonly struct: Y.Map<unknown>
  readonly map: Y.Map<unknown>
  readonly tree: undefined
  readonly set: undefined
  readonly scalar: undefined
  readonly sum: undefined
}
