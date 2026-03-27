// permissions — simple synchronous predicates for access control.
//
// Permissions are checked by the synchronizer at every decision point:
// - visibility: can a peer see this document?
// - mutability: can a peer mutate this document?
// - deletion: can a peer delete this document?
//
// For advanced use cases (rate limiting, external auth, audit logging),
// use middleware instead (future work).

import type { DocId, PeerIdentityDetails } from "./types.js"

// ---------------------------------------------------------------------------
// Permission context — what the predicate receives
// ---------------------------------------------------------------------------

/**
 * Context passed to permission predicates.
 */
export type PermissionContext = {
  docId: DocId
  peer: PeerIdentityDetails
  channelKind: "storage" | "network" | "other"
}

// ---------------------------------------------------------------------------
// Permissions interface
// ---------------------------------------------------------------------------

/**
 * Permission predicates controlling document access.
 *
 * All predicates are synchronous and return boolean. They are evaluated
 * at every decision point in the sync protocol:
 *
 * - `visibility`: checked before sending discover/catalog messages
 * - `mutability`: checked before accepting offers (imports)
 * - `deletion`: checked before processing delete requests
 *
 * Default: all permissions return `true` (open access).
 */
export type Permissions = {
  visibility: (ctx: PermissionContext) => boolean
  mutability: (ctx: PermissionContext) => boolean
  deletion: (ctx: PermissionContext) => boolean
}

// ---------------------------------------------------------------------------
// Default permissions — open access
// ---------------------------------------------------------------------------

const defaultPermissions: Permissions = {
  visibility: () => true,
  mutability: () => true,
  deletion: () => true,
}

/**
 * Create a complete Permissions object from partial overrides.
 *
 * Any omitted predicate defaults to `() => true` (open access).
 */
export function createPermissions(
  overrides?: Partial<Permissions>,
): Permissions {
  if (!overrides) return defaultPermissions
  return {
    visibility: overrides.visibility ?? defaultPermissions.visibility,
    mutability: overrides.mutability ?? defaultPermissions.mutability,
    deletion: overrides.deletion ?? defaultPermissions.deletion,
  }
}