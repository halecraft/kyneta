// alias-error — discriminated union of alias-resolution failures.
//
// Lives in @kyneta/wire so that WireError's alias-resolution-failed
// variant can reference it without pulling in the alias transformer
// (which lives in @kyneta/transport).

// ---------------------------------------------------------------------------
// Alias type (re-exported for ergonomic use)
// ---------------------------------------------------------------------------

export type Alias = number

// ---------------------------------------------------------------------------
// AliasResolutionError
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all alias-resolution failures.
 *
 * Covers both inbound (decode-side) and outbound (encode-side) paths.
 * Each variant carries enough context for the Pipeline's `onError`
 * callback to produce a useful diagnostic.
 */
export type AliasResolutionError =
  | { readonly code: "unknown-doc-alias"; readonly alias: Alias }
  | { readonly code: "unknown-schema-alias"; readonly alias: Alias }
  | { readonly code: "missing-doc-id"; readonly reason: string }
  | { readonly code: "missing-schema-hash"; readonly reason: string }
  | { readonly code: "doc-id-too-long"; readonly message: string }
  | { readonly code: "schema-hash-too-long"; readonly message: string }
  | { readonly code: "unknown-sync-protocol"; readonly value: unknown }
  | { readonly code: "unknown-payload-kind"; readonly value: unknown }
  | { readonly code: "unknown-payload-encoding"; readonly value: unknown }
  | { readonly code: "unknown-message-type"; readonly value: unknown }
