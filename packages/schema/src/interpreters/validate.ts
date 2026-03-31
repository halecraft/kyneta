// Validate interpreter — validates plain values against a schema.
//
// Architecture: one collecting interpreter, two public wrappers.
//
// The interpreter always collects errors into a mutable accumulator —
// it never throws. On mismatch, it pushes a SchemaValidationError and
// returns undefined as a sentinel. On success, it returns the validated
// value. The two public functions are thin wrappers:
//
// - validate()    — throws the first error if any
// - tryValidate() — returns a discriminated result with all errors

import { isNonNullObject } from "../guards.js"
import type { Interpreter, Path, SumVariants } from "../interpret.js"
import { interpret } from "../interpret.js"
import type { Plain } from "../interpreter-types.js"
import {
  type AnnotatedSchema,
  type DiscriminatedSumSchema,
  isNullableSum,
  type MapSchema,
  type PositionalSumSchema,
  type ProductSchema,
  type ScalarSchema,
  type Schema,
  type SequenceSchema,
  type SumSchema,
} from "../schema.js"

/**
 * Converts a typed Path to a human-readable string for error reporting.
 *
 * @deprecated Use `path.format()` instead. This free function is retained
 * temporarily for downstream consumers that haven't migrated yet.
 */
export function formatPath(path: Path): string {
  return path.format()
}

// ---------------------------------------------------------------------------
// SchemaValidationError
// ---------------------------------------------------------------------------

/**
 * A validation error produced by the validate interpreter.
 *
 * Each error captures:
 * - `path` — human-readable dot/bracket path (e.g. `"messages[0].author"`)
 * - `expected` — what the schema expected (e.g. `"string"`, `"one of \"a\" | \"b\""`)
 * - `actual` — the actual value that was found
 */
export class SchemaValidationError extends Error {
  constructor(
    public readonly path: string,
    public readonly expected: string,
    public readonly actual: unknown,
  ) {
    super(
      `Validation error at ${path}: expected ${expected}, got ${describeActual(actual)}`,
    )
    this.name = "SchemaValidationError"
  }
}

/**
 * Produces a short human-readable description of an actual value for
 * error messages.
 */
function describeActual(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return "array"
  if (value instanceof Uint8Array) return "Uint8Array"
  return typeof value
}

// ---------------------------------------------------------------------------
// ValidateContext
// ---------------------------------------------------------------------------

/**
 * Context for the validate interpreter.
 *
 * - `root` — the root value being validated (same role as `ctx` in
 *   `plainInterpreter`)
 * - `errors` — mutable accumulator for validation failures
 */
export interface ValidateContext {
  readonly root: unknown
  readonly errors: SchemaValidationError[]
}

// ---------------------------------------------------------------------------
// Scalar kind type checking
// ---------------------------------------------------------------------------

function checkScalarKind(kind: string, value: unknown): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string"
    case "number":
      return typeof value === "number"
    case "boolean":
      return typeof value === "boolean"
    case "null":
      return value === null
    case "undefined":
      return value === undefined
    case "bytes":
      return value instanceof Uint8Array
    case "any":
      return true
    default:
      return false
  }
}

/**
 * Returns the expected type name for a scalar kind, suitable for error
 * messages.
 */
function scalarExpected(kind: string): string {
  if (kind === "bytes") return "Uint8Array"
  return kind
}

// ---------------------------------------------------------------------------
// Validate interpreter
// ---------------------------------------------------------------------------

/**
 * An interpreter that validates plain values against a schema.
 *
 * The context is a `ValidateContext` with the root value and an error
 * accumulator. The result is `unknown` — the validated value on success,
 * or `undefined` as a sentinel on mismatch.
 *
 * The interpreter never throws. All validation failures are pushed to
 * `ctx.errors`.
 */
