// Validate interpreter tests — covers every schema kind, error collection,
// type narrowing, and the two public wrappers (validate / tryValidate).

import { describe, expect, it, expectTypeOf } from "vitest"
import {
  Schema,
  LoroSchema,
  validate,
  tryValidate,
  SchemaValidationError,
  formatPath,
  interpret,
  validateInterpreter,
} from "../index.js"
import type { ValidateContext } from "../index.js"
import type { Plain } from "../index.js"

// Helper: run validation without triggering Plain<S> type resolution.
// Avoids TS2589 ("excessively deep") when used inside expect(() => ...).toThrow()
// where TypeScript eagerly resolves the generic return type even though the
// value is discarded. This calls the same interpreter + error-check logic
// that validate() uses, but with a non-generic signature.
function validateUntyped(schema: Parameters<typeof validate>[0], value: unknown): unknown {
  const ctx: ValidateContext = { root: value, errors: [] }
  const result = interpret(schema, validateInterpreter, ctx)
  if (ctx.errors.length > 0) {
    throw ctx.errors[0]!
  }
  return result
}

// ---------------------------------------------------------------------------
// formatPath
// ---------------------------------------------------------------------------

describe("formatPath", () => {
  it("empty path → 'root'", () => {
    expect(formatPath([])).toBe("root")
  })

  it("single key segment", () => {
    expect(formatPath([{ type: "key", key: "title" }])).toBe("title")
  })

  it("nested key segments use dot notation", () => {
    expect(
      formatPath([
        { type: "key", key: "settings" },
        { type: "key", key: "darkMode" },
      ]),
    ).toBe("settings.darkMode")
  })

  it("index segments use bracket notation", () => {
    expect(
      formatPath([
        { type: "key", key: "items" },
        { type: "index", index: 0 },
      ]),
    ).toBe("items[0]")
  })

  it("mixed key and index segments", () => {
    expect(
      formatPath([
        { type: "key", key: "messages" },
        { type: "index", index: 2 },
        { type: "key", key: "author" },
      ]),
    ).toBe("messages[2].author")
  })
})

// ---------------------------------------------------------------------------
// SchemaValidationError
// ---------------------------------------------------------------------------

describe("SchemaValidationError", () => {
  it("has correct name, path, expected, and actual", () => {
    const err = new SchemaValidationError("foo.bar", "string", 42)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("SchemaValidationError")
    expect(err.path).toBe("foo.bar")
    expect(err.expected).toBe("string")
    expect(err.actual).toBe(42)
    expect(err.message).toContain("foo.bar")
    expect(err.message).toContain("string")
    expect(err.message).toContain("number")
  })

  it("describes null actual correctly", () => {
    const err = new SchemaValidationError("root", "string", null)
    expect(err.message).toContain("null")
  })

  it("describes undefined actual correctly", () => {
    const err = new SchemaValidationError("root", "string", undefined)
    expect(err.message).toContain("undefined")
  })

  it("describes array actual correctly", () => {
    const err = new SchemaValidationError("root", "object", [1, 2])
    expect(err.message).toContain("array")
  })
})

// ---------------------------------------------------------------------------
// Scalar validation
// ---------------------------------------------------------------------------

