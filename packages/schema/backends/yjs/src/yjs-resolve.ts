// yjs-resolve — Yjs-specific path resolution.
//
// `stepIntoYjs` is the per-step substrate dispatch; `resolveYjsType`
// applies the core `foldPath` primitive (from `@kyneta/schema`) around
// it. The semantic invariants of the fold — identity-keying at
// product-field boundaries, sum-boundary short-circuit — live in
// `fold-path.ts`, not here.
//
// Root container strategy: All schema fields are children of a single
// root `Y.Map` obtained via `doc.getMap("root")`. This root map holds
// shared types (Y.Text, Y.Array, Y.Map) and plain values uniformly.
// Using a single root Y.Map enables one `observeDeep` call that
// captures all mutations with correct relative paths.

import {
  foldPath,
  type Path,
  type PathFoldResult,
  type PathStepper,
  type SchemaBinding,
  type Schema as SchemaNode,
} from "@kyneta/schema"
import * as Y from "yjs"

// ---------------------------------------------------------------------------
// stepIntoYjs — per-step substrate dispatch (PathStepper for Yjs)
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
 * `_nextSchema` is part of the `PathStepper` contract for Loro's root
 * dispatch but is unused here — Yjs's `instanceof` dispatch doesn't
 * need to look ahead at the next schema kind.
 */
export const stepIntoYjs: PathStepper = (
  current,
  _nextSchema,
  segment,
  identity,
) => {
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
// resolveYjsType — full path resolution via foldPath
// ---------------------------------------------------------------------------

/**
 * Resolve a Yjs shared type (or plain value) at the given path.
 *
 * Thin wrapper around `foldPath(stepIntoYjs, ...)`. Returns the
 * `PathFoldResult` shape from core — `{ resolved, schema }`.
 *
 * When a `binding` is provided, every product-field boundary uses the
 * identity hash from `binding.forward` instead of the field name.
 *
 * For an empty path, returns the root map and root schema.
 */
export function resolveYjsType(
  rootMap: Y.Map<any>,
  rootSchema: SchemaNode,
  path: Path,
  binding?: SchemaBinding,
): PathFoldResult {
  return foldPath(rootMap, rootSchema, path, stepIntoYjs, binding)
}
