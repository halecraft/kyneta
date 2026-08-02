// materialize-value — schema-guided unfold of a plain value into a
// backend-agnostic container-shape tree (the write-side counterpart to
// `fold-path.ts`).
//
// `foldPath` (fold-path.ts) navigates an existing container tree by a path,
// owning the identity-keying rule in exactly one place. `materializeValue` is
// its dual on the write side: given (schema, plain value, binding) it builds a
// pure `MaterializedNode` tree with every product-field boundary already keyed
// by its identity hash. Backends turn that IR into native form via a thin
// realizer (`realizeYjs`, `realizeLoro`) — they never compute a container key
// or read `binding` themselves. This is what makes writer and reader keys
// agree by construction.
//
// Inverse direction to `createMaterializeInterpreter` (interpreters/
// materialize.ts), which reads a container tree back into a plain value.
//
// Purity: `materializeValue` allocates no substrate handles and no synthetic
// ContainerIDs — it is a pure function of its inputs. All effectful realization
// (Y.Map construction, Loro synthetic-CID allocation) lives in the per-backend
// realizers, which is what makes the IR unit-testable without a substrate.

import { extendSchemaPathKey } from "./fold-path.js"
import type { SchemaBinding } from "./migration.js"
import type { Segment } from "./path.js"
import {
  isJsonBoundary,
  KIND,
  type MapSchema,
  type MovableSequenceSchema,
  type ProductSchema,
  type Schema as SchemaNode,
  type SequenceSchema,
  storageClass,
  structuralKind,
} from "./schema.js"

// ---------------------------------------------------------------------------
// The container-shape IR
// ---------------------------------------------------------------------------

/**
 * Backend-agnostic materialized value. Keys in `map` entries are FINAL —
 * product-field boundaries are already identity-hashed, map/set entries carry
 * their runtime key. A realizer walks this tree and builds native containers;
 * it does not re-key.
 */
export type MaterializedNode =
  | { readonly kind: "plain"; readonly value: unknown } // scalar | sum | json-boundary | tree
  | { readonly kind: "text"; readonly content: string }
  | { readonly kind: "richtext"; readonly value: unknown } // string | RichTextDelta
  | { readonly kind: "counter"; readonly amount: number }
  | {
      readonly kind: "map"
      readonly entries: ReadonlyArray<readonly [key: string, MaterializedNode]>
    }
  | {
      readonly kind: "list"
      // `movable` distinguishes `Schema.movableList` from `Schema.list` so a
      // realizer can pick the right container (Loro `MovableList` vs `List`).
      // A schema-level distinction, not a substrate leak; Yjs ignores it.
      readonly movable: boolean
      readonly items: readonly MaterializedNode[]
    }

/**
 * How aggressively to eager-create containers for schema-declared fields that
 * are ABSENT from the value being materialized. The two backends genuinely
 * differ (a flip to a single policy fails the Loro suite):
 *
 * - `"leaf-containers"` (Yjs) — only first-class leaf containers
 *   (`text`/`richtext`), which need a stable container for later mutation.
 * - `"all-containers"` (Loro) — also pre-create absent structural containers
 *   (nested `product`/`map`/`sequence`); Loro requires the container to exist
 *   before a nested write can land on it.
 */
export type EagerPolicy = "leaf-containers" | "all-containers"

// ---------------------------------------------------------------------------
// needsContainer — the single container-vs-leaf predicate
// ---------------------------------------------------------------------------

/**
 * Whether a schema position is stored as its own CRDT container (vs. a plain
 * value in the parent). The one predicate shared by both backends' insert
 * detection and the `"all-containers"` eager policy.
 *
 * This is the write-side view of `storageClass` (`schema.ts`), which is where
 * the decision itself lives and where the per-kind reasoning is written down —
 * including why `richtext` counts as a container despite reading like a leaf.
 * The walk-side view is `isOpaqueBoundary`, asking the same classification a
 * different question.
 */
export function needsContainer(schema: SchemaNode): boolean {
  return storageClass(schema) === "container"
}

// ---------------------------------------------------------------------------
// containerKey / fieldAbsPath — the single key producer
// ---------------------------------------------------------------------------

/**
 * The identity hash for an absolute schema path, or `fallback` (the display
 * name) when no binding maps it. The sole producer of product-field container
 * keys — the reader (`foldPath`) and the binding-builder
 * (`deriveBindingRecursive`) agree on the same `forward` key space.
 */
export function containerKey(
  binding: SchemaBinding | undefined,
  absPath: string,
  fallback: string,
): string {
  const identity = binding?.forward.get(absPath) as string | undefined
  return identity ?? fallback
}

/**
 * The dotted absolute schema path of a segment list, accumulated from
 * `field`-role segments only — `entry`/`index` segments never contribute.
 * This is exactly the accumulation `foldPath` performs while navigating, so a
 * value built here keys under the same paths the reader resolves.
 */
export function fieldAbsPath(segments: readonly Segment[]): string {
  let absPath = ""
  for (const seg of segments) {
    if (seg.role === "field") {
      absPath = extendSchemaPathKey(absPath, seg.resolve() as string)
    }
  }
  return absPath
}

// ---------------------------------------------------------------------------
// materializeValue — the unfold
// ---------------------------------------------------------------------------

/**
 * Build the `MaterializedNode` tree for a plain `value` at schema position
 * `schema`, whose own absolute field path is `prefix`.
 *
 * `prefix` is the field-only abs-path of the container being built (e.g.
 * `"conversationPolicy"`). A product child at field `f` is keyed by
 * `containerKey(binding, extendSchemaPathKey(prefix, f), f)` and recurses with
 * that extended prefix. Map/set entries and list items keep `prefix`
 * unchanged (their key/index is not a field boundary) — matching `foldPath`.
 */
