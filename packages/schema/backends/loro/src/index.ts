// @kyneta/loro-schema — Loro CRDT substrate for @kyneta/schema.
//
// Provides a Substrate<LoroVersion> implementation that wraps a LoroDoc
// with schema-aware typed reads, writes, versioning, and export/import.
//
// The single entry point is `createDoc(loro.bind(schema))`. For the
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
// Loro-specific exports
// ---------------------------------------------------------------------------

// Namespace — substrate strategies
export { type LoroCaps, loro } from "./bind-loro.js"
// Change mapping
export { batchToOps, changeToDiff } from "./change-mapping.js"
// Guards — shared Loro runtime type guards
export { hasKind, isLoroContainer, isLoroDoc } from "./loro-guards.js"
// Container resolution
export { resolveContainer, stepIntoLoro } from "./loro-resolve.js"
// NativeMap — the Loro functor
export type { LoroNativeMap } from "./native-map.js"
// Reader
export { loroReader } from "./reader.js"
// Substrate
export {
  createLoroSubstrate,
  loroReplicaFactory,
  loroSubstrateFactory,
} from "./substrate.js"
// Version
export { LoroVersion } from "./version.js"