describe("validate: scalar", () => {
  // Extract schemas to consts to avoid TS2589 ("excessively deep")
  // when validate<S>() is used inline inside expect(() => ...).toThrow()
  const sStr = Schema.string()
  const sNum = Schema.number()
  const sBool = Schema.boolean()
  const sNull = Schema.null()
  const sUndef = Schema.undefined()
  const sBytes = Schema.bytes()
  const sAny = Schema.any()

  it("string — valid", () => {
    expect(validate(sStr, "hello")).toBe("hello")
  })

  it("string — invalid", () => {
    expect(() => validateUntyped(sStr, 42)).toThrow(SchemaValidationError)
  })

  it("number — valid", () => {
    expect(validate(sNum, 42)).toBe(42)
  })

  it("number — invalid", () => {
    expect(() => validateUntyped(sNum, "nope")).toThrow(SchemaValidationError)
  })

  it("boolean — valid true", () => {
    expect(validate(sBool, true)).toBe(true)
  })

  it("boolean — valid false", () => {
    expect(validate(sBool, false)).toBe(false)
  })

  it("boolean — invalid", () => {
    expect(() => validateUntyped(sBool, 0)).toThrow(SchemaValidationError)
  })

  it("null — valid", () => {
    expect(validate(sNull, null)).toBe(null)
  })

  it("null — rejects undefined", () => {
    expect(() => validateUntyped(sNull, undefined)).toThrow(SchemaValidationError)
  })

  it("null — rejects object", () => {
    expect(() => validateUntyped(sNull, {})).toThrow(SchemaValidationError)
  })

  it("undefined — valid", () => {
    expect(validate(sUndef, undefined)).toBe(undefined)
  })

  it("undefined — rejects null", () => {
    expect(() => validateUntyped(sUndef, null)).toThrow(SchemaValidationError)
  })

  it("bytes — valid Uint8Array", () => {
    const buf = new Uint8Array([1, 2, 3])
    expect(validate(sBytes, buf)).toBe(buf)
  })

  it("bytes — rejects plain array", () => {
    expect(() => validateUntyped(sBytes, [1, 2, 3])).toThrow(SchemaValidationError)
  })

  it("bytes — rejects string", () => {
    expect(() => validateUntyped(sBytes, "binary")).toThrow(SchemaValidationError)
  })

  it("any — accepts string", () => {
    expect(validate(sAny, "anything")).toBe("anything")
  })

  it("any — accepts number", () => {
    expect(validate(sAny, 42)).toBe(42)
  })

  it("any — accepts null", () => {
    expect(validate(sAny, null)).toBe(null)
  })

  it("any — accepts undefined", () => {
    expect(validate(sAny, undefined)).toBe(undefined)
  })

  it("any — accepts object", () => {
    const obj = { x: 1 }
    expect(validate(sAny, obj)).toBe(obj)
  })
})

// ---------------------------------------------------------------------------
// Constrained scalar validation
// ---------------------------------------------------------------------------

describe("validate: constrained scalar", () => {
  it("string with options — valid option", () => {
    const s = Schema.string("public", "private")
    expect(validate(s, "public")).toBe("public")
    expect(validate(s, "private")).toBe("private")
  })

  it("string with options — invalid option", () => {
    const s = Schema.string("public", "private")
    const result = tryValidate(s, "other")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.expected).toContain('"public"')
      expect(result.errors[0]!.expected).toContain('"private"')
    }
  })

  it("string with options — wrong type rejects before constraint", () => {
    const s = Schema.string("a", "b")
    expect(() => validateUntyped(s, 42)).toThrow(SchemaValidationError)
    const result = tryValidate(s, 42)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]!.expected).toBe("string")
    }
  })

  it("number with options — valid", () => {
    const s = Schema.number(1, 2, 3)
    expect(validate(s, 2)).toBe(2)
  })

  it("number with options — invalid", () => {
    const sNum = Schema.number(1, 2, 3)
    expect(() => validateUntyped(sNum, 99)).toThrow(SchemaValidationError)
  })

  it("boolean with options — valid", () => {
    const sBool = Schema.boolean(true)
    expect(validate(sBool, true)).toBe(true)
  })

  it("boolean with options — invalid", () => {
    const sBool = Schema.boolean(true)
    expect(() => validateUntyped(sBool, false)).toThrow(SchemaValidationError)
  })
})

// ---------------------------------------------------------------------------
// Product (struct) validation
// ---------------------------------------------------------------------------