export const validateInterpreter: Interpreter<ValidateContext, unknown> = {
  scalar(ctx: ValidateContext, path: Path, schema: ScalarSchema): unknown {
    const value = path.read(ctx.root)

    // Check type
    if (!checkScalarKind(schema.scalarKind, value)) {
      ctx.errors.push(
        new SchemaValidationError(
          path.format(),
          scalarExpected(schema.scalarKind),
          value,
        ),
      )
      return undefined
    }

    // Check constraint
    if (schema.constraint !== undefined && schema.constraint.length > 0) {
      if (!schema.constraint.includes(value as never)) {
        const allowed = schema.constraint
          .map(v => JSON.stringify(v))
          .join(" | ")
        ctx.errors.push(
          new SchemaValidationError(path.format(), `one of ${allowed}`, value),
        )
        return undefined
      }
    }

    return value
  },

  product(
    ctx: ValidateContext,
    path: Path,
    _schema: ProductSchema,
    fields: Readonly<Record<string, () => unknown>>,
  ): unknown {
    const value = path.read(ctx.root)

    if (!isNonNullObject(value) || Array.isArray(value)) {
      ctx.errors.push(new SchemaValidationError(path.format(), "object", value))
      return undefined
    }

    // Force all field thunks — each validates its own subtree and
    // pushes errors to the shared accumulator.
    const result: Record<string, unknown> = {}
    for (const [key, thunk] of Object.entries(fields)) {
      result[key] = thunk()
    }
    return result
  },

  sequence(
    ctx: ValidateContext,
    path: Path,
    _schema: SequenceSchema,
    item: (index: number) => unknown,
  ): unknown {
    const value = path.read(ctx.root)

    if (!Array.isArray(value)) {
      ctx.errors.push(new SchemaValidationError(path.format(), "array", value))
      return undefined
    }

    return value.map((_element, index) => item(index))
  },

  map(
    ctx: ValidateContext,
    path: Path,
    _schema: MapSchema,
    item: (key: string) => unknown,
  ): unknown {
    const value = path.read(ctx.root)

    if (!isNonNullObject(value) || Array.isArray(value)) {
      ctx.errors.push(new SchemaValidationError(path.format(), "object", value))
      return undefined
    }

    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      result[key] = item(key)
    }
    return result
  },

  sum(
    ctx: ValidateContext,
    path: Path,
    schema: SumSchema,
    variants: SumVariants<unknown>,
  ): unknown {
    if (schema.discriminant !== undefined && variants.byKey) {
      // ── Discriminated sum ──────────────────────────────────────────
      const discSchema = schema as DiscriminatedSumSchema
      const value = path.read(ctx.root)

      // Must be an object
      if (!isNonNullObject(value) || Array.isArray(value)) {
        ctx.errors.push(
          new SchemaValidationError(path.format(), "object", value),
        )
        return undefined
      }

      const obj = value
      const discValue = obj[schema.discriminant]

      // Discriminant must be a string
      if (typeof discValue !== "string") {
        const discPath = path.field(schema.discriminant)
        ctx.errors.push(
          new SchemaValidationError(
            discPath.format(),
            "string (discriminant)",
            discValue,
          ),
        )
        return undefined
      }

      // Discriminant must be a known variant key
      if (!(discValue in discSchema.variantMap)) {
        const discPath = path.field(schema.discriminant)
        const keys = Object.keys(discSchema.variantMap)
          .map(k => JSON.stringify(k))
          .join(", ")
        ctx.errors.push(
          new SchemaValidationError(
            discPath.format(),
            `one of [${keys}]`,
            discValue,
          ),
        )
        return undefined
      }

      // Validate through the matching variant
      return variants.byKey(discValue)
    }

    // ── Positional sum ─────────────────────────────────────────────
    if (variants.byIndex) {
      const posSchema = schema as PositionalSumSchema
      const variantCount = posSchema.variants.length
      const nullable = isNullableSum(posSchema)

      for (let i = 0; i < variantCount; i++) {
        const mark = ctx.errors.length
        const result = variants.byIndex(i)

        // If no new errors were pushed, this variant matched
        if (ctx.errors.length === mark) {
          return result
        }

        // Variant failed — rollback its errors before trying the next
        ctx.errors.length = mark
      }

      // All variants failed
      if (nullable) {
        // Describe the inner (second) variant for a helpful message
        const inner = posSchema.variants[1]!
        const innerDesc = innerSchemaExpected(inner)
        ctx.errors.push(
          new SchemaValidationError(
            path.format(),
            `nullable<${innerDesc}>`,
            path.read(ctx.root),
          ),
        )
      } else {
        ctx.errors.push(
          new SchemaValidationError(
            path.format(),
            `one of union variants`,
            path.read(ctx.root),
          ),
        )
      }
      return undefined
    }

    return undefined
  },

  annotated(
    ctx: ValidateContext,
    path: Path,
    schema: AnnotatedSchema,
    inner: (() => unknown) | undefined,
  ): unknown {
    const tag = schema.tag

    // ── Leaf annotations (no inner schema) ─────────────────────────
    if (inner === undefined) {
      const value = path.read(ctx.root)

      switch (tag) {
        case "text":
          if (typeof value !== "string") {
            ctx.errors.push(
              new SchemaValidationError(path.format(), "string (text)", value),
            )
            return undefined
          }
          return value

        case "counter":
          if (typeof value !== "number") {
            ctx.errors.push(
              new SchemaValidationError(
                path.format(),
                "number (counter)",
                value,
              ),
            )
            return undefined
          }
          return value

        default:
          // Unknown leaf annotation — accept any value
          return value
      }
    }

    // ── Structural annotations (doc, movable, tree, etc.) ──────────
    // Delegate to inner schema interpretation
    return inner()
  },
}

