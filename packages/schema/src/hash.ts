// hash — deterministic schema fingerprinting and FNV-1a hashing.
//
// Extracted from substrate.ts so that migration.ts can depend on
// hashing without importing the full substrate interface surface.
//
// Implementation routes through `@sindresorhus/fnv1a` (single-pass,
// bigint-native, true 128-bit FNV-1a over UTF-8 bytes). The canonical
// serialization is a structured tuple (`canonicalTuple`) serialized once
// via `JSON.stringify`, which makes injectivity a property of the
// encoding rather than a per-site escaping discipline. See plans:
// jj:snrmsznm (FNV-1a-128 swap) and jj:qnmtvtwn (injective tuple form).

import fnv1a from "@sindresorhus/fnv1a"
import { isJsonBoundary, KIND, type Schema as SchemaNode } from "./schema.js"
import { serializeConstraintValue } from "./serialize-value.js"

/**
 * Algorithm-version prefix on `computeSchemaHash` output. Bump on any
 * change to the hash bytes (algorithm, canonicalization, or byte
 * encoding). Wire- and storage-visible.
 *
 * - `"00"`: two-pass FNV-1a-64 with shared prime, UTF-16 code-unit input
 *   (retired; see plan jj:snrmsznm).
 * - `"01"`: single-pass FNV-1a-128 over UTF-8 bytes, but with an
 *   S-expression canonicalization that dispatched on `[KIND]` only — so
 *   it was *boundary-blind* (`struct` ≡ `struct.json`) and *non-injective*
 *   (unescaped field names / constraint values could collide). Retired;
 *   see plan jj:qnmtvtwn.
 * - `"02"`: single-pass FNV-1a-128 over a JSON-serialized structured
 *   tuple (`canonicalTuple`). Injective for user-controlled strings (JSON
 *   escapes them; arrays are positional) and emits the `JSON_BOUNDARY`
 *   marker as a `"j"` tag.
 */
export const HASH_ALGORITHM_VERSION = "02" as const

/**
 * Compute a deterministic fingerprint from a schema's structural shape.
 *
 * The result is a 34-character hex string:
 *   - 2-char algorithm-version prefix (`HASH_ALGORITHM_VERSION`)
 *   - 32-char hex hash (16 bytes)
 *
 * The canonical serialization (`canonicalTuple` → `JSON.stringify`)
 * captures field names, scalar kind + constraints, structural kind,
 * nested structure, and the `JSON_BOUNDARY` marker. It does NOT capture
 * runtime values, display-only metadata, or backend-specific details.
 *
 * **Precondition:** `schema` is a finite, fully-eager, acyclic node tree.
 * The grammar guarantees this — product fields are eager `Schema` values
 * (there is no lazy/thunk field variant and no `lazy`/`recursive`
 * constructor), and recursive/hierarchical *data* is modeled via
 * `Schema.tree(item)`, which is itself a finite schema. A cyclic schema
 * *graph* is reachable only by unsupported `as any` mutation;
 * `canonicalTuple` guards against it with a depth cap (`MAX_CANON_DEPTH`)
 * that throws a clear error rather than overflowing the stack.
 *
 * This is a **versioning commitment** — the hash must never change for
 * the same schema across releases *at the same algorithm version*. The
 * version prefix is the explicit signal when bytes change.
 */
export function computeSchemaHash(schema: SchemaNode): string {
  return `${HASH_ALGORITHM_VERSION}${fnv1aHex(canonicalizeSchema(schema))}`
}

/**
 * 32-char hex of FNV-1a-128 over UTF-8 bytes. Algorithm-internal —
 * not version-tagged. Used by `computeSchemaHash` (which prepends
 * `HASH_ALGORITHM_VERSION`) and by `deriveIdentity` (which uses raw
 * 32 hex chars because identities are opaque positional addresses
 * consumed only by `SchemaBinding` internals).
 */
export function fnv1aHex(input: string): string {
  return fnv1a(input, { size: 128 }).toString(16).padStart(32, "0")
}