describe("validate: product", () => {
  const s = Schema.struct({
    name: Schema.string(),
    age: Schema.number(),
  })

  it("valid object", () => {
    const result = validate(s, { name: "Alice", age: 30 })
    expect(result).toEqual({ name: "Alice", age: 30 })
  })

  it("non-object value", () => {
    expect(() => validateUntyped(s, "not an object")).toThrow(
      SchemaValidationError,
    )
  })

  it("null value", () => {
    expect(() => validateUntyped(s, null)).toThrow(SchemaValidationError)
  })

  it("array value rejected", () => {
    expect(() => validateUntyped(s, [1, 2])).toThrow(SchemaValidationError)
  })

  it("missing field produces error at field path", () => {
    const result = tryValidate(s, { name: "Alice" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.path).toBe("age")
      expect(result.errors[0]!.expected).toBe("number")
    }
  })

  it("extra fields pass — schemas don't forbid extra keys", () => {
    const result = validate(s, { name: "Alice", age: 30, extra: true })
    expect(result).toEqual({ name: "Alice", age: 30 })
  })

  it("multiple wrong fields produce multiple errors", () => {
    const result = tryValidate(s, { name: 42, age: "thirty" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(2)
      const paths = result.errors.map((e) => e.path)
      expect(paths).toContain("name")
      expect(paths).toContain("age")
    }
  })
})

// ---------------------------------------------------------------------------
// Sequence (list) validation
// ---------------------------------------------------------------------------

describe("validate: sequence", () => {
  const s = Schema.list(Schema.number())

  it("valid array", () => {
    expect(validate(s, [1, 2, 3])).toEqual([1, 2, 3])
  })

  it("empty array", () => {
    expect(validate(s, [])).toEqual([])
  })

  it("non-array", () => {
    expect(() => validateUntyped(s, "not an array")).toThrow(
      SchemaValidationError,
    )
  })

  it("object is not an array", () => {
    expect(() => validateUntyped(s, { 0: 1 })).toThrow(SchemaValidationError)
  })

  it("invalid item at specific index — error path includes [i]", () => {
    const result = tryValidate(s, [1, "two", 3])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.path).toBe("[1]")
    }
  })

  it("multiple invalid items collect multiple errors", () => {
    const result = tryValidate(s, [1, "two", "three"])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(2)
      expect(result.errors[0]!.path).toBe("[1]")
      expect(result.errors[1]!.path).toBe("[2]")
    }
  })
})

// ---------------------------------------------------------------------------
// Map (record) validation
// ---------------------------------------------------------------------------

describe("validate: map", () => {
  const s = Schema.record(Schema.number())

  it("valid object", () => {
    expect(validate(s, { x: 1, y: 2 })).toEqual({ x: 1, y: 2 })
  })

  it("empty object", () => {
    expect(validate(s, {})).toEqual({})
  })

  it("non-object", () => {
    expect(() => validateUntyped(s, "nope")).toThrow(SchemaValidationError)
  })

  it("null rejected", () => {
    expect(() => validateUntyped(s, null)).toThrow(SchemaValidationError)
  })

  it("array rejected", () => {
    expect(() => validateUntyped(s, [1, 2])).toThrow(SchemaValidationError)
  })

  it("invalid value at specific key — error path includes .key", () => {
    const result = tryValidate(s, { x: 1, y: "two" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.path).toBe("y")
    }
  })
})

// ---------------------------------------------------------------------------
// Positional sum (union) validation
// ---------------------------------------------------------------------------

describe("validate: positional sum", () => {
  const s = Schema.union(Schema.string(), Schema.number())

  it("value matching first variant", () => {
    expect(validate(s, "hello")).toBe("hello")
  })

  it("value matching second variant", () => {
    expect(validate(s, 42)).toBe(42)
  })

  it("value matching no variant", () => {
    const result = tryValidate(s, true)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.expected).toContain("union variants")
    }
  })

  it("three-way union", () => {
    const s3 = Schema.union(
      Schema.string(),
      Schema.number(),
      Schema.boolean(),
    )
    expect(validate(s3, "a")).toBe("a")
    expect(validate(s3, 1)).toBe(1)
    expect(validate(s3, true)).toBe(true)
    expect(() => validateUntyped(s3, null)).toThrow(SchemaValidationError)
  })

  it("union with struct variants tries each", () => {
    const s2 = Schema.union(
      Schema.struct({ x: Schema.string() }),
      Schema.struct({ y: Schema.number() }),
    )
    expect(validate(s2, { x: "ok" })).toEqual({ x: "ok" })
    // Note: second variant will also "pass" for {x: "ok"} because
    // it reads y as undefined (which fails number check).
    // But the first variant passes first.
  })

  it("error rollback: failed variant errors don't leak", () => {
    // If variant 1 (string) fails and variant 2 (number) succeeds,
    // there should be zero errors in the result.
    const result = tryValidate(s, 42)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe(42)
    }
  })
})

// ---------------------------------------------------------------------------
// Discriminated sum validation
// ---------------------------------------------------------------------------

