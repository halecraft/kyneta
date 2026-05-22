// materialize — Loro→PlainState materialization via generic resolver.
//
// Implements `createLoroResolver`, a closure-based `MaterializeResolver`
// that navigates the Loro container tree via `resolveContainer`. The
// generic `createMaterializeInterpreter` drives the catamorphism; the
// resolver handles only the CRDT-specific value extraction.
//
// Zero fallback for missing values (e.g. nested nullable fields on a
// fresh doc) is handled canonically by the generic interpreter — not
// inlined here.

import type {
  FlatTreeNodeTopology,
  MaterializeResolver,
  Path,
  PlainState,
  RichTextDelta,
  SchemaBinding,
  Schema as SchemaNode,
} from "@kyneta/schema"
import {
  createMaterializeInterpreter,
  interpret,
  isNonNullObject,
  materializeContextFromResolver,
} from "@kyneta/schema"
import type { Delta, LoroDoc } from "loro-crdt"
import { extractValue, loroDeltaToRichTextDelta } from "./loro-extract.js"
import { hasKind } from "./loro-guards.js"
import { resolveContainer } from "./loro-resolve.js"

// ---------------------------------------------------------------------------
// Loro resolver
// ---------------------------------------------------------------------------

function createLoroResolver(
  doc: LoroDoc,
  rootSchema: SchemaNode,
  binding?: SchemaBinding,
): MaterializeResolver {
  return {
    resolveValue(path: Path): unknown {
      const { resolved } = resolveContainer(doc, rootSchema, path, binding)
      return extractValue(resolved)
    },

    resolveText(path: Path): string | undefined {
      const { resolved } = resolveContainer(doc, rootSchema, path, binding)
      if (hasKind(resolved) && resolved.kind() === "Text") {
        return (resolved as any).toString() as string
      }
      const value = extractValue(resolved)
      return typeof value === "string" ? value : undefined
    },

    resolveCounter(path: Path): number | undefined {
      const { resolved } = resolveContainer(doc, rootSchema, path, binding)
      if (hasKind(resolved) && resolved.kind() === "Counter") {
        return (resolved as any).value as number
      }
      const value = extractValue(resolved)
      return typeof value === "number" ? value : undefined
    },

    resolveRichText(path: Path): RichTextDelta | undefined {
      const { resolved } = resolveContainer(doc, rootSchema, path, binding)
      if (hasKind(resolved) && resolved.kind() === "Text") {
        const deltas = (resolved as any).toDelta() as Delta<string>[]
        return loroDeltaToRichTextDelta(deltas)
      }
      return undefined
    },

    resolveLength(path: Path): number {
      const { resolved } = resolveContainer(doc, rootSchema, path, binding)
      if (!hasKind(resolved)) {
        return Array.isArray(resolved) ? resolved.length : 0
      }
      const kind = resolved.kind()
      if (kind === "List" || kind === "MovableList") {
        return (resolved as any).length as number
      }
      return 0
    },

    resolveKeys(path: Path): string[] {
      const { resolved } = resolveContainer(doc, rootSchema, path, binding)
      if (!hasKind(resolved)) {
        return isNonNullObject(resolved) ? Object.keys(resolved) : []
      }
      if (resolved.kind() === "Map") {
        return (resolved as any).keys() as string[]
      }
      return []
    },

    resolveForest(path: Path): readonly FlatTreeNodeTopology[] {
      const { resolved } = resolveContainer(doc, rootSchema, path, binding)
      if (!hasKind(resolved) || resolved.kind() !== "Tree") return []
      // LoroTree.toArray() returns a NESTED `TreeNodeValue[]` (roots at
      // top, descendants under `.children`). The kyneta topology contract
      // is flat — walk depth-first and emit each node with its parent
      // link so `forestTopology` consumers (materializer, tree-helpers
      // navigation) see every node.
      type NestedRow = {
        id: string
        parent: string | null | undefined
        index: number
        children?: NestedRow[]
      }
      const flat: FlatTreeNodeTopology[] = []
      const walk = (rows: NestedRow[], parent: string | null): void => {
        for (const row of rows) {
          flat.push({
            id: row.id,
            parent: row.parent ?? parent,
            index: row.index,
          })
          if (row.children?.length) walk(row.children, row.id)
        }
      }
      walk((resolved as any).toArray() as NestedRow[], null)
      return flat
    },
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function materializeLoroShadow(
  doc: LoroDoc,
  schema: SchemaNode,
  binding?: SchemaBinding,
): PlainState {
  const resolver = createLoroResolver(doc, schema, binding)
  const interp = createMaterializeInterpreter(resolver)
  const ctx = materializeContextFromResolver(resolver)
  const result = interpret(schema, interp, ctx)
  return result as PlainState
}
