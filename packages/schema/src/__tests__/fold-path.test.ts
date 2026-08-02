// fold-path — tests for the one schema-guided traversal and its projections.
//
// Three things are covered. `walkPath` itself, one case per outcome. The two
// semantic invariants its projections inherit: identity-keying at
// `seg.role === "field"` only, and the opaque-boundary stop. And key
// construction (`extendSchemaPathKey`), round-tripped against
// `deriveSchemaBinding` so the writer/reader contract is verified end-to-end.
//
// The stepper-ordering tests deserve a note: nothing else in the repository
// pins WHEN `foldPath` stops calling the stepper, and both CRDT backends
// resolve every read through it. They exist so a plausible-looking
// simplification of the traversal fails here rather than in a backend.

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
  walkPath,
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

  // ── stepper call sequence at a boundary ───────────────────────────────
  //
  // These pin the exact sequence of stepper calls, not just how many. Both CRDT
  // backends supply the stepper (`stepIntoLoro` / `stepIntoYjs`) and every
  // substrate read routes through it, so a change to when `foldPath` stops
  // calling it silently changes what those backends resolve.
  //
  // The subtle part is that the stepper IS called for the segment that lands on
  // the boundary, and only then does the fold stop. Deciding to stop one step
  // earlier — say, by noticing the boundary before stepping rather than after —
  // would look equivalent while making `resolveYjsType` hand back the parent
  // container instead of the boundary value.

  it("steps INTO the sum, then stops", () => {
    const schema = Schema.struct({
      payload: Schema.union(
        Schema.struct({ x: Schema.string() }),
        Schema.string(),
      ),
    })
    const path = RawPath.empty.field("payload").field("x")

    const calls: Array<{ segment: unknown; schemaKind: unknown }> = []
    const stepper: PathStepper = (_current, nextSchema, seg) => {
      calls.push({ segment: seg.resolve(), schemaKind: nextSchema[KIND] })
      return { x: "hello" }
    }
    foldPath(undefined, schema, path, stepper)

    // One call, for the boundary segment itself, and it is handed the sum
    // schema — evidence the stop happens after the step, not before it.
    expect(calls).toEqual([{ segment: "payload", schemaKind: "sum" }])
  })

  it("steps INTO the json boundary, then stops", () => {
    const schema = Schema.struct({
      blob: Schema.struct.json({ a: Schema.string() }),
    })
    const path = RawPath.empty.field("blob").field("a")

    const calls: Array<{ segment: unknown; schemaKind: unknown }> = []
    const stepper: PathStepper = (_current, nextSchema, seg) => {
      calls.push({ segment: seg.resolve(), schemaKind: nextSchema[KIND] })
      return { a: "hello" }
    }
    const result = foldPath(undefined, schema, path, stepper)

    // A json boundary is a product carrying a marker, so the kind is "product"
    // — the boundary-ness comes from the marker, not the kind.
    expect(calls).toEqual([{ segment: "blob", schemaKind: "product" }])
    expect(result.resolved).toBe("hello")
  })

  it("walks every segment when no boundary is crossed", () => {
    const schema = Schema.struct({
      a: Schema.struct({ b: Schema.struct({ c: Schema.string() }) }),
    })
    const path = RawPath.empty.field("a").field("b").field("c")

    const calls: unknown[] = []
    const stepper: PathStepper = (_current, _next, seg) => {
      calls.push(seg.resolve())
      return {}
    }
    foldPath(undefined, schema, path, stepper)
    expect(calls).toEqual(["a", "b", "c"])
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

// ---------------------------------------------------------------------------
// walkPath — the traversal every other walker projects from
// ---------------------------------------------------------------------------
//
// One case per outcome. `boundary` gets the most attention because it is the
// case that used to be handled three different ways in three different walkers,
// and `consumed` is the number every projection does arithmetic on.

describe("walkPath", () => {
  const Inner = Schema.struct({
    from: Schema.number(),
    to: Schema.number().nullable(),
  })

  it("consumes every segment on an ordinary path", () => {
    const schema = Schema.struct({ a: Schema.struct({ b: Schema.string() }) })
    const walk = walkPath(
      undefined,
      schema,
      RawPath.empty.field("a").field("b"),
    )
    expect(walk.stop).toBe("complete")
    expect(walk.consumed).toBe(2)
  })

  it("empty path completes with zero steps", () => {
    const schema = Schema.struct({ a: Schema.string() })
    const walk = walkPath(undefined, schema, RawPath.empty)
    expect(walk.stop).toBe("complete")
    expect(walk.consumed).toBe(0)
    // Narrowing is required to reach `.schema` — `mismatch` does not carry one.
    // That is the union doing its job: you cannot read the result of a walk
    // without first acknowledging it might not have found anything.
    if (walk.stop !== "mismatch") expect(walk.schema).toBe(schema)
  })

  it("stops at a sum, counting the boundary segment as consumed", () => {
    const schema = Schema.struct({ v: Inner.nullable() })
    const walk = walkPath(
      undefined,
      schema,
      RawPath.empty.field("v").field("to"),
    )
    expect(walk.stop).toBe("boundary")
    // The boundary segment is consumed, so it sits at `consumed - 1` and the
    // segments still needing value-level resolution begin at `consumed`.
    expect(walk.consumed).toBe(1)
    if (walk.stop === "boundary") expect(walk.schema[KIND]).toBe("sum")
  })

  it("stops at a sum the path terminates on", () => {
    // Reported the same as an interior path. A `.json()` or nullable
    // collection has no container to mutate, so a `push` arrives here as a
    // change AT the boundary and still needs widening.
    const schema = Schema.struct({ v: Inner.nullable() })
    const walk = walkPath(undefined, schema, RawPath.empty.field("v"))
    expect(walk.stop).toBe("boundary")
    expect(walk.consumed).toBe(1)
  })

  it("stops at a .json() node", () => {
    const schema = Schema.struct({
      blob: Schema.struct.json({ a: Schema.string() }),
    })
    const walk = walkPath(
      undefined,
      schema,
      RawPath.empty.field("blob").field("a"),
    )
    expect(walk.stop).toBe("boundary")
    expect(walk.consumed).toBe(1)
  })

  it("stops at whichever boundary comes first", () => {
    // A `.json()` node inside a sum's variant. The sum is nearer the root and
    // is the node actually stored in the container, so the json node inside it
    // has no independent existence to stop at.
    const schema = Schema.struct({
      v: Schema.struct({
        blob: Schema.struct.json({ a: Schema.string() }),
      }).nullable(),
    })
    const walk = walkPath(
      undefined,
      schema,
      RawPath.empty.field("v").field("blob").field("a"),
    )
    expect(walk.stop).toBe("boundary")
    expect(walk.consumed).toBe(1)
    if (walk.stop === "boundary") expect(walk.schema[KIND]).toBe("sum")
  })

  it("reports a boundary reached through a container", () => {
    // `consumed - 1` is what callers slice the parent path on. Every case above
    // lands at index 0, which is also what an off-by-one would produce.
    const schema = Schema.struct({ items: Schema.list(Inner.nullable()) })
    const walk = walkPath(
      undefined,
      schema,
      RawPath.empty.field("items").item(0).field("to"),
    )
    expect(walk.stop).toBe("boundary")
    expect(walk.consumed).toBe(2)
  })

  it("reports a mismatch instead of throwing", () => {
    const schema = Schema.struct({ a: Schema.string() })
    const walk = walkPath(undefined, schema, RawPath.empty.field("nope"))
    expect(walk.stop).toBe("mismatch")
    expect(walk.consumed).toBe(0)
    if (walk.stop === "mismatch") {
      expect(walk.reason).toContain('has no field "nope"')
    }
  })

  it("reports a mismatch for a path running past a leaf", () => {
    const schema = Schema.struct({ a: Schema.string() })
    const walk = walkPath(
      undefined,
      schema,
      RawPath.empty.field("a").field("b"),
    )
    expect(walk.stop).toBe("mismatch")
    expect(walk.consumed).toBe(1)
  })

  it("never throws, however deep a path runs past a sum", () => {
    // The regression pin, and the reported crash: a path running past a sum
    // must not raise. Descending into the sum instead of reporting a boundary
    // is what made it raise.
    const schema = Schema.struct({ v: Inner.nullable() })
    const deep = RawPath.empty.field("v").field("to").field("a").field("b")
    expect(() => walkPath(undefined, schema, deep)).not.toThrow()
  })
})
