// @kyneta/loro-schema — Loro CRDT substrate for @kyneta/schema.
//
// Provides a Substrate<LoroVersion> implementation that wraps a LoroDoc
// with schema-aware typed reads, writes, versioning, and export/import.
//
// Batteries-included API (most users):
//   createLoroDoc, createLoroDocFromEntirety, version, exportEntirety,
//   exportSince, merge, change, subscribe, applyChanges
//
// Low-level primitives (power users):
//   createLoroSubstrate, loroSubstrateFactory, loroReader,
//   resolveContainer, stepIntoLoro, changeToDiff, batchToOps, LoroVersion

// ---------------------------------------------------------------------------
// Batteries-included API — one import, one createLoroDoc call, done
// ---------------------------------------------------------------------------

// Types (re-exported for convenience)
export type { Changeset, Op, Ref, SubstratePayload } from "@kyneta/schema"
// Mutation & observation (re-exported from @kyneta/schema for convenience)
// Schema definition (re-exported for convenience)
export {
  applyChanges,
  change,
  Schema,
  subscribe,
  subscribeNode,
} from "@kyneta/schema"
// Construction
export { createLoroDoc, createLoroDocFromEntirety } from "./create.js"
export { LoroSchema } from "./loro-schema.js"
// Sync primitives (Loro-specific)
export {
  exportEntirety,
  exportSince,
  merge,
  version,
} from "./sync.js"

// ---------------------------------------------------------------------------
// Low-level primitives — for power users and custom substrate compositions
// ---------------------------------------------------------------------------

// Bind — convenience wrapper for Loro CRDT substrate
export { bindLoro } from "./bind-loro.js"
// Change mapping
export { batchToOps, changeToDiff } from "./change-mapping.js"
// Escape hatch — access the underlying LoroDoc from a ref
export { loro } from "./loro-escape.js"
// Container resolution
export { resolveContainer, stepIntoLoro } from "./loro-resolve.js"
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
