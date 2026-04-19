// yjs-resolve — Yjs-specific path resolution.
//
// Implements stepIntoYjs and resolveYjsType for schema-guided
// navigation of the Yjs shared type tree.
//
// resolveYjsType is a left-fold over path segments, accumulating
// (currentType, currentSchema) at each step. This mirrors how
// resolveContainer works for Loro — but uses `instanceof` for
// runtime type discrimination instead of Loro's `.kind()` method.
//
// Root container strategy: All schema fields are children of a single
// root `Y.Map` obtained via `doc.getMap("root")`. This root map holds
// shared types (Y.Text, Y.Array, Y.Map) and plain values uniformly.
// Using a single root Y.Map enables one `observeDeep` call that
// captures all mutations with correct relative paths.
//
// Identity-keying: when a SchemaBinding is provided, every product-field
// boundary uses the identity hash (from binding.forward) instead of the
// field name as the Y.Map key. The binding is threaded through
// resolveYjsType and stepIntoYjs.

import type {
  Path,
  SchemaBinding,
  Schema as SchemaNode,
  Segment,
} from "@kyneta/schema"
import { advanceSchema } from "@kyneta/schema"
import * as Y from "yjs"

// ---------------------------------------------------------------------------
// stepIntoYjs — single step of the fold
// ---------------------------------------------------------------------------

/**
 * Navigate one step deeper into the Yjs shared type tree.
 *
 * Uses `instanceof` for runtime type discrimination:
 * - `Y.Map` → `.get(key)` — uses the identity hash when provided
 * - `Y.Array` → `.get(index)`
 * - `Y.Text` → terminal (cannot step further)
 * - Plain value → terminal (return `undefined`)
 *
 * @param current - The current position (a Yjs shared type or plain value)
 * @param segment - The path segment to follow
 * @param identity - Optional identity hash to use instead of the segment's resolved value
 */
export function stepIntoYjs(
  current: unknown,
  segment: Segment,
  identity?: string,
): unknown {
  const resolved = segment.resolve()

  if (current instanceof Y.Map) {
    return current.get(identity ?? (resolved as string))
  }

  if (current instanceof Y.Array) {
    return current.get(resolved as number)
  }

  if (current instanceof Y.Text) {
    throw new Error(`yjs-resolve: cannot step into Y.Text`)
  }

  // Plain value — terminal, cannot step further
  return undefined
}

// ---------------------------------------------------------------------------
// resolveYjsType — full path resolution via left-fold
// ---------------------------------------------------------------------------

/**
 * Result of resolving a Yjs shared type at a path.
 *
 * Includes both the resolved Yjs value and the schema at that position,
 * enabling callers to distinguish between schema kinds that map to the
 * same Yjs type (e.g. "text" vs "richtext" both use Y.Text).
 */
export interface ResolvedYjs {
  readonly resolved: unknown
  readonly schema: SchemaNode
}

/**
 * Resolve a Yjs shared type (or plain value) at the given path.
 *
 * Left-folds over path segments using `advanceSchema` for pure schema
 * descent and `stepIntoYjs` for Yjs-specific navigation.
 *
 * When a `binding` is provided, each step computes the absolute schema
 * path and looks up the identity hash from `binding.forward`. This
 * identity hash is used instead of the field name at every product-field
 * boundary (root and nested).
 *
 * Returns both the Yjs shared type (or plain value) and the schema at
 * the terminal position. For an empty path, returns the root map and
 * root schema.
 *
 * @param rootMap - The root `Y.Map` obtained via `doc.getMap("root")`
 * @param rootSchema - The root document schema
 * @param path - The path to resolve
 * @param binding - Optional SchemaBinding for identity-keyed navigation.
 */
export function resolveYjsType(
  rootMap: Y.Map<any>,
  rootSchema: SchemaNode,
  path: Path,
  binding?: SchemaBinding,
): ResolvedYjs {
  let current: unknown = rootMap
  let schema = rootSchema
  // Track the accumulated absolute schema path for identity lookup.
  // Only string (key) segments contribute — index segments are structural
  // and don't participate in identity-keying.
  let absPath = ""

  for (let i = 0; i < path.length; i++) {
    const seg = path.segments[i]
    if (!seg) throw new Error(`Missing segment at index ${i}`)
    const nextSchema = advanceSchema(schema, seg)

    // Compute identity for this step if binding is provided and the
    // segment is a key (field name at a product boundary).
    let identity: string | undefined
    if (binding && seg.role === "key") {
      const segStr = seg.resolve() as string
      absPath = absPath ? `${absPath}.${segStr}` : segStr
      identity = binding.forward.get(absPath) as string | undefined
    }

    current = stepIntoYjs(current, seg, identity)
    schema = nextSchema
  }

  return { resolved: current, schema }
}
