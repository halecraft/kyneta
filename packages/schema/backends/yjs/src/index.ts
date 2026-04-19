// @kyneta/yjs-schema — Yjs CRDT substrate for @kyneta/schema.
//
// Provides a Substrate<YjsVersion> implementation that wraps a Y.Doc
// with schema-aware typed reads, writes, versioning, and export/import.
//
// The single entry point is `createDoc(yjs.bind(schema))`. For the
// batteries-included API, import from this package. For the composable
// toolkit, import from `@kyneta/schema` directly.

// ---------------------------------------------------------------------------
// Generic API (re-exported from @kyneta/schema for convenience)
// ---------------------------------------------------------------------------

// Types (re-exported for convenience)
export type { Changeset } from "@kyneta/changefeed"
export type { DocRef, Op, Ref, SubstratePayload } from "@kyneta/schema"
// Construction
// Mutation & observation (re-exported from @kyneta/schema for convenience)
// Schema definition (re-exported for convenience)
// Native escape hatch
// Sync primitives (generic — work for any substrate)
export {
  applyChanges,
  change,
  createDoc,
  createRef,
  exportEntirety,
  exportSince,
  merge,
  NATIVE,
  Schema,
  subscribe,
  subscribeNode,
  unwrap,
  version,
} from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Yjs-specific exports
// ---------------------------------------------------------------------------

export type { YjsCaps } from "./bind-yjs.js"
// Namespace
export { yjs } from "./bind-yjs.js"
// Change mapping
export { applyChangeToYjs, eventsToOps } from "./change-mapping.js"
// NativeMap — the Yjs functor
export type { YjsNativeMap } from "./native-map.js"
// Container creation
export { ensureContainers } from "./populate.js"
// Position conformance
export { fromYjsAssoc, toYjsAssoc, YjsPosition } from "./position.js"
// Reader
export { yjsReader } from "./reader.js"
// Substrate
export {
  createYjsSubstrate,
  yjsReplicaFactory,
  yjsSubstrateFactory,
} from "./substrate.js"
// Version
export { YjsVersion } from "./version.js"
// Container resolution
export { resolveYjsType, stepIntoYjs } from "./yjs-resolve.js"
