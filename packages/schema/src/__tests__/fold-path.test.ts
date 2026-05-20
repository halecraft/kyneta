// fold-path — invariant tests for the schema-guided path fold.
//
// Coverage is invariant-focused (the two semantic rules `foldPath` enforces:
// identity-keying at `seg.role === "field"` only, and sum-boundary
// short-circuit) and key-construction (`extendSchemaPathKey`) with a
// round-trip pin against `deriveSchemaBinding` so the writer/reader
// contract for binding keys is verified end-to-end.

import { describe, expect, it } from "vitest"
import {
  deriveSchemaBinding,
  extendSchemaPathKey,
  foldPath,
  KIND,
  type PathStepper,
  pathSchema,
  RawPath,
  Schema,
} from "../index.js"

// ---------------------------------------------------------------------------
// extendSchemaPathKey
// ---------------------------------------------------------------------------

describe("extendSchemaPathKey", () => {
  it("empty prev produces just the segment", () => {
    expect(extendSchemaPathKey("", "title")).toBe("title")
  })

  it("non-empty prev produces dot-joined", () => {
    expect(extendSchemaPathKey("a", "b")).toBe("a.b")
  })

  it("chains via reduce", () => {
    const key = ["a", "b", "c"].reduce(extendSchemaPathKey, "")
    expect(key).toBe("a.b.c")
  })
})

// ---------------------------------------------------------------------------
// foldPath — invariants
// ---------------------------------------------------------------------------

describe("foldPath", () => {
  // ── empty path ────────────────────────────────────────────────────────
  it("empty path returns root unchanged with zero stepper calls", () => {
    const schema = Schema.struct({ title: Schema.string() })
    const root = { sentinel: true }
    const calls: unknown[] = []
    const stepper: PathStepper = (...args) => {
      calls.push(args)
      return undefined
    }
    const result = foldPath(root, schema, RawPath.empty, stepper)
    expect(result.resolved).toBe(root)
    expect(result.schema).toBe(schema)
    expect(calls).toHaveLength(0)
  })

  // ── identity-keying: field role looks up, entry role does not ──────────
  it("identity is looked up at field segments and undefined at entry/index", () => {
    const schema = Schema.struct({
      members: Schema.record(Schema.string()),
    })
    const path = RawPath.empty.field("members").entry("alice")
    const binding = deriveSchemaBinding(schema, {})

    const seen: Array<{ role: string; identity: string | undefined }> = []
    const stepper: PathStepper = (_current, _nextSchema, seg, identity) => {
      seen.push({ role: seg.role, identity })
      return undefined
    }
    foldPath(undefined, schema, path, stepper, binding)

    expect(seen).toHaveLength(2)
    expect(seen[0]?.role).toBe("field")
    expect(seen[0]?.identity).toBeDefined()
    // The first step's identity must match what deriveSchemaBinding wrote
    // under the key "members" — this is the writer/reader contract.
    expect(seen[0]?.identity).toBe(binding.forward.get("members"))
    expect(seen[1]?.role).toBe("entry")
    expect(seen[1]?.identity).toBeUndefined()
  })

  it("no binding → all steps receive identity=undefined", () => {
    const schema = Schema.struct({ title: Schema.string() })
    const path = RawPath.empty.field("title")
    const seen: Array<string | undefined> = []
    const stepper: PathStepper = (_c, _n, _s, identity) => {
      seen.push(identity)
      return undefined
    }
    foldPath(undefined, schema, path, stepper)
    expect(seen).toEqual([undefined])
  })

  it("nested product fields accumulate the absPath", () => {
    const schema = Schema.struct({
      settings: Schema.struct({ darkMode: Schema.boolean() }),
    })
    const binding = deriveSchemaBinding(schema, {})
    const path = RawPath.empty.field("settings").field("darkMode")

    const identities: Array<string | undefined> = []
    const stepper: PathStepper = (_c, _n, _s, identity) => {
      identities.push(identity)
      return undefined
    }
    foldPath(undefined, schema, path, stepper, binding)

    expect(identities[0]).toBe(binding.forward.get("settings"))
    expect(identities[1]).toBe(binding.forward.get("settings.darkMode"))
  })

  it("index segments do not extend absPath", () => {
    // Path: items[0].title — field, index, field. The index must not
    // contribute to the binding-lookup key, so the second field looks
    // up "items.title", not "items.0.title".
    const schema = Schema.struct({
      items: Schema.list(Schema.struct({ title: Schema.string() })),
    })
    const binding = deriveSchemaBinding(schema, {})
    const path = RawPath.empty.field("items").item(0).field("title")

    // Sanity: deriveBindingRecursive only walks product→product, so
    // "items.title" is NOT a key the writer wrote — the reader looks it
    // up and correctly misses (identity undefined → stepper uses raw key).
    expect(binding.forward.has("items.title")).toBe(false)

    const seen: Array<{ role: string; identity: string | undefined }> = []
    const stepper: PathStepper = (_c, _n, seg, identity) => {
      seen.push({ role: seg.role, identity })
      return undefined
    }
    foldPath(undefined, schema, path, stepper, binding)
    expect(seen.map(s => s.role)).toEqual(["field", "index", "field"])
    expect(seen[0]?.identity).toBe(binding.forward.get("items"))
    expect(seen[1]?.identity).toBeUndefined() // index segment
    expect(seen[2]?.identity).toBeUndefined() // "items.title" was never written
  })

  // ── sum-boundary short-circuit ────────────────────────────────────────
  it("sum-boundary terminates the CRDT-aware fold", () => {
    // Positional union — `payload` is either a string OR a number (etc).
    // Once the fold lands on the sum schema, remaining segments descend
    // via plain-JS property access on the returned value.
    const schema = Schema.struct({
      payload: Schema.union(
        Schema.struct({ x: Schema.string() }),
        Schema.string(),
      ),
    })
    const path = RawPath.empty.field("payload").field("x")

    let callCount = 0
    // Stub return for the "payload" step — plain-JS descent into `.x`.
    const stepper: PathStepper = () => {
      callCount++
      return { x: "hello" }
    }
    const result = foldPath(undefined, schema, path, stepper)

    // Only the "payload" segment hits the stepper; the remaining segment
    // descends via plain-JS property access on the returned value.
    expect(callCount).toBe(1)
    expect(result.resolved).toBe("hello")
    expect(result.schema[KIND]).toBe("sum")
  })

  // ── value walk: stepper threading ──────────────────────────────────────
  it("threads `current` through the stepper", () => {
    const schema = Schema.struct({
      a: Schema.struct({ b: Schema.string() }),
    })
    const path = RawPath.empty.field("a").field("b")
    const trace: unknown[] = []
    const stepper: PathStepper = (current, _next, seg) => {
      trace.push(current)
      return { tag: seg.resolve() }
    }
    const result = foldPath({ tag: "root" }, schema, path, stepper)
    // First call sees the root; second call sees the stepper's previous return.
    expect(trace[0]).toEqual({ tag: "root" })
    expect(trace[1]).toEqual({ tag: "a" })
    expect(result.resolved).toEqual({ tag: "b" })
  })
})

