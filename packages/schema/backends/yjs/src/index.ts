// @kyneta/yjs-schema — Yjs CRDT substrate for @kyneta/schema.
//
// Provides a Substrate<YjsVersion> implementation that wraps a Y.Doc
// with schema-aware typed reads, writes, versioning, and export/import.
//
// Batteries-included API (most users):
//   createYjsDoc, createYjsDocFromEntirety, version, exportEntirety,
//   exportSince, merge, change, subscribe, applyChanges
//
// Low-level primitives (power users):
//   createYjsSubstrate, yjsSubstrateFactory, yjsReader,
//   resolveYjsType, stepIntoYjs, applyChangeToYjs, eventsToOps, YjsVersion

// ---------------------------------------------------------------------------
// Batteries-included API — one import, one createYjsDoc call, done
// ---------------------------------------------------------------------------

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
export { createYjsDoc, createYjsDocFromEntirety } from "./create.js"
// Sync primitives (Yjs-specific)
export {
  exportEntirety,
  exportSince,
  merge,
  version,
} from "./sync.js"

// Types (re-exported for convenience)
export type { Changeset } from "@kyneta/changefeed"
export type { Op, Ref, SubstratePayload } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Low-level primitives — for power users and custom substrate compositions
// ---------------------------------------------------------------------------

// Namespace — the yjs substrate namespace (replaces standalone escape hatch;
// the old `yjs(ref)` call is now `yjs.unwrap(ref)`)
export { yjs } from "./bind-yjs.js"
export type { YjsCaps } from "./bind-yjs.js"
// Change mapping
export { applyChangeToYjs, eventsToOps } from "./change-mapping.js"
// Container creation
export { ensureContainers } from "./populate.js"
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