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
  materializeContextFromResolver,
  plainResolution,
} from "@kyneta/schema"
import type { Delta, LoroDoc } from "loro-crdt"
import { extractValue, loroDeltaToRichTextDelta } from "./loro-extract.js"
import {
  hasKind,
  isLoroCounter,
  isLoroList,
  isLoroMap,
  isLoroText,
  isLoroTree,
} from "./loro-guards.js"
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
        return resolved.toString() as string
      }
      return plainResolution.text(extractValue(resolved))
    },

    resolveCounter(path: Path): number | undefined {
      const { resolved } = resolveContainer(doc, rootSchema, path, binding)
      if (isLoroCounter(resolved)) {
        return resolved.value
      }
      return plainResolution.counter(extractValue(resolved))
    },

    resolveRichText(path: Path): RichTextDelta | undefined {
      const { resolved } = resolveContainer(doc, rootSchema, path, binding)
      if (isLoroText(resolved)) {
        return loroDeltaToRichTextDelta(resolved.toDelta() as Delta<string>[])
      }
      return undefined
    },

    resolveLength(path: Path): number {
      const { resolved } = resolveContainer(doc, rootSchema, path, binding)
      if (isLoroList(resolved)) return resolved.length
      if (hasKind(resolved)) return 0
      return plainResolution.length(resolved)
    },

    resolveKeys(path: Path): string[] {
      const { resolved } = resolveContainer(doc, rootSchema, path, binding)
      if (isLoroMap(resolved)) return resolved.keys()
      if (hasKind(resolved)) return []
      return plainResolution.keys(resolved)
    },

    resolveForest(path: Path): readonly FlatTreeNodeTopology[] {
      const { resolved } = resolveContainer(doc, rootSchema, path, binding)
      if (!isLoroTree(resolved)) return []
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
      walk(resolved.toArray() as NestedRow[], null)
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
