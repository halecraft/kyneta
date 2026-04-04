// ChangeBase — the universal base type for all changes.
//
// A change describes a delta to a reactive value. The same change
// structure flows in both directions:
//   - Going in (producer → consumer): the change describes what happened
//   - Coming out (consumer → subscriber): the change describes the delta
//
// Changes are an open protocol identified by a string discriminant.
// Built-in change types (TextChange, SequenceChange, etc.) live in
// @kyneta/schema — they are schema vocabulary, not contract primitives.
// Third-party producers extend ChangeBase with their own types.

// ---------------------------------------------------------------------------
// Base protocol
// ---------------------------------------------------------------------------

/**
 * All changes carry a string `type` discriminant. Built-in change types
 * use well-known strings ("text", "sequence", "map", "replace", "tree").
 * Third-party producers extend this with their own types.
 *
 * Provenance metadata (e.g. "local", "sync") is carried at the batch
 * level on `Changeset.origin`, not on individual changes. See
 * `Changeset` in `changefeed.ts`.
 */
export interface ChangeBase {
  readonly type: string
}
