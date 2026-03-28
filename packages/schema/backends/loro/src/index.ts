// @kyneta/loro-schema — Loro CRDT substrate for @kyneta/schema.
//
// Provides a Substrate<LoroVersion> implementation that wraps a LoroDoc
// with schema-aware typed reads, writes, versioning, and export/import.
//
// Batteries-included API (most users):
//   createLoroDoc, createLoroDocFromSnapshot, version, exportSnapshot,
//   exportSince, importDelta, change, subscribe, applyChanges
//
// Low-level primitives (power users):
//   createLoroSubstrate, loroSubstrateFactory, loroStoreReader,
//   resolveContainer, stepIntoLoro, changeToDiff, batchToOps, LoroVersion

// ---------------------------------------------------------------------------
// Batteries-included API — one import, one createLoroDoc call, done
// ---------------------------------------------------------------------------

// Construction
export { createLoroDoc, createLoroDocFromSnapshot } from "./create.js"

// Sync primitives (Loro-specific)
export {
  exportSince,
  exportSnapshot,
  importDelta,
  version,
} from "./sync.js"

// Mutation & observation (re-exported from @kyneta/schema for convenience)
export { applyChanges, change } from "@kyneta/schema"
export { subscribe, subscribeNode } from "@kyneta/schema"

// Schema definition (re-exported for convenience)
export { LoroSchema, Schema } from "@kyneta/schema"

// Types (re-exported for convenience)
export type { Changeset, Op, Ref, SubstratePayload } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Low-level primitives — for power users and custom substrate compositions
// ---------------------------------------------------------------------------

// Version
export { LoroVersion } from "./version.js"

// Store reader
export { loroStoreReader } from "./store-reader.js"

// Container resolution
export { resolveContainer, stepIntoLoro } from "./loro-resolve.js"

// Change mapping
export { batchToOps, changeToDiff } from "./change-mapping.js"

// Substrate
export { createLoroSubstrate, loroSubstrateFactory } from "./substrate.js"

// Bind — convenience wrapper for Loro CRDT substrate
export { bindLoro } from "./bind-loro.js"

// Escape hatch — access the underlying LoroDoc from a ref
export { loro } from "./loro-escape.js"