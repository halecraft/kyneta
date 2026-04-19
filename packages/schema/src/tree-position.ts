// tree-position — flat↔tree position mapping for editor bindings.
//
// Rich text editors (ProseMirror, CodeMirror, Slate, Lexical) address
// positions in a document tree using a single flat integer. This module
// provides pure functions that convert between flat integers and kyneta's
// (path, offset) pairs in the schema tree.
//
// The counting convention follows ProseMirror (the de facto standard):
//
//   - text node:           1 per character (no open/close boundaries)
//   - non-text leaf:       1 (scalar, counter)
//   - composite node:      2 (open + close) + content size
//
// Example: <doc><p>Hi</p><blockquote><p>Q</p></blockquote></doc>
//
//   pos=0  entering doc content
//   pos=1  entering <p> (+1 open)
//   pos=2  character H
//   pos=3  character i
//   pos=4  leaving </p> (+1 close), entering <blockquote> boundary
//   pos=5  entering <blockquote> (+1 open)
//   pos=6  entering <p> (+1 open)
//   pos=7  character Q
//   pos=8  leaving </p> (+1 close)
//   pos=9  leaving </blockquote> (+1 close)
//
// Flat positions are relative to the root's *content* (no root open/close),
// matching PM's doc.resolve(pos) semantics.
//
// Context: jj:oxwyqyvx

import type { Path } from "./path.js"
import { RawPath } from "./path.js"
import type { Reader } from "./reader.js"
import {
  type DiscriminatedSumSchema,
  KIND,
  type PositionalSumSchema,
  type Schema as SchemaNode,
  type SumSchema,
} from "./schema.js"
import { dispatchSum } from "./interpret.js"

// ---------------------------------------------------------------------------
// isLeaf — PM-specific leaf/composite distinction
// ---------------------------------------------------------------------------

/**
 * PM-specific leaf classification. Text, scalar, and counter have no
 * open/close boundaries — they differ from the structural `isLeaf`
 * notion where text is indexable.
 */
export function isLeaf(schema: SchemaNode): boolean {
  const k = schema[KIND]
  return k === "text" || k === "scalar" || k === "counter" || k === "richtext"
}

// ---------------------------------------------------------------------------
// nodeSize — flat position size of a schema node
// ---------------------------------------------------------------------------

/**
 * Flat position size of a schema node (ProseMirror convention).
 *
 * Product fields walk in `Object.keys()` insertion order — this is
 * semantically significant because all peers must agree on child ordering
 * for positions to be consistent. Map keys are sorted lexicographically
 * because `reader.keys()` insertion order varies across peers.
 */
