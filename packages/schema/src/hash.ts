// hash — deterministic schema fingerprinting and FNV-1a hashing.
//
// Extracted from substrate.ts so that migration.ts can depend on
// hashing without importing the full substrate interface surface.

import { KIND, type Schema as SchemaNode } from "./schema.js"

/**
 * Compute a deterministic fingerprint from a schema's structural shape.
 *
 * Uses FNV-1a at 128 bits (two independent 64-bit passes with different
 * seeds). Synchronous, no platform dependency.
 *
 * The result is a 34-character hex string:
 *   - 2-char algorithm version prefix ("00" = FNV-1a-128)
 *   - 32-char hex hash (16 bytes)
 *
 * The canonical serialization captures field names (alphabetical order),
 * field types (scalar kind, annotation tag, structural kind), and nested
 * structure (recursive). It does NOT capture runtime values or
 * backend-specific details.
 *
 * This is a **versioning commitment** — the hash must never change for
 * the same schema across releases. The canonical serialization format
 * and FNV-1a algorithm are stable contracts.
 */
export function computeSchemaHash(schema: SchemaNode): string {
  const canonical = canonicalizeSchema(schema)
  const hash = fnv1a128(canonical)
  return `00${hash}`
}

/**
 * Produce a deterministic string representation of a schema's structure.
 *
 * The format is a compact S-expression-like notation:
 *   - scalar: `s:kind` (e.g. `s:string`, `s:number`)
 *   - product: `p(field1:...,field2:...)` with fields in alphabetical order
 *   - sequence: `q(item)`
 *   - map: `m(value)`
 *   - sum: `u(v0,v1,...)` for positional, `d:disc(tag0:...,tag1:...)` for discriminated
 *   - text: `t:text`
 *   - counter: `t:counter`
 *   - set: `t:set(item)`
 *   - tree: `t:tree(nodeData)`
 *   - movable: `t:movable(item)`
 */
function canonicalizeSchema(schema: SchemaNode): string {
  switch (schema[KIND]) {
    case "scalar": {
      const constraint = (schema as any).constraint as unknown[] | undefined
      if (constraint && constraint.length > 0) {
        // Include constraints in the hash for discriminated sum tags
        return `s:${schema.scalarKind}[${constraint.map(String).join(",")}]`
      }
      return `s:${schema.scalarKind}`
    }

    case "product": {
      const fields = Object.entries(
        (schema as any).fields as Record<string, SchemaNode>,
      ).sort(([a], [b]) => a.localeCompare(b))
      const parts = fields.map(
        ([name, fieldSchema]) => `${name}:${canonicalizeSchema(fieldSchema)}`,
      )
      return `p(${parts.join(",")})`
    }

    case "sequence":
      return `q(${canonicalizeSchema((schema as any).item as SchemaNode)})`

    case "map":
      return `m(${canonicalizeSchema((schema as any).item as SchemaNode)})`

    case "sum": {
      const discriminant = (schema as any).discriminant as string | undefined
      if (discriminant !== undefined) {
        // Discriminated sum — variants are products, keyed by discriminant tag
        const variants = (schema as any).variants as SchemaNode[]
        const parts = variants
          .map((v: SchemaNode) => canonicalizeSchema(v))
          .sort()
        return `d:${discriminant}(${parts.join(",")})`
      }
      // Positional sum
      const variants = (schema as any).variants as SchemaNode[]
      const parts = variants.map((v: SchemaNode) => canonicalizeSchema(v))
      return `u(${parts.join(",")})`
    }

    case "text":
      return `t:text`

    case "counter":
      return `t:counter`

    case "set":
      return `t:set(${canonicalizeSchema((schema as any).item as SchemaNode)})`

    case "tree":
      return `t:tree(${canonicalizeSchema((schema as any).nodeData as SchemaNode)})`

    case "movable":
      return `t:movable(${canonicalizeSchema((schema as any).item as SchemaNode)})`

    case "richtext": {
      const marks = (schema as any).marks as Record<string, { expand: string }>
      const parts = Object.keys(marks)
        .sort()
        .map(k => `${k}:${marks[k]!.expand}`)
      return `t:richtext(${parts.join(",")})`
    }

    default:
      throw new Error(
        `canonicalizeSchema: unknown schema kind "${(schema as any)[KIND]}"`,
      )
  }
}

/**
 * FNV-1a at 128 bits, implemented as two independent 64-bit passes
 * with different seeds. Returns a 32-character hex string.
 */
export function fnv1a128(input: string): string {
  // Pass 1: standard FNV-1a 64-bit
  let h1 = BigInt("0xcbf29ce484222325")
  const p1 = BigInt("0x100000001b3")
  const mask64 = BigInt("0xFFFFFFFFFFFFFFFF")
  for (let i = 0; i < input.length; i++) {
    h1 ^= BigInt(input.charCodeAt(i))
    h1 = (h1 * p1) & mask64
  }

  // Pass 2: FNV-1a 64-bit with offset seed
  let h2 = BigInt("0x6c62272e07bb0142")
  const p2 = BigInt("0x100000001b3")
  for (let i = 0; i < input.length; i++) {
    h2 ^= BigInt(input.charCodeAt(i))
    h2 = (h2 * p2) & mask64
  }

  // Concatenate both halves as 32 hex chars
  return h1.toString(16).padStart(16, "0") + h2.toString(16).padStart(16, "0")
}