// ---------------------------------------------------------------------------
// Helper: describe an inner schema for error messages
// ---------------------------------------------------------------------------

/**
 * Returns a short expected-type description for a schema node,
 * used in error messages for nullable sums.
 */
function innerSchemaExpected(schema: Schema): string {
  switch (schema._kind) {
    case "scalar":
      return scalarExpected(schema.scalarKind)
    case "product":
      return "object"
    case "sequence":
      return "array"
    case "map":
      return "object"
    case "sum":
      return "union"
    case "annotated":
      if (schema.tag === "text") return "string (text)"
      if (schema.tag === "counter") return "number (counter)"
      if (schema.schema !== undefined) return innerSchemaExpected(schema.schema)
      return schema.tag
  }
}

// ---------------------------------------------------------------------------
// Public API: validate / tryValidate
// ---------------------------------------------------------------------------

/**
 * Validates a plain value against a schema and narrows the type.
 *
 * On success, returns the validated value typed as `Plain<S>`.
 * On failure, throws the first `SchemaValidationError`.
 *
 * ```ts
 * const data = validate(MySchema, rawJSON)
 * //    ^? Plain<typeof MySchema>
 * ```
 */
export function validate<S extends Schema>(
  schema: S,
  value: unknown,
): Plain<S> {
  const ctx: ValidateContext = { root: value, errors: [] }
  const result = interpret(schema, validateInterpreter, ctx)

  if (ctx.errors.length > 0) {
    throw ctx.errors[0]!
  }

  return result as Plain<S>
}

/**
 * Validates a plain value against a schema without throwing.
 *
 * Returns a discriminated result:
 * - `{ ok: true, value }` on success, with value typed as `Plain<S>`
 * - `{ ok: false, errors }` on failure, with all collected errors
 *
 * ```ts
 * const result = tryValidate(MySchema, rawJSON)
 * if (result.ok) {
 *   console.log(result.value) // Plain<typeof MySchema>
 * } else {
 *   console.error(result.errors) // SchemaValidationError[]
 * }
 * ```
 */
export function tryValidate<S extends Schema>(
  schema: S,
  value: unknown,
):
  | { ok: true; value: Plain<S> }
  | { ok: false; errors: SchemaValidationError[] } {
  const ctx: ValidateContext = { root: value, errors: [] }
  const result = interpret(schema, validateInterpreter, ctx)

  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors }
  }

  return { ok: true, value: result as Plain<S> }
}