export function nodeSize(
  reader: Reader,
  schema: SchemaNode,
  path: Path,
): number {
  switch (schema[KIND]) {
    // --- Leaves (no open/close) -------------------------------------------

    case "text": {
      const value = reader.read(path)
      return typeof value === "string" ? value.length : 0
    }

    case "scalar":
      return 1

    case "counter":
      return 1

    // --- Composites (2 + content) -----------------------------------------

    case "product": {
      let size = 2 // open + close
      for (const key of Object.keys(schema.fields)) {
        size += nodeSize(reader, schema.fields[key]!, path.field(key))
      }
      return size
    }

    case "sequence": {
      let size = 2 // open + close
      const len = reader.arrayLength(path)
      for (let i = 0; i < len; i++) {
        size += nodeSize(reader, schema.item, path.item(i))
      }
      return size
    }

    case "movable": {
      let size = 2 // open + close
      const len = reader.arrayLength(path)
      for (let i = 0; i < len; i++) {
        size += nodeSize(reader, schema.item, path.item(i))
      }
      return size
    }

    case "map": {
      let size = 2 // open + close
      const keys = reader.keys(path).slice().sort()
      for (const key of keys) {
        size += nodeSize(reader, schema.item, path.field(key))
      }
      return size
    }

    // --- Sum (transparent — active variant only) --------------------------

    case "sum": {
      const value = reader.read(path)
      const sumSchema = schema as SumSchema
      const result = dispatchSum(value, sumSchema, {
        byKey: (key: string) => {
          const disc = sumSchema as DiscriminatedSumSchema
          return nodeSize(reader, disc.variantMap[key]!, path)
        },
        byIndex: (index: number) => {
          const pos = sumSchema as PositionalSumSchema
          return nodeSize(reader, pos.variants[index]!, path)
        },
      })
      return result ?? 0
    }

    // --- Unsupported CRDT types -------------------------------------------

    case "set":
      throw new Error(
        "nodeSize: `set` schema kind is not supported for tree-position mapping. " +
          "Sets have no stable child ordering for flat position computation. " +
          "See tree-position.ts for details.",
      )

    case "tree":
      throw new Error(
        "nodeSize: `tree` schema kind is not supported for tree-position mapping. " +
          "Trees have move semantics that break the static depth-first walk assumption. " +
          "See tree-position.ts for details.",
      )

    case "richtext": {
      const value = reader.read(path)
      if (!Array.isArray(value)) return 0
      return (value as Array<{ text: string }>).reduce(
        (sum, span) => sum + span.text.length,
        0,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// contentSize — nodeSize minus open/close for composites
// ---------------------------------------------------------------------------

/**
 * Size of a node's content — what the public API operates on.
 * PM positions are relative to the root's content, not including
 * its own open/close, so the public functions enter through this.
 */
export function contentSize(
  reader: Reader,
  schema: SchemaNode,
  path: Path,
): number {
  const size = nodeSize(reader, schema, path)
  return isLeaf(schema) ? size : size - 2
}

// ---------------------------------------------------------------------------
// ResolvedTreePosition — result of resolving a flat position
// ---------------------------------------------------------------------------

export interface ResolvedTreePosition {
  readonly path: Path
  readonly offset: number
  readonly schema: SchemaNode
}

// ---------------------------------------------------------------------------
// resolveTreePosition — Flat → (Path, Offset)
// ---------------------------------------------------------------------------

/**
 * Flat integer → `{ path, offset, schema }` at the innermost node.
 * Returns `null` if out of bounds.
 */
export function resolveTreePosition(
  reader: Reader,
  schema: SchemaNode,
  flatPos: number,
): ResolvedTreePosition | null {
  if (flatPos < 0) return null

  const rootPath = RawPath.empty
  const cs = contentSize(reader, schema, rootPath)
  if (flatPos > cs) return null

  return resolveInComposite(reader, schema, rootPath, flatPos)
}

/**
 * Core resolution loop. The three-way child dispatch is critical:
 *   - text: remaining <= childSize (end-of-text is a valid interior position)
 *   - composite: remaining < childSize (== means closing boundary, owned by parent)
 *   - non-text leaf: always skip (no interior positions)
 */
function resolveInComposite(
  reader: Reader,
  schema: SchemaNode,
  path: Path,
  remaining: number,
): ResolvedTreePosition {
  const children = getChildren(reader, schema, path)

  let childIndex = 0
  for (const child of children) {
    if (remaining === 0) {
      return { path, offset: childIndex, schema }
    }

    const childSize = nodeSize(reader, child.schema, child.path)

    if (child.schema[KIND] === "text" && remaining <= childSize) {
      return { path: child.path, offset: remaining, schema: child.schema }
    }

    if (!isLeaf(child.schema) && remaining < childSize) {
      return resolveInComposite(
        reader,
        child.schema,
        child.path,
        remaining - 1,
      )
    }

    remaining -= childSize
    childIndex++
  }

  return { path, offset: childIndex, schema }
}

// ---------------------------------------------------------------------------
// flattenTreePosition — (Path, Offset) → Flat
// ---------------------------------------------------------------------------

/**
 * `{ path, offset }` → flat integer. Inverse of `resolveTreePosition`.
 *
 * Round-trip invariant: `flatten(r, s, ...resolve(r, s, pos)) === pos`.
 */
export function flattenTreePosition(
  reader: Reader,
  schema: SchemaNode,
  path: Path,
  offset: number,
): number {
  if (path.length === 0) {
    // Root has no opening boundary — offset maps directly.
    if (isLeaf(schema)) {
      return offset
    }
    return flatOffsetInComposite(reader, schema, RawPath.empty, offset)
  }

  const segments = path.segments
  let flat = 0
  let currentSchema = schema
  let currentPath: Path = RawPath.empty

  for (let depth = 0; depth < segments.length; depth++) {
    const segment = segments[depth]!

    const children = getChildren(reader, currentSchema, currentPath)

    for (const child of children) {
      if (matchesSegment(child, segment)) {
        break
      }
      flat += nodeSize(reader, child.schema, child.path)
    }

    const childSchema = advanceToChild(currentSchema, segment)
    const childPath =
      segment.role === "key"
        ? currentPath.field(segment.resolve() as string)
        : currentPath.item(segment.resolve() as number)

    if (depth < segments.length - 1) {
      if (!isLeaf(childSchema)) {
        flat += 1
      }
    }

    currentSchema = childSchema
    currentPath = childPath
  }

  if (isLeaf(currentSchema)) {
    flat += offset
  } else {
    flat += 1 // opening boundary
    flat += flatOffsetInComposite(reader, currentSchema, currentPath, offset)
  }

  return flat
}

function flatOffsetInComposite(
  reader: Reader,
  schema: SchemaNode,
  path: Path,
  childOffset: number,
): number {
  const children = getChildren(reader, schema, path)
  let flat = 0
  let index = 0
  for (const child of children) {
    if (index >= childOffset) break
    flat += nodeSize(reader, child.schema, child.path)
    index++
  }
  return flat
}

// ---------------------------------------------------------------------------
// Internal helpers — child enumeration
// ---------------------------------------------------------------------------

interface ChildInfo {
  readonly schema: SchemaNode
  readonly path: Path
  readonly key?: string
  readonly index?: number
}

/**
 * Children in position-counting order. Map keys are sorted
 * lexicographically for cross-peer determinism.
 */
function getChildren(
  reader: Reader,
  schema: SchemaNode,
  path: Path,
): ChildInfo[] {
  switch (schema[KIND]) {
    case "product": {
      const result: ChildInfo[] = []
      for (const key of Object.keys(schema.fields)) {
        result.push({
          schema: schema.fields[key]!,
          path: path.field(key),
          key,
        })
      }
      return result
    }

    case "sequence": {
      const result: ChildInfo[] = []
      const len = reader.arrayLength(path)
      for (let i = 0; i < len; i++) {
        result.push({
          schema: schema.item,
          path: path.item(i),
          index: i,
        })
      }
      return result
    }

    case "movable": {
      const result: ChildInfo[] = []
      const len = reader.arrayLength(path)
      for (let i = 0; i < len; i++) {
        result.push({
          schema: schema.item,
          path: path.item(i),
          index: i,
        })
      }
      return result
    }

    case "map": {
      const result: ChildInfo[] = []
      const keys = reader.keys(path).slice().sort()
      for (const key of keys) {
        result.push({
          schema: schema.item,
          path: path.field(key),
          key,
        })
      }
      return result
    }

    case "sum": {
      const value = reader.read(path)
      const sumSchema = schema as SumSchema
      const result = dispatchSum<ChildInfo[]>(value, sumSchema, {
        byKey: (key: string) => {
          const disc = sumSchema as DiscriminatedSumSchema
          return getChildren(reader, disc.variantMap[key]!, path)
        },
        byIndex: (index: number) => {
          const pos = sumSchema as PositionalSumSchema
          return getChildren(reader, pos.variants[index]!, path)
        },
      })
      return result ?? []
    }

    // Leaves have no children
    case "text":
    case "scalar":
    case "counter":
    case "richtext":
      return []

    case "set":
      throw new Error(
        "getChildren: `set` schema kind is not supported for tree-position mapping.",
      )

    case "tree":
      throw new Error(
        "getChildren: `tree` schema kind is not supported for tree-position mapping.",
      )
  }
}

function matchesSegment(
  child: ChildInfo,
  segment: { role: string; resolve(): string | number },
): boolean {
  if (segment.role === "key" && child.key !== undefined) {
    return child.key === segment.resolve()
  }
  if (segment.role === "index" && child.index !== undefined) {
    return child.index === segment.resolve()
  }
  return false
}

/** Schema descent through a path segment. Sums are transparent —
 *  tries all variants since the reader is not available here. */
function advanceToChild(
  schema: SchemaNode,
  segment: { role: string; resolve(): string | number },
): SchemaNode {
  switch (schema[KIND]) {
    case "product": {
      const key = segment.resolve() as string
      const fieldSchema = schema.fields[key]
      if (!fieldSchema) {
        throw new Error(
          `advanceToChild: product has no field "${key}"`,
        )
      }
      return fieldSchema
    }

    case "sequence":
    case "movable":
      return schema.item

    case "map":
      return schema.item

    case "sum": {
      if (schema.discriminant !== undefined) {
        const disc = schema as DiscriminatedSumSchema
        for (const variant of Object.values(disc.variantMap)) {
          try {
            return advanceToChild(variant, segment)
          } catch {
            continue
          }
        }
      } else {
        const pos = schema as PositionalSumSchema
        for (const variant of pos.variants) {
          try {
            return advanceToChild(variant, segment)
          } catch {
            continue
          }
        }
      }
      throw new Error(
        `advanceToChild: no sum variant can accept segment "${segment.resolve()}"`,
      )
    }

    default:
      throw new Error(
        `advanceToChild: cannot advance into ${schema[KIND]}`,
      )
  }
}