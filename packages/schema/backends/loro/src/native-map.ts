// native-map — Loro NativeMap functor.
//
// Maps schema kinds to Loro-native container types. Used as the `N`
// type parameter in `SchemaRef<S, M, N>` for Loro-backed documents.

import type { NativeMap } from "@kyneta/schema"
import type {
  LoroCounter,
  LoroDoc,
  LoroList,
  LoroMap,
  LoroMovableList,
  LoroText,
  LoroTree,
} from "loro-crdt"

/**
 * NativeMap for the Loro CRDT substrate.
 *
 * Maps each schema kind to the corresponding Loro container type:
 * - `root → LoroDoc` (the document itself)
 * - `text → LoroText`
 * - `counter → LoroCounter`
 * - `list → LoroList`
 * - `movableList → LoroMovableList`
 * - `struct → LoroMap` (Loro uses maps for struct fields)
 * - `map → LoroMap`
 * - `tree → LoroTree`
 * - `set → undefined` (not yet supported)
 * - `scalar → undefined` (no container; value in _props)
 * - `sum → undefined` (no container; value in _props)
 */
export interface LoroNativeMap extends NativeMap {
  readonly root: LoroDoc
  readonly text: LoroText
  readonly counter: LoroCounter
  readonly list: LoroList
  readonly movableList: LoroMovableList
  readonly struct: LoroMap
  readonly map: LoroMap
  readonly tree: LoroTree
  readonly set: undefined
  readonly scalar: undefined
  readonly sum: undefined
}