describe("validate: discriminated sum", () => {
  const s = Schema.discriminatedUnion("type", {
    text: Schema.struct({ body: Schema.string() }),
    image: Schema.struct({ url: Schema.string(), width: Schema.number() }),
  })

  it("valid discriminant + valid body", () => {
    const result = validate(s, { type: "text", body: "hello" })
    expect(result).toEqual({ body: "hello" })
  })

  it("valid discriminant + valid body (second variant)", () => {
    const result = validate(s, { type: "image", url: "pic.png", width: 100 })
    expect(result).toEqual({ url: "pic.png", width: 100 })
  })

  it("valid discriminant + invalid body", () => {
    const result = tryValidate(s, { type: "text", body: 42 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.path).toBe("body")
      expect(result.errors[0]!.expected).toBe("string")
    }
  })

  it("invalid discriminant value", () => {
    const result = tryValidate(s, { type: "video" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.path).toBe("type")
      expect(result.errors[0]!.expected).toContain("text")
      expect(result.errors[0]!.expected).toContain("image")
    }
  })

  it("missing discriminant key", () => {
    const result = tryValidate(s, { body: "hello" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.path).toBe("type")
      expect(result.errors[0]!.expected).toContain("discriminant")
    }
  })

  it("non-object value", () => {
    const result = tryValidate(s, "hello")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.expected).toBe("object")
    }
  })

  it("null value", () => {
    expect(() => validateUntyped(s, null)).toThrow(SchemaValidationError)
  })
})

// ---------------------------------------------------------------------------
// Nullable validation
// ---------------------------------------------------------------------------

describe("validate: nullable", () => {
  const s = Schema.nullable(Schema.string())

  it("null passes", () => {
    expect(validate(s, null)).toBe(null)
  })

  it("valid inner passes", () => {
    expect(validate(s, "hello")).toBe("hello")
  })

  it("invalid inner fails with nullable-aware message", () => {
    const result = tryValidate(s, 42)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.expected).toContain("nullable")
      expect(result.errors[0]!.expected).toContain("string")
    }
  })

  it("nullable number", () => {
    const sNum = Schema.nullable(Schema.number())
    expect(validate(sNum, null)).toBe(null)
    expect(validate(sNum, 42)).toBe(42)
    expect(() => validateUntyped(sNum, "nope")).toThrow(SchemaValidationError)
  })

  it("nullable struct", () => {
    const ss = Schema.nullable(Schema.struct({ x: Schema.number() }))
    expect(validate(ss, null)).toBe(null)
    expect(validate(ss, { x: 1 })).toEqual({ x: 1 })
    const result = tryValidate(ss, "nope")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]!.expected).toContain("nullable")
    }
  })
})

// ---------------------------------------------------------------------------
// Annotated validation (Loro annotations)
// ---------------------------------------------------------------------------

describe("validate: annotated", () => {
  it("text — valid string", () => {
    expect(validate(LoroSchema.text(), "hello")).toBe("hello")
  })

  it("text — invalid (number)", () => {
    const result = tryValidate(LoroSchema.text(), 42)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]!.expected).toContain("text")
    }
  })

  it("counter — valid number", () => {
    expect(validate(LoroSchema.counter(), 42)).toBe(42)
  })

  it("counter — invalid (string)", () => {
    const result = tryValidate(LoroSchema.counter(), "nope")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]!.expected).toContain("counter")
    }
  })

  it("doc — delegates to inner product", () => {
    const s = Schema.doc({
      title: Schema.string(),
      count: Schema.number(),
    })
    const result = validate(s, { title: "hi", count: 5 })
    expect(result).toEqual({ title: "hi", count: 5 })
  })

  it("doc — invalid inner product", () => {
    const s = Schema.doc({
      title: Schema.string(),
    })
    const result = tryValidate(s, { title: 42 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]!.path).toBe("title")
    }
  })

  it("doc — non-object", () => {
    const sDoc = Schema.doc({ title: Schema.string() })
    expect(() => validateUntyped(sDoc, "nope")).toThrow(SchemaValidationError)
  })

  it("movableList — delegates to inner sequence", () => {
    const s = LoroSchema.movableList(Schema.string())
    expect(validate(s, ["a", "b"])).toEqual(["a", "b"])
  })

  it("movableList — invalid item", () => {
    const s = LoroSchema.movableList(Schema.string())
    const result = tryValidate(s, ["a", 42])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]!.path).toBe("[1]")
    }
  })

  it("tree — delegates to inner", () => {
    const s = LoroSchema.tree(
      Schema.struct({ label: Schema.string() }),
    )
    expect(validate(s, { label: "root" })).toEqual({ label: "root" })
  })

  it("unknown annotation without inner — accepts any value", () => {
    const sCustom = Schema.annotated("custom")
    expect(validate(sCustom, "anything")).toBe("anything")
    expect(validate(sCustom, 42)).toBe(42)
  })

  it("unknown annotation with inner — delegates", () => {
    const sCustom = Schema.annotated("custom", Schema.string())
    expect(validate(sCustom, "ok")).toBe("ok")
    expect(() => validateUntyped(sCustom, 42)).toThrow(SchemaValidationError)
  })
})

