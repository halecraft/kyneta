// materialize — Yjs→PlainState materialization via generic resolver.
//
// Implements `createYjsResolver`, a closure-based `MaterializeResolver`
// that navigates the Yjs shared type tree via `resolveYjsType`. The
// generic `createMaterializeInterpreter` drives the catamorphism; the
// resolver handles only the CRDT-specific value extraction.
//
// Unsupported types (counter, tree, movable) return `undefined` from
// the resolver, triggering the generic interpreter's zero fallback.
//
// Zero fallback for missing values is handled canonically by the
// generic interpreter — not inlined here.

import type {
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
import * as Y from "yjs"
import { extractValue, yTextToRichTextDelta } from "./yjs-extract.js"
import { resolveYjsType } from "./yjs-resolve.js"

// ---------------------------------------------------------------------------
// Yjs resolver
// ---------------------------------------------------------------------------

function createYjsResolver(
  rootMap: Y.Map<any>,
  rootSchema: SchemaNode,
  binding?: SchemaBinding,
): MaterializeResolver {
  return {
    resolveValue(path: Path): unknown {
      const result = resolveYjsType(rootMap, rootSchema, path, binding)
      return extractValue(result.resolved)
    },

    resolveText(path: Path): string | undefined {
      const { resolved } = resolveYjsType(rootMap, rootSchema, path, binding)
      if (resolved instanceof Y.Text) {
        return resolved.toJSON()
      }
      return plainResolution.text(extractValue(resolved))
    },

    // Yjs does not support counters — schemas with counter types are
    // rejected at bind time. Return undefined to trigger zero fallback.
    resolveCounter(_path: Path): number | undefined {
      return undefined
    },

    resolveRichText(path: Path): RichTextDelta | undefined {
      const { resolved } = resolveYjsType(rootMap, rootSchema, path, binding)
      if (resolved instanceof Y.Text) {
        return yTextToRichTextDelta(resolved)
      }
      return undefined
    },

    resolveLength(path: Path): number {
      const { resolved } = resolveYjsType(rootMap, rootSchema, path, binding)
      if (resolved instanceof Y.Array) {
        return resolved.length
      }
      return plainResolution.length(resolved)
    },

    resolveKeys(path: Path): string[] {
      const { resolved } = resolveYjsType(rootMap, rootSchema, path, binding)
      if (resolved instanceof Y.Map) {
        return Array.from(resolved.keys())
      }
      return plainResolution.keys(resolved)
    },

    // Yjs has no tree primitive — schemas with `Schema.tree` are rejected
    // at bind time. Defensive [] for any caller that reaches here.
    resolveForest(_path: Path): readonly never[] {
      return []
    },
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function materializeYjsShadow(
  doc: Y.Doc,
  schema: SchemaNode,
  binding?: SchemaBinding,
): PlainState {
  const rootMap = doc.getMap("root")
  const resolver = createYjsResolver(rootMap, schema, binding)
  const interp = createMaterializeInterpreter(resolver)
  const ctx = materializeContextFromResolver(resolver)
  const result = interpret(schema, interp, ctx)
  return result as PlainState
}