/**
 * The canonical value: a recursively-nested structure built from
 * **arrays and strings only — never objects** (object key order is
 * engine-defined; array order is positional and stable). Serialized once
 * via `JSON.stringify` to produce the canonical string, this makes
 * injectivity a property of the encoding: `JSON.stringify` escapes
 * user-controlled strings (field names, constraint values, mark names),
 * so they cannot forge structural delimiters the way the previous
 * `"01"` S-expression allowed (`{ "a:s:string,b": number }` once
 * collided with `{ a: string, b: number }`).
 *
 * The grammar:
 *   - scalar:    `["s", kind]` or `["s", kind, [serializedConstraint, …]]`
 *   - product:   `["p", [[name, child], …]]`  (names alphabetical)
 *   - sequence:  `["q", item]`
 *   - map:       `["m", item]`
 *   - sum:       `["u", [variant, …]]`               (positional, order preserved)
 *                `["d", discriminant, [variant, …]]` (discriminated, variants sorted)
 *   - text:      `["t", "text"]`     counter: `["t", "counter"]`
 *   - set/tree/movable: `["t", kind, item]`
 *   - richtext:  `["t", "richtext", [[markName, expand], …]]`  (names sorted)
 *   - JSON boundary (`struct.json`/`list.json`/`record.json`): the node's
 *     tuple wrapped as `["j", inner]` — the completeness fix, expressed
 *     as one more tag.
 *
 * Note: `decayMs` is intentionally NOT part of the canonical hash. Decay
 * is a local projection policy (it masks the `PlainState` shadow without
 * touching the underlying `StateTree` math), so two schemas that differ
 * only in `decayMs` are structurally identical and fully inter-mergeable.
 * This allows rolling deployments and per-device decay preferences without
 * breaking sync.
 *
 * The `Canon` return type (`string | Canon[]`) compiler-enforces the
 * arrays-and-strings-only invariant: returning an object or a bare number
 * fails to typecheck.
 *
 * Exported for tests only — NOT re-exported from the package barrel
 * (`index.ts`), so it is not part of the frozen public API.
 */
export type Canon = string | Canon[]

/**
 * Maximum canonicalization recursion depth. The grammar guarantees finite
 * acyclic schemas, so this is never hit by legitimate input; it converts
 * an `as any`-forced cyclic graph from an opaque `RangeError` into a
 * clear error. A depth cap (not a visited-set) is used deliberately so
 * legitimate shared-node DAGs — one `Schema.string()` reused across many
 * fields — never false-positive.
 */
const MAX_CANON_DEPTH = 1000

/** Build the canonical tuple for a schema. See {@link Canon}. */
export function canonicalTuple(schema: SchemaNode): Canon {
  return canonicalAt(schema, 0)
}

function canonicalAt(schema: SchemaNode, depth: number): Canon {
  if (depth > MAX_CANON_DEPTH) {
    throw new Error(
      `canonicalizeSchema: schema nesting exceeds limit (${MAX_CANON_DEPTH}) — cycle or pathological depth`,
    )
  }
  const body = canonicalKind(schema, depth)
  // Completeness: a `.json()` boundary materializes its subtree as one
  // opaque JSON value, not nested CRDT containers — distinct identity.
  return isJsonBoundary(schema) ? ["j", body] : body
}

function canonicalKind(schema: SchemaNode, depth: number): Canon {
  const recur = (child: SchemaNode): Canon => canonicalAt(child, depth + 1)
  switch (schema[KIND]) {
    case "scalar": {
      const constraint = (schema as { constraint?: readonly unknown[] })
        .constraint
      if (constraint && constraint.length > 0) {
        return [
          "s",
          schema.scalarKind,
          constraint.map(serializeConstraintValue),
        ]
      }
      return ["s", schema.scalarKind]
    }

    case "product": {
      const fields = Object.entries(
        (schema as { fields: Record<string, SchemaNode> }).fields,
      ).sort(([a], [b]) => a.localeCompare(b))
      return ["p", fields.map(([name, f]) => [name, recur(f)])]
    }

    case "sequence":
      return ["q", recur((schema as { item: SchemaNode }).item)]

    case "map":
      return ["m", recur((schema as { item: SchemaNode }).item)]

    case "sum": {
      const variants = (schema as { variants: readonly SchemaNode[] }).variants
      const discriminant = (schema as { discriminant?: string }).discriminant
      if (discriminant !== undefined) {
        // Discriminated sum — variants are an unordered set; sort by their
        // serialized canonical form for a deterministic, injective order.
        const parts = variants
          .map((v): [string, Canon] => {
            const t = recur(v)
            return [JSON.stringify(t), t]
          })
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([, t]) => t)
        return ["d", discriminant, parts]
      }
      // Positional sum — order is significant (e.g. `[null, S]` from `.nullable()`).
      return ["u", variants.map(recur)]
    }

    case "text":
      return ["t", "text"]

    case "counter":
      return ["t", "counter"]

    case "set":
      return ["t", "set", recur((schema as { item: SchemaNode }).item)]

    case "tree":
      return ["t", "tree", recur((schema as { item: SchemaNode }).item)]

    case "movable":
      return ["t", "movable", recur((schema as { item: SchemaNode }).item)]

    case "richtext": {
      const marks = (schema as { marks: Record<string, { expand: string }> })
        .marks
      const parts = Object.keys(marks)
        .sort()
        .map((k): Canon => [k, marks[k]?.expand ?? ""])
      return ["t", "richtext", parts]
    }

    default:
      throw new Error(
        `canonicalizeSchema: unknown schema kind "${String((schema as Record<symbol, unknown>)[KIND])}"`,
      )
  }
}

/**
 * Module-private canonical string: `JSON.stringify` of the structured
 * {@link Canon} tuple. The single input to `fnv1aHex` in
 * `computeSchemaHash`.
 */
function canonicalizeSchema(schema: SchemaNode): string {
  return JSON.stringify(canonicalTuple(schema))
}