// ---------------------------------------------------------------------------
// Nested realistic schema
// ---------------------------------------------------------------------------

describe("validate: nested realistic schema", () => {
  const ProjectSchema = LoroSchema.doc({
    name: LoroSchema.text(),
    stars: LoroSchema.counter(),
    tasks: Schema.list(
      Schema.struct({
        title: Schema.string(),
        done: Schema.boolean(),
        priority: Schema.number(1, 2, 3),
      }),
    ),
    settings: Schema.struct({
      visibility: Schema.string("public", "private"),
      maxTasks: Schema.number(),
    }),
    labels: Schema.record(Schema.string()),
    bio: Schema.nullable(Schema.string()),
  })

  const validData = {
    name: "My Project",
    stars: 42,
    tasks: [
      { title: "Design", done: true, priority: 1 },
      { title: "Build", done: false, priority: 2 },
    ],
    settings: { visibility: "public", maxTasks: 50 },
    labels: { bug: "red", feature: "blue" },
    bio: null,
  }

  it("valid data passes", () => {
    const result = validate(ProjectSchema, validData)
    expect(result).toEqual(validData)
  })

  it("valid data with non-null bio", () => {
    const result = validate(ProjectSchema, { ...validData, bio: "hello" })
    expect(result).toEqual({ ...validData, bio: "hello" })
  })

  it("deeply nested error has correct path", () => {
    const bad = {
      ...validData,
      tasks: [
        { title: "ok", done: true, priority: 1 },
        { title: "bad", done: "not-boolean", priority: 2 },
      ],
    }
    const result = tryValidate(ProjectSchema, bad)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.path).toBe("tasks[1].done")
      expect(result.errors[0]!.expected).toBe("boolean")
    }
  })

  it("constrained scalar error in nested path", () => {
    const bad = {
      ...validData,
      tasks: [{ title: "test", done: true, priority: 99 }],
    }
    const result = tryValidate(ProjectSchema, bad)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.path).toBe("tasks[0].priority")
      expect(result.errors[0]!.expected).toContain("1")
      expect(result.errors[0]!.expected).toContain("2")
      expect(result.errors[0]!.expected).toContain("3")
    }
  })

  it("constrained string error in settings", () => {
    const bad = {
      ...validData,
      settings: { visibility: "unlisted", maxTasks: 50 },
    }
    const result = tryValidate(ProjectSchema, bad)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]!.path).toBe("settings.visibility")
    }
  })

  it("nullable field with wrong type", () => {
    const bad = { ...validData, bio: 42 }
    const result = tryValidate(ProjectSchema, bad)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]!.path).toBe("bio")
      expect(result.errors[0]!.expected).toContain("nullable")
    }
  })
})

// ---------------------------------------------------------------------------
// tryValidate: multi-error collection
// ---------------------------------------------------------------------------

