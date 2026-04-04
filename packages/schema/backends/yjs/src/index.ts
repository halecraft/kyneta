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

// Text annotation convenience — so users don't need LoroSchema just for text()
import type { AnnotatedSchema } from "@kyneta/schema"
import { Schema } from "@kyneta/schema"

/**
 * Collaborative text (CRDT). Produces `annotated("text")`.
 *
 * The annotation implies scalar string semantics for reads,
 * but the Yjs substrate provides collaborative editing (insert, delete)
 * via Y.Text.
 *
 * This is a convenience re-export so that `@kyneta/yjs-schema` users
 * don't need to import `LoroSchema` just for `text()`.
 */
export function text(): AnnotatedSchema<"text", undefined> {
  return Schema.annotated("text")
}

// Types (re-exported for convenience)
export type { Changeset } from "@kyneta/changefeed"
export type { Op, Ref, SubstratePayload } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Low-level primitives — for power users and custom substrate compositions
// ---------------------------------------------------------------------------

// Bind — convenience wrapper for Yjs CRDT substrate
export { bindYjs } from "./bind-yjs.js"
// Change mapping
export { applyChangeToYjs, eventsToOps } from "./change-mapping.js"
// Container creation
export { ensureContainers } from "./populate.js"
// Reader
export { yjsReader } from "./reader.js"
// Substrate
export { createYjsSubstrate, yjsSubstrateFactory } from "./substrate.js"
// Version
export { YjsVersion } from "./version.js"
// Escape hatch — access the underlying Y.Doc from a ref
export { yjs } from "./yjs-escape.js"
// Container resolution
export { resolveYjsType, stepIntoYjs } from "./yjs-resolve.js"
