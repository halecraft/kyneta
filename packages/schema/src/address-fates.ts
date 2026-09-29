// address-fates — which coordinates a change killed, dropped or revived.
//
// Pure. A change at P rewrites the part of the tree `planSubtreeEffect` names.
// Within that scope a coordinate lives exactly while it still exists, so the
// plan walks the scope parents first and asks existence of each coordinate
// under a live parent; under a dead one, everything dies.
//
// What a death keeps is decided by whether the coordinate can come back:
//
// - A list item is dropped. A rewrite leaves it no correspondence, and its
//   identity is its address, which nothing can name again.
// - A tree node is dropped. Its id is minted once and never reused.
// - A field or map entry is kept, dead, with its address and carrier. A
//   product field's carrier is memoized in its parent's carrier, not in the
//   trie, so a revived parent hands the old field carrier back; its address
//   has to be there, dead, to revive with it. A map key carries identity by
//   its string, and revives the same way.

import type { AddressedPath, Segment } from "./path.js"
import { KIND, type Schema as SchemaNode } from "./schema.js"

/** A coordinate in a change's scope, as the trie records it. */
export interface RegisteredCoordinate {
  readonly path: AddressedPath
  /** The segment naming it under its parent (`path`'s last). */
  readonly segment: Segment
  /** The schema recorded on it, if it was ever interpreted. */
  readonly schema: SchemaNode | undefined
  readonly dead: boolean
}

/** The coordinate a change is at: the parent of its scope's top level. */
export interface ScopeRoot {
  readonly path: AddressedPath
  readonly schema: SchemaNode | undefined
  readonly dead: boolean
}

export interface AddressFates {
  /** Field and map-entry coordinates that no longer exist: kept, dead, their
   *  read cleared. */
  readonly die: readonly AddressedPath[]
  /** List items and tree nodes that no longer exist: unlinked with
   *  everything below them. */
  readonly drop: readonly AddressedPath[]
  /** Dead field and map-entry coordinates that exist again. */
  readonly revive: readonly AddressedPath[]
  /** Live coordinates whose schema changed kind: their kind-specific state
   *  (list table, read) is stale, and everything below them died. */
  readonly rekind: readonly AddressedPath[]
  /** Each live coordinate's schema, derived from its parent's. */
  readonly schemas: ReadonlyMap<AddressedPath, SchemaNode>
}

/**
 * Decide the fate of every coordinate in a change's scope.
 *
 * @param root - The coordinate the change is at.
 * @param scope - The coordinates it may have rewritten, parents before
 *   children (`CoordinateTrie.within`).
 * @param exists - Whether a segment exists under a live parent now.
 * @param resolveSchema - A live child's schema, from its parent's.
 */
export function planAddressFates(
  root: ScopeRoot,
  scope: readonly RegisteredCoordinate[],
  exists: (
    parentSchema: SchemaNode,
    parentPath: AddressedPath,
    segment: Segment,
  ) => boolean,
  resolveSchema: (
    parentSchema: SchemaNode,
    parentPath: AddressedPath,
    segment: Segment,
  ) => SchemaNode | undefined,
): AddressFates {
  const die: AddressedPath[] = []
  const drop: AddressedPath[] = []
  const revive: AddressedPath[] = []
  const rekind: AddressedPath[] = []
  const schemas = new Map<AddressedPath, SchemaNode>()

  /** What the walk knows of each coordinate it has passed, by path key. A
   *  dropped coordinate is absent: its subtree goes with it. */
  const seen = new Map<
    string,
    { readonly live: boolean; readonly schema: SchemaNode | undefined }
  >()
  seen.set(root.path.key, { live: !root.dead, schema: root.schema })

  for (const coordinate of scope) {
    const parentPath = coordinate.path.slice(0, -1)
    const parent = seen.get(parentPath.key)
    // Below a dropped coordinate: the drop takes it.
    if (parent === undefined) continue

    const droppable =
      coordinate.segment.role === "index" ||
      (coordinate.segment.role === "entry" && isTree(parent.schema))
    const derived =
      parent.live && parent.schema !== undefined
        ? resolveSchema(parent.schema, parentPath, coordinate.segment)
        : undefined
    const live =
      parent.live &&
      parent.schema !== undefined &&
      coordinate.segment.role !== "index" &&
      exists(parent.schema, parentPath, coordinate.segment)

    if (!live) {
      if (droppable) {
        drop.push(coordinate.path)
      } else {
        die.push(coordinate.path)
        seen.set(coordinate.path.key, {
          live: false,
          schema: coordinate.schema,
        })
      }
      continue
    }

    if (coordinate.dead) revive.push(coordinate.path)
    const schema = derived ?? coordinate.schema
    if (derived !== undefined) schemas.set(coordinate.path, derived)
    const changedKind =
      derived !== undefined &&
      coordinate.schema !== undefined &&
      derived[KIND] !== coordinate.schema[KIND]
    if (changedKind) rekind.push(coordinate.path)
    // A coordinate that changed kind keeps its identity, but nothing below it
    // corresponds to anything any more.
    seen.set(coordinate.path.key, { live: !changedKind, schema })
  }

  return { die, drop, revive, rekind, schemas }
}

/** Whether a coordinate with this schema holds tree nodes, in any variant. */
function isTree(schema: SchemaNode | undefined): boolean {
  if (schema === undefined) return false
  if (schema[KIND] === "tree") return true
  if (schema[KIND] === "sum") {
    const variants =
      "variantMap" in schema
        ? Object.values(schema.variantMap as Record<string, SchemaNode>)
        : (schema as { readonly variants: readonly SchemaNode[] }).variants
    return variants.some(isTree)
  }
  return false
}