describe("tryValidate: multi-error collection", () => {
  it("collects multiple errors from a single value with wrong types in several fields", () => {
    const s = Schema.struct({
      a: Schema.string(),
      b: Schema.number(),
      c: Schema.boolean(),
    })
    const result = tryValidate(s, { a: 1, b: "two", c: "three" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(3)
      const paths = result.errors.map((e) => e.path).sort()
      expect(paths).toEqual(["a", "b", "c"])
    }
  })

  it("collects errors from nested products", () => {
    const s = Schema.struct({
      inner: Schema.struct({
        x: Schema.string(),
        y: Schema.number(),
      }),
    })
    const result = tryValidate(s, { inner: { x: 42, y: "nope" } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(2)
      expect(result.errors.map((e) => e.path).sort()).toEqual([
        "inner.x",
        "inner.y",
      ])
    }
  })

  it("collects errors from sequence items and other fields", () => {
    const s = Schema.struct({
      name: Schema.string(),
      items: Schema.list(Schema.number()),
    })
    const result = tryValidate(s, { name: 42, items: [1, "two", 3, "four"] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(3) // name + items[1] + items[3]
      const paths = result.errors.map((e) => e.path)
      expect(paths).toContain("name")
      expect(paths).toContain("items[1]")
      expect(paths).toContain("items[3]")
    }
  })

  it("product field errors are collected even after first failure", () => {
    // Ensures the interpreter does NOT short-circuit after the first
    // field error — all fields are validated.
    const s = Schema.struct({
      a: Schema.string(),
      b: Schema.string(),
      c: Schema.string(),
      d: Schema.string(),
    })
    const result = tryValidate(s, { a: 1, b: 2, c: 3, d: 4 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(4)
    }
  })
})

// ---------------------------------------------------------------------------
// validate: throws on first error
// ---------------------------------------------------------------------------

describe("validate: throwing behavior", () => {
  it("throws the first SchemaValidationError from the collected list", () => {
    const s = Schema.struct({
      a: Schema.string(),
      b: Schema.number(),
    })
    try {
      validateUntyped(s, { a: 1, b: "two" })
      expect.fail("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaValidationError)
      // The first field alphabetically in Object.keys iteration
      // (a comes before b typically, but we just check it's one of them)
      expect((e as SchemaValidationError).path).toMatch(/^(a|b)$/)
    }
  })

  it("returns validated value on success", () => {
    const s = Schema.struct({ x: Schema.number() })
    const result = validate(s, { x: 42 })
    expect(result).toEqual({ x: 42 })
  })
})

// ---------------------------------------------------------------------------
// Type narrowing
// ---------------------------------------------------------------------------

describe("validate: type narrowing", () => {
  it("validate return type is Plain<typeof schema>", () => {
    const s = Schema.struct({
      title: Schema.string(),
      count: Schema.number(),
    })
    const result = validate(s, { title: "hi", count: 1 })
    expectTypeOf(result).toEqualTypeOf<{ title: string; count: number }>()
  })

  it("tryValidate ok branch has Plain type", () => {
    const s = Schema.struct({ x: Schema.string() })
    const result = tryValidate(s, { x: "hi" })
    if (result.ok) {
      expectTypeOf(result.value).toEqualTypeOf<{ x: string }>()
    }
  })

  it("tryValidate error branch has SchemaValidationError[]", () => {
    const s = Schema.string()
    const result = tryValidate(s, 42)
    if (!result.ok) {
      expectTypeOf(result.errors).toEqualTypeOf<SchemaValidationError[]>()
    }
  })

  it("validate narrows constrained scalars", () => {
    const s = Schema.string("a", "b")
    const result = validate(s, "a")
    expectTypeOf(result).toEqualTypeOf<"a" | "b">()
  })

  it("validate narrows doc schemas", () => {
    const s = Schema.doc({
      title: Schema.string(),
      items: Schema.list(Schema.number()),
    })
    const result = validate(s, { title: "x", items: [1] })
    expectTypeOf(result).toEqualTypeOf<{ title: string; items: number[] }>()
  })

  it("validate narrows nullable", () => {
    const s = Schema.nullable(Schema.string())
    const result = validate(s, null)
    expectTypeOf(result).toEqualTypeOf<string | null>()
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("validate: edge cases", () => {
  it("empty struct", () => {
    const s = Schema.struct({})
    expect(validate(s, {})).toEqual({})
  })

  it("nested empty structs", () => {
    const s = Schema.struct({ inner: Schema.struct({}) })
    expect(validate(s, { inner: {} })).toEqual({ inner: {} })
  })

  it("deeply nested path formatting", () => {
    const s = Schema.struct({
      a: Schema.struct({
        b: Schema.list(
          Schema.struct({
            c: Schema.record(Schema.number()),
          }),
        ),
      }),
    })
    const result = tryValidate(s, {
      a: { b: [{ c: { key: "not a number" } }] },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]!.path).toBe("a.b[0].c.key")
    }
  })

  it("sequence of structs with mixed valid/invalid", () => {
    const s = Schema.list(Schema.struct({ x: Schema.number() }))
    const result = tryValidate(s, [{ x: 1 }, { x: "bad" }, { x: 3 }])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.path).toBe("[1].x")
    }
  })

  it("record values with struct items", () => {
    const s = Schema.record(Schema.struct({ v: Schema.boolean() }))
    const result = tryValidate(s, { a: { v: true }, b: { v: "nope" } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]!.path).toBe("b.v")
    }
  })

  it("root-level scalar error path is 'root'", () => {
    const result = tryValidate(Schema.string(), 42)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]!.path).toBe("root")
    }
  })

  it("root-level product error path is 'root'", () => {
    const result = tryValidate(Schema.struct({ x: Schema.number() }), "nope")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]!.path).toBe("root")
    }
  })
})