// ---------------------------------------------------------------------------
// pathSchema — schema-only specialization
// ---------------------------------------------------------------------------

describe("pathSchema", () => {
  it("returns the schema at a path", () => {
    const schema = Schema.struct({
      settings: Schema.struct({ darkMode: Schema.boolean() }),
    })
    const path = RawPath.empty.field("settings").field("darkMode")
    const result = pathSchema(schema, path)
    expect(result[KIND]).toBe("scalar")
  })

  it("empty path returns the root schema", () => {
    const schema = Schema.struct({ title: Schema.string() })
    const result = pathSchema(schema, RawPath.empty)
    expect(result).toBe(schema)
  })

  it("sum-interior path returns the sum schema (variant cannot be determined without a value)", () => {
    const schema = Schema.struct({
      payload: Schema.union(
        Schema.struct({ x: Schema.string() }),
        Schema.string(),
      ),
    })
    const path = RawPath.empty.field("payload").field("x")
    const result = pathSchema(schema, path)
    expect(result[KIND]).toBe("sum")
  })
})

// ---------------------------------------------------------------------------
// Round-trip pin: writer (deriveSchemaBinding) and reader (foldPath) agree
// ---------------------------------------------------------------------------

describe("writer/reader contract on binding keys", () => {
  it("every binding-forward key foldPath constructs at field steps was written by deriveSchemaBinding", () => {
    const schema = Schema.struct({
      title: Schema.string(),
      settings: Schema.struct({
        darkMode: Schema.boolean(),
        fontSize: Schema.number(),
      }),
    })
    const binding = deriveSchemaBinding(schema, {})

    // Walk every product-field path foldPath would care about; assert
    // each corresponding binding lookup succeeds.
    const cases: Array<{
      path: ReturnType<typeof RawPath.empty.field>
      key: string
    }> = [
      { path: RawPath.empty.field("title"), key: "title" },
      { path: RawPath.empty.field("settings"), key: "settings" },
      {
        path: RawPath.empty.field("settings").field("darkMode"),
        key: "settings.darkMode",
      },
      {
        path: RawPath.empty.field("settings").field("fontSize"),
        key: "settings.fontSize",
      },
    ]

    for (const { path, key } of cases) {
      const observedIdentities: Array<string | undefined> = []
      const stepper: PathStepper = (_c, _n, _s, identity) => {
        observedIdentities.push(identity)
        return undefined
      }
      foldPath(undefined, schema, path, stepper, binding)
      // The terminal identity is what foldPath looked up for this path's
      // accumulated key — must match what deriveSchemaBinding wrote.
      const terminal = observedIdentities[observedIdentities.length - 1]
      expect(terminal).toBe(binding.forward.get(key))
      expect(terminal).toBeDefined()
    }
  })
})