export function materializeValue(
  schema: SchemaNode,
  value: unknown,
  binding: SchemaBinding | undefined,
  prefix: string,
  policy: EagerPolicy,
): MaterializedNode {
  // This switch dispatches on kind rather than delegating to `storageClass`,
  // because it does more than classify — it builds a differently shaped node
  // for each kind, so routing through the classification would add a lookup
  // without removing a decision.
  //
  // It does have to stay consistent with it. The branches that produce a
  // `{kind: "plain"}` node — the JSON boundary here, and `sum` below — are the
  // same two shapes `storageClass` calls `opaque-composite`. If the two ever
  // look like they disagree, `storageClass` is the definition and this is the
  // copy that has drifted.
  if (isJsonBoundary(schema)) return { kind: "plain", value }

  switch (schema[KIND]) {
    case "text":
      return { kind: "text", content: typeof value === "string" ? value : "" }
    case "richtext":
      // The default is what makes the eager path work. When a whole-value
      // write omits this field, the node built here is all the backend gets to
      // create an empty container from — and it cannot build one out of
      // `undefined`, so the container never appears and the next write into it
      // fails. `[]` is `Zero.structural` for a rich-text node, matching how
      // `text` and `counter` fill an absent value on either side of this case.
      return { kind: "richtext", value: value ?? [] }
    case "counter":
      return { kind: "counter", amount: typeof value === "number" ? value : 0 }
    case "tree":
      // Trees mutate via TreeChange, never a whole-value replace — no
      // container is materialized from a plain value here.
      return { kind: "plain", value }
  }

  switch (structuralKind(schema)) {
    case "product":
      return materializeProduct(
        schema as ProductSchema,
        value,
        binding,
        prefix,
        policy,
      )
    case "map":
      // map + set (value-addressed) — runtime keys, no identity.
      return materializeMap(schema as MapSchema, value, binding, prefix, policy)
    case "sequence":
      // sequence + movable — positional items.
      return materializeList(
        schema as SequenceSchema | MovableSequenceSchema,
        value,
        binding,
        prefix,
        policy,
      )
    default:
      // scalar, sum
      return { kind: "plain", value }
  }
}

function materializeProduct(
  schema: ProductSchema,
  value: unknown,
  binding: SchemaBinding | undefined,
  prefix: string,
  policy: EagerPolicy,
): MaterializedNode {
  const obj =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const entries: Array<readonly [string, MaterializedNode]> = []

  // Fields present in the value object (skip explicit undefined).
  for (const [field, fieldValue] of Object.entries(obj)) {
    if (fieldValue === undefined) continue
    const fieldSchema = schema.fields[field]
    if (!fieldSchema) continue
    const childPrefix = extendSchemaPathKey(prefix, field)
    const key = containerKey(binding, childPrefix, field)
    entries.push([
      key,
      materializeValue(fieldSchema, fieldValue, binding, childPrefix, policy),
    ])
  }

  // Eager containers for declared-but-absent fields (per policy). This keeps
  // CRDT containers present for later leaf/increment mutation.
  for (const [field, fieldSchema] of Object.entries(schema.fields)) {
    if (field in obj) continue
    if (!shouldEager(fieldSchema as SchemaNode, policy)) continue
    const childPrefix = extendSchemaPathKey(prefix, field)
    const key = containerKey(binding, childPrefix, field)
    entries.push([
      key,
      materializeValue(
        fieldSchema as SchemaNode,
        undefined,
        binding,
        childPrefix,
        policy,
      ),
    ])
  }

  return { kind: "map", entries }
}

function materializeMap(
  schema: MapSchema,
  value: unknown,
  binding: SchemaBinding | undefined,
  prefix: string,
  policy: EagerPolicy,
): MaterializedNode {
  const obj =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const itemSchema = schema.item as SchemaNode | undefined
  const entries: Array<readonly [string, MaterializedNode]> = []

  for (const [key, entryValue] of Object.entries(obj)) {
    // Entry keys are runtime, not identity-keyed; `prefix` is unchanged (an
    // entry segment is not a field boundary). A struct VALUE under the entry
    // still identity-keys its own fields, extending from `prefix`.
    const child = itemSchema
      ? materializeValue(itemSchema, entryValue, binding, prefix, policy)
      : ({ kind: "plain", value: entryValue } as const)
    entries.push([key, child])
  }

  return { kind: "map", entries }
}

function materializeList(
  // Both `sequence` and `movable` land here (they share `structuralKind`),
  // so the union is needed to read `[KIND]` for the `movable` flag below.
  schema: SequenceSchema | MovableSequenceSchema,
  value: unknown,
  binding: SchemaBinding | undefined,
  prefix: string,
  policy: EagerPolicy,
): MaterializedNode {
  const arr = Array.isArray(value) ? value : []
  const itemSchema = schema.item as SchemaNode | undefined
  const items = arr.map(item =>
    itemSchema
      ? materializeValue(itemSchema, item, binding, prefix, policy)
      : ({ kind: "plain", value: item } as const),
  )
  return { kind: "list", movable: schema[KIND] === "movable", items }
}

function shouldEager(schema: SchemaNode, policy: EagerPolicy): boolean {
  if (isJsonBoundary(schema)) return false
  if (policy === "all-containers") return needsContainer(schema)
  // "leaf-containers": only first-class leaf containers.
  return schema[KIND] === "text" || schema[KIND] === "richtext"
}
