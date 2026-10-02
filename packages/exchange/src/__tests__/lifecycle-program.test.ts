// lifecycle-program.test.ts — a document's lifecycle, as a pure table.
//
// Every test feeds inputs to `lifecycleProgram.update` and asserts on the
// model and effects it returns. No Runtime, no substrates, no store.

import { type BoundSchema, json, Schema } from "@kyneta/schema"
import type { DocId } from "@kyneta/transport"
import { describe, expect, it } from "vitest"
import {
  type BuildSpec,
  CREATE,
  currentGen,
  deferredIds,
  type HeldLifecycle,
  hydrationOf,
  initialLifecycle,
  type Lifecycle,
  type LifecycleEffect,
  type LifecycleInput,
  type LifecycleModel,
  lifecycleProgram,
  metadataOfSpec,
  NotHeldError,
  phaseOf,
  type Tier,
  unloadingOf,
} from "../lifecycle-program.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOC: DocId = "doc"
const Todo = json.bind(Schema.struct({ title: Schema.string() }))
const Other = json.bind(Schema.struct({ count: Schema.number() }))
const replica = json.replica()

const specs = {
  interpret: { tier: "interpret", bound: Todo, from: "hydration" },
  replicate: {
    tier: "replicate",
    replicaFactory: replica.factory,
    syncMode: replica.syncMode,
    schemaHash: Todo.schemaHash,
  },
} as const satisfies Record<Tier, BuildSpec>

type Step = [LifecycleModel, ...LifecycleEffect[]]

function step(model: LifecycleModel, input: LifecycleInput): Step {
  return lifecycleProgram.update(input, model)
}

/** Feed inputs in order; the final model and the last step's effects. */
function run(model: LifecycleModel, ...inputs: LifecycleInput[]): Step {
  let result: Step = [model]
  for (const input of inputs) result = step(result[0], input)
  return result
}

function effectsOf(result: Step): LifecycleEffect[] {
  const [, ...effects] = result
  return effects
}

function types(result: Step): string[] {
  return effectsOf(result).map(effect => effect.type)
}

function model(
  entry: Lifecycle | undefined,
  { hasStore = true, hooked = true } = {},
): LifecycleModel {
  const base = initialLifecycle(hasStore)
  const docs = new Map<DocId, Lifecycle>()
  if (entry !== undefined) docs.set(DOC, entry)
  return { ...base, docs, hooked, nextGen: 1 }
}

function held(tier: Tier, suspended = false) {
  return { gen: 0, spec: specs[tier], suspended }
}

type Phase<P extends Lifecycle["phase"]> = Extract<Lifecycle, { phase: P }>

const loading = (tier: Tier, suspended = false): Phase<"loading"> => ({
  phase: "loading",
  intent: CREATE,
  ...held(tier, suspended),
})
const ready = (tier: Tier, suspended = false): Phase<"ready"> => ({
  phase: "ready",
  registered: true,
  writer: null,
  ...held(tier, suspended),
})
const failed = (tier: Tier, suspended = false): Phase<"failed"> => ({
  phase: "failed",
  error: new Error("disk unreadable"),
  ...held(tier, suspended),
})
const unloading = (
  tier: Tier,
  stage: "storing" | "leaving",
  { suspended = false, registered = true } = {},
): Phase<"unloading"> => ({
  phase: "unloading",
  stage,
  registered,
  writer: null,
  ...held(tier, suspended),
})
const unloaded = (tier: Tier, suspended = false): Phase<"unloaded"> => ({
  phase: "unloaded",
  spec: specs[tier],
  suspended,
})

const get = (
  intent: "create" | "open",
  bound: BoundSchema = Todo,
): LifecycleInput => ({ type: "get", docId: DOC, bound, intent })

const replicateInput: LifecycleInput = {
  type: "replicate",
  docId: DOC,
  replicaFactory: replica.factory,
  syncMode: replica.syncMode,
  schemaHash: Todo.schemaHash,
}

const loaded = (
  gen: number,
  outcome: Extract<LifecycleInput, { type: "loaded" }>["outcome"],
  writer: string | null = null,
): LifecycleInput => ({ type: "loaded", docId: DOC, gen, outcome, writer })

const loadFailed = (gen: number, error: unknown = "io"): LifecycleInput => ({
  type: "load-failed",
  docId: DOC,
  gen,
  error,
})

const released = (gen: number, version = "L:9"): LifecycleInput => ({
  type: "released",
  docId: DOC,
  gen,
  version,
})

const left = (gen: number): LifecycleInput => ({
  type: "left",
  docId: DOC,
  gen,
})

const unload: LifecycleInput = { type: "unload", docId: DOC }

/** One sample of every phase, in each tier, suspended or not. */
const phases = {
  absent: [undefined],
  deferred: [{ phase: "deferred" }],
  loading: [
    loading("interpret"),
    loading("replicate"),
    loading("interpret", true),
  ],
  ready: [ready("interpret"), ready("replicate"), ready("replicate", true)],
  failed: [failed("interpret"), failed("replicate"), failed("interpret", true)],
  unloading: [
    unloading("interpret", "storing"),
    unloading("replicate", "storing", { suspended: true }),
    unloading("interpret", "storing", { registered: false }),
    unloading("interpret", "leaving"),
    unloading("replicate", "leaving"),
  ],
  unloaded: [unloaded("interpret"), unloaded("replicate", true)],
} satisfies Record<Lifecycle["phase"] | "absent", (Lifecycle | undefined)[]>

/** Samples of every input, each current and stale where it has a generation. */
const inputs = {
  get: [get("create"), get("open"), get("create", Other), get("open", Other)],
  replicate: [replicateInput],
  defer: [{ type: "defer", docId: DOC }],
  destroy: [{ type: "destroy", docId: DOC }],
  suspend: [{ type: "suspend", docId: DOC }],
  resume: [{ type: "resume", docId: DOC }],
  hooked: [{ type: "hooked" }],
  "close-all": [{ type: "close-all", reason: "disposed" }],
  loaded: [
    loaded(0, { kind: "stored", version: "L:1" }),
    loaded(0, { kind: "empty" }),
    loaded(0, { kind: "none" }),
    loaded(7, { kind: "stored", version: "L:1" }),
  ],
  "load-failed": [loadFailed(0), loadFailed(7)],
  unload: [unload],
  reload: [{ type: "reload", docId: DOC }],
  released: [released(0), released(7)],
  left: [left(0), left(7)],
} satisfies Record<LifecycleInput["type"], LifecycleInput[]>

const BEFORE_COMMIT = new Set(["refuse", "build"])

// ---------------------------------------------------------------------------
// Every input in every phase
// ---------------------------------------------------------------------------

describe("every input in every phase", () => {
  const rows = Object.entries(phases).flatMap(([phase, entries]) =>
    entries.flatMap(entry =>
      Object.values(inputs).flatMap(samples =>
        samples.flatMap(input =>
          [true, false].map(hasStore => ({ phase, entry, input, hasStore })),
        ),
      ),
    ),
  )

  it.each(rows)("$phase × $input.type (store: $hasStore)", ({
    entry,
    input,
    hasStore,
  }) => {
    const before = model(entry, { hasStore })
    const snapshot = new Map(before.docs)
    const result = step(before, input as LifecycleInput)
    const [next] = result
    const effects = effectsOf(result)

    expect(next.docs).toBeInstanceOf(Map)
    // Pure: the model it was given is untouched.
    expect(before.docs).toEqual(snapshot)
    // What can fail leads; a refusal stands alone and changes nothing.
    const firstAfter = effects.findIndex(e => !BEFORE_COMMIT.has(e.type))
    const lastBefore = effects.findLastIndex(e => BEFORE_COMMIT.has(e.type))
    if (firstAfter !== -1) expect(lastBefore).toBeLessThan(firstAfter)
    if (effects.some(e => e.type === "refuse")) {
      expect(effects).toHaveLength(1)
      expect(next).toBe(before)
    }
    // Generations are never reused.
    expect(next.nextGen).toBeGreaterThanOrEqual(before.nextGen)
    for (const effect of effects) {
      if (effect.type === "build") expect(effect.gen).toBe(before.nextGen)
    }
  })
})

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe("get", () => {
  it("builds a stored document to load it", () => {
    const result = step(model(undefined), get("create"))
    expect(effectsOf(result)).toEqual([
      {
        type: "build",
        docId: DOC,
        gen: 1,
        spec: { tier: "interpret", bound: Todo, from: "hydration" },
      },
      { type: "interpreted", docId: DOC, gen: 1 },
      { type: "load", docId: DOC, gen: 1 },
    ])
    expect(result[0].docs.get(DOC)).toMatchObject({
      phase: "loading",
      gen: 1,
      intent: CREATE,
    })
    expect(result[0].nextGen).toBe(2)
  })

  it("makes a document with nothing to load ready at once", () => {
    const result = step(model(undefined, { hasStore: false }), get("create"))
    expect(types(result)).toEqual([
      "build",
      "interpreted",
      "adopt",
      "register",
      "wire",
    ])
    expect(result[0].docs.get(DOC)).toMatchObject({
      phase: "ready",
      registered: true,
    })
  })

  it("builds nothing for an `open` that can load nothing", () => {
    for (const entry of [undefined, { phase: "deferred" } as const]) {
      const before = model(entry, { hasStore: false })
      const result = step(before, get("open"))
      expect(effectsOf(result)).toEqual([])
      expect(result[0]).toBe(before)
    }
  })

  it("records the deferred entry an `open` replaces", () => {
    const [opened] = step(model({ phase: "deferred" }), get("open"))
    expect(opened.docs.get(DOC)).toMatchObject({
      phase: "loading",
      intent: { kind: "open", replaced: "deferred" },
    })
    const [fresh] = step(model(undefined), get("open"))
    expect(fresh.docs.get(DOC)).toMatchObject({
      intent: { kind: "open", replaced: undefined },
    })
  })

  it("turns a loading `open` into `create` for a `get`, and not for an `open`", () => {
    const [opened] = step(model(undefined), get("open"))
    const [kept, ...effects] = step(opened, get("create"))
    expect(effects).toEqual([])
    expect(kept.docs.get(DOC)).toMatchObject({ intent: CREATE })
    const [still] = step(opened, get("open"))
    expect(still).toBe(opened)
  })

  it("returns a held interpreted document, in any phase, as it is", () => {
    for (const entry of [ready("interpret"), failed("interpret")]) {
      const before = model(entry)
      const result = step(before, get("create"))
      expect(result).toEqual([before])
    }
  })

  it("refuses a schema that cannot read a held document", () => {
    for (const entry of [
      loading("interpret"),
      ready("interpret"),
      failed("interpret"),
      ready("replicate"),
    ]) {
      const [, refusal] = step(model(entry), get("create", Other))
      expect(refusal).toMatchObject({
        type: "refuse",
        refusal: {
          kind: "mismatch",
          docId: DOC,
          mismatch: { axis: "schemaHash" },
        },
      })
    }
  })

  it("refuses a replica still loading, and one whose load failed with its error", () => {
    expect(step(model(loading("replicate")), get("create"))).toEqual([
      model(loading("replicate")),
      { type: "refuse", refusal: { kind: "not-hydrated", docId: DOC } },
    ])
    const entry = failed("replicate")
    const [, refusal] = step(model(entry), get("create"))
    expect(refusal).toEqual({
      type: "refuse",
      refusal: {
        kind: "load-failed",
        docId: DOC,
        error: entry.error,
      },
    })
  })

  it("promotes a ready replica, carrying its writer and suspension, and closes nothing", () => {
    const replicated: Lifecycle = {
      ...ready("replicate", true),
      writer: "seat-a",
    }
    const result = step(model(replicated), get("open"))
    expect(effectsOf(result)).toEqual([
      {
        type: "build",
        docId: DOC,
        gen: 1,
        spec: { tier: "interpret", bound: Todo, from: { promote: 0 } },
      },
      { type: "interpreted", docId: DOC, gen: 1 },
      { type: "adopt", docId: DOC, gen: 1, writer: "seat-a" },
      { type: "register", docId: DOC, gen: 1, suspended: true },
      { type: "wire", docId: DOC, gen: 1 },
    ])
    expect(result[0].docs.get(DOC)).toMatchObject({
      phase: "ready",
      spec: { tier: "interpret", bound: Todo, from: { promote: 0 } },
      gen: 1,
      suspended: true,
      writer: "seat-a",
    })
  })
})

// ---------------------------------------------------------------------------
// The other requests
// ---------------------------------------------------------------------------

describe("replicate", () => {
  it("builds a replica for an absent or deferred document", () => {
    for (const entry of [undefined, { phase: "deferred" } as const]) {
      expect(types(step(model(entry), replicateInput))).toEqual([
        "build",
        "load",
      ])
      expect(
        types(step(model(entry, { hasStore: false }), replicateInput)),
      ).toEqual(["build", "register"])
    }
  })

  it("refuses a held document in any phase, naming its tier", () => {
    for (const entry of [
      ...phases.loading,
      ...phases.ready,
      ...phases.failed,
    ] as HeldLifecycle[]) {
      const [, refusal] = step(model(entry), replicateInput)
      expect(refusal).toEqual({
        type: "refuse",
        refusal: { kind: "already-held", docId: DOC, tier: entry.spec.tier },
      })
    }
  })
})

describe("defer", () => {
  it("records an absent document as deferred", () => {
    const [next] = step(model(undefined), { type: "defer", docId: DOC })
    expect(next.docs.get(DOC)).toEqual({ phase: "deferred" })
    expect(deferredIds(next)).toEqual(new Set([DOC]))
  })

  it("changes nothing for a document this Runtime holds", () => {
    for (const entry of [
      ...phases.loading,
      ...phases.ready,
      ...phases.failed,
    ]) {
      const before = model(entry)
      expect(step(before, { type: "defer", docId: DOC })).toEqual([before])
    }
  })
})

describe("destroy", () => {
  const destroy: LifecycleInput = { type: "destroy", docId: DOC }
  const deletes = (result: Step) =>
    effectsOf(result).some(
      e => e.type === "store" && e.input.type === "destroy",
    )

  it("deletes from the store for an absent, deferred, or stored held document", () => {
    expect(deletes(step(model(undefined, { hasStore: false }), destroy))).toBe(
      true,
    )
    expect(deletes(step(model({ phase: "deferred" }), destroy))).toBe(true)
    expect(deletes(step(model(ready("interpret")), destroy))).toBe(true)
  })

  it("does not for a held document that is never stored", () => {
    expect(
      deletes(step(model(ready("interpret"), { hasStore: false }), destroy)),
    ).toBe(false)
  })

  it("closes and disposes the instance, removes it, deletes, then tells", () => {
    const result = step(model(ready("interpret")), destroy)
    expect(effectsOf(result)).toEqual([
      {
        type: "close",
        docId: DOC,
        gen: 0,
        reason: "destroyed",
        hydration: { status: "loaded" },
      },
      { type: "dispose", docId: DOC, gen: 0, reason: "destroyed" },
      { type: "store", input: { type: "destroy", docId: DOC } },
      { type: "notify", docId: DOC, hook: "destroyed" },
    ])
    expect(result[0].docs.has(DOC)).toBe(false)
  })
})

describe("suspend and resume", () => {
  it("refuse a document not held, recording whether it was absent or deferred", () => {
    for (const door of ["suspend", "resume"] as const) {
      expect(
        step(model(undefined), { type: door, docId: DOC })[1],
      ).toMatchObject({ refusal: { kind: "not-held", door, phase: "absent" } })
      expect(
        step(model({ phase: "deferred" }), { type: door, docId: DOC })[1],
      ).toMatchObject({
        refusal: { kind: "not-held", door, phase: "deferred" },
      })
    }
  })

  it("suspend is idempotent, and resume refuses a document not suspended", () => {
    const before = model(ready("interpret", true))
    expect(step(before, { type: "suspend", docId: DOC })).toEqual([before])
    expect(
      step(model(ready("interpret")), { type: "resume", docId: DOC })[1],
    ).toEqual({
      type: "refuse",
      refusal: { kind: "not-suspended", docId: DOC },
    })
  })

  it("set the flag in any held phase, and tell", () => {
    const result = step(model(loading("interpret")), {
      type: "suspend",
      docId: DOC,
    })
    expect(result[0].docs.get(DOC)).toMatchObject({ suspended: true })
    expect(effectsOf(result)).toEqual([
      { type: "notify", docId: DOC, hook: "suspended" },
    ])
  })
})

describe("hooked", () => {
  it("registers only ready instances not yet registered", () => {
    const docs = new Map<DocId, Lifecycle>([
      ["a", { ...ready("interpret"), registered: false }],
      ["b", { ...ready("replicate"), gen: 1, registered: false }],
      ["c", { ...loading("interpret"), gen: 2 }],
      ["d", { ...failed("interpret"), gen: 3 }],
      ["e", { ...ready("interpret"), gen: 4 }],
      ["f", { phase: "deferred" }],
    ])
    const before = { ...model(undefined, { hooked: false }), docs }
    const result = step(before, { type: "hooked" })
    expect(effectsOf(result)).toEqual([
      { type: "register", docId: "a", gen: 0, suspended: false },
      { type: "register", docId: "b", gen: 1, suspended: false },
    ])
    expect(result[0].hooked).toBe(true)
    expect(result[0].docs.get("a")).toMatchObject({ registered: true })
  })

  it("withholds registration until hooks are set", () => {
    const unhooked = model(undefined, { hasStore: false, hooked: false })
    const result = step(unhooked, get("create"))
    expect(types(result)).toEqual(["build", "interpreted", "adopt", "wire"])
    expect(result[0].docs.get(DOC)).toMatchObject({ registered: false })
    expect(effectsOf(step(result[0], { type: "hooked" }))).toEqual([
      { type: "register", docId: DOC, gen: 1, suspended: false },
    ])
  })
})

describe("close-all", () => {
  it("closes every instance with its hydration, and empties the model", () => {
    const error = new Error("disk unreadable")
    const docs = new Map<DocId, Lifecycle>([
      ["a", ready("interpret")],
      ["b", { ...loading("replicate"), gen: 1 }],
      ["c", { phase: "deferred" }],
      ["d", { ...failed("interpret"), gen: 2, error }],
    ])
    const result = step(
      { ...model(undefined), docs },
      { type: "close-all", reason: "disposed" },
    )
    expect(effectsOf(result)).toEqual([
      {
        type: "close",
        docId: "a",
        gen: 0,
        reason: "disposed",
        hydration: { status: "loaded" },
      },
      { type: "dispose", docId: "a", gen: 0, reason: "disposed" },
      {
        type: "close",
        docId: "b",
        gen: 1,
        reason: "disposed",
        hydration: { status: "pending" },
      },
      { type: "dispose", docId: "b", gen: 1, reason: "disposed" },
      {
        type: "close",
        docId: "d",
        gen: 2,
        reason: "disposed",
        hydration: { status: "failed", error },
      },
      { type: "dispose", docId: "d", gen: 2, reason: "disposed" },
    ])
    expect(result[0].docs.size).toBe(0)
    expect(result[0].nextGen).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Completions
// ---------------------------------------------------------------------------

describe("stale completions change nothing", () => {
  const started = step(model(undefined), get("create"))[0]
  const gen = currentGen(started, DOC) ?? -1
  const after: Record<string, LifecycleModel> = {
    "a destroy": run(started, { type: "destroy", docId: DOC })[0],
    "a destroy then create": run(
      started,
      { type: "destroy", docId: DOC },
      get("create"),
    )[0],
    "a close-all": run(started, { type: "close-all", reason: "disposed" })[0],
  }

  it.each(Object.entries(after))("after %s", (_name, before) => {
    for (const input of [
      loaded(gen, { kind: "stored", version: "L:1" }),
      loadFailed(gen),
    ]) {
      expect(step(before, input)).toEqual([before])
    }
  })

  it("after a promotion", () => {
    const replicated = run(
      model(undefined, { hasStore: false }),
      replicateInput,
    )[0]
    const old = currentGen(replicated, DOC) ?? -1
    const promoted = step(replicated, get("create"))[0]
    expect(currentGen(promoted, DOC)).not.toBe(old)
    expect(step(promoted, loaded(old, { kind: "empty" }))).toEqual([promoted])
    expect(step(promoted, loadFailed(old))).toEqual([promoted])
  })
})

describe("finishing a load", () => {
  const started = (intent: "create" | "open", entry?: Lifecycle) =>
    step(model(entry), get(intent))[0]

  it("runs adopt, store, register and wire, in that order, for a stored load", () => {
    const result = step(
      started("create"),
      loaded(1, { kind: "stored", version: "L:3" }, "seat-a"),
    )
    expect(effectsOf(result)).toEqual([
      { type: "adopt", docId: DOC, gen: 1, writer: "seat-a" },
      {
        type: "store",
        input: { type: "hydrated", docId: DOC, version: "L:3" },
      },
      { type: "register", docId: DOC, gen: 1, suspended: false },
      { type: "wire", docId: DOC, gen: 1 },
    ])
    expect(result[0].docs.get(DOC)).toMatchObject({
      phase: "ready",
      writer: "seat-a",
      registered: true,
    })
  })

  it("registers an empty `create` with the store program", () => {
    const result = step(started("create"), loaded(1, { kind: "empty" }))
    expect(effectsOf(result)).toContainEqual({
      type: "store",
      input: { type: "register", docId: DOC },
    })
  })

  it("tells the store program nothing when nothing was loaded", () => {
    const result = step(started("create"), loaded(1, { kind: "none" }))
    expect(types(result)).toEqual(["adopt", "register", "wire"])
  })

  it("closes an empty `open`, restoring the deferred entry it replaced", () => {
    for (const [entry, restored] of [
      [{ phase: "deferred" } as const, { phase: "deferred" }],
      [undefined, undefined],
    ] as const) {
      for (const outcome of [{ kind: "empty" }, { kind: "none" }] as const) {
        const result = step(started("open", entry), loaded(1, outcome))
        expect(result[0].docs.get(DOC)).toEqual(restored)
        expect(effectsOf(result)).toEqual([
          {
            type: "close",
            docId: DOC,
            gen: 1,
            reason: "disposed",
            hydration: { status: "failed", error: new NotHeldError(DOC) },
          },
          { type: "dispose", docId: DOC, gen: 1, reason: "disposed" },
        ])
      }
    }
  })

  it("keeps a stored `open`", () => {
    const result = step(
      started("open"),
      loaded(1, { kind: "stored", version: "L:1" }),
    )
    expect(result[0].docs.get(DOC)).toMatchObject({ phase: "ready" })
  })

  it("records a failed load, held and never registered", () => {
    const error = new Error("disk unreadable")
    const result = step(started("create"), loadFailed(1, error))
    expect(effectsOf(result)).toEqual([])
    expect(result[0].docs.get(DOC)).toMatchObject({ phase: "failed", error })
    expect(hydrationOf(result[0], DOC)).toEqual({ status: "failed", error })
  })
})

describe("queries", () => {
  it("hydrationOf reads loaded for a document with nothing to load", () => {
    expect(hydrationOf(model(undefined), DOC)).toEqual({ status: "loaded" })
    expect(hydrationOf(model({ phase: "deferred" }), DOC)).toEqual({
      status: "loaded",
    })
    expect(hydrationOf(model(loading("interpret")), DOC)).toEqual({
      status: "pending",
    })
  })
})

// ---------------------------------------------------------------------------
// Unloading
// ---------------------------------------------------------------------------

describe("unload", () => {
  it("refuses a document it cannot let go of, by phase", () => {
    const rows: [Lifecycle | undefined, object, { hasStore?: boolean }][] = [
      [undefined, { kind: "not-held", door: "unload", phase: "absent" }, {}],
      [
        { phase: "deferred" },
        { kind: "not-held", door: "unload", phase: "deferred" },
        {},
      ],
      [loading("interpret"), { kind: "not-hydrated" }, {}],
      [failed("interpret"), { kind: "load-failed" }, {}],
      [ready("interpret"), { kind: "not-stored" }, { hasStore: false }],
    ]
    for (const [entry, refusal, options] of rows) {
      const before = model(entry, options)
      const result = step(before, unload)
      expect(result[0]).toBe(before)
      expect(effectsOf(result)).toMatchObject([
        { type: "refuse", refusal: { docId: DOC, ...refusal } },
      ])
    }
  })

  it("refuses a transient document", () => {
    const Live = json.bind(Schema.struct({ title: Schema.string() }))
    const transient: Lifecycle = {
      ...ready("interpret"),
      spec: {
        tier: "interpret",
        bound: {
          ...Live,
          syncMode: { ...Live.syncMode, durability: "transient" },
        } as BoundSchema,
        from: "empty",
      },
    }
    expect(step(model(transient), unload)[1]).toEqual({
      type: "refuse",
      refusal: { kind: "not-stored", docId: DOC },
    })
  })

  it("does nothing for a document already unloading or unloaded", () => {
    for (const entry of [...phases.unloading, ...phases.unloaded]) {
      const before = model(entry)
      expect(step(before, unload)).toEqual([before])
    }
  })

  it("drains, starts leaving, requests a write, then a release, in that order", () => {
    const result = step(model(ready("interpret")), unload)
    expect(effectsOf(result)).toEqual([
      { type: "drain", docId: DOC, gen: 0 },
      { type: "leaving", docId: DOC, on: true },
      { type: "store", input: { type: "state-advanced", docId: DOC } },
      { type: "store", input: { type: "release", docId: DOC, gen: 0 } },
    ])
    expect(result[0].docs.get(DOC)).toMatchObject({
      phase: "unloading",
      stage: "storing",
    })
    expect(unloadingOf(result[0], DOC, 0)).toBe(true)
    expect(hydrationOf(result[0], DOC)).toEqual({ status: "loaded" })
  })

  it("a replica drains nothing, and a suspended or unregistered one starts no leaving", () => {
    expect(types(step(model(ready("replicate")), unload))).toEqual([
      "leaving",
      "store",
      "store",
    ])
    expect(types(step(model(ready("interpret", true)), unload))).toEqual([
      "drain",
      "store",
      "store",
    ])
    const unregistered = { ...ready("interpret"), registered: false }
    expect(types(step(model(unregistered), unload))).toEqual([
      "drain",
      "store",
      "store",
    ])
  })
})

describe("released", () => {
  it("registered: leaving, then close, then leave", () => {
    const result = step(model(unloading("interpret", "storing")), released(0))
    expect(effectsOf(result)).toEqual([
      {
        type: "close",
        docId: DOC,
        gen: 0,
        reason: "unloaded",
        hydration: { status: "loaded" },
      },
      { type: "leave", docId: DOC, gen: 0 },
    ])
    expect(result[0].docs.get(DOC)).toMatchObject({
      phase: "unloading",
      stage: "leaving",
    })
  })

  it("never registered: close, dispose, and unloaded at once", () => {
    const entry = unloading("interpret", "storing", { registered: false })
    const result = step(model(entry), released(0))
    expect(types(result)).toEqual(["close", "dispose"])
    expect(result[0].docs.get(DOC)).toEqual({
      phase: "unloaded",
      spec: specs.interpret,
      suspended: false,
    })
  })

  it("ready (a door kept it in the same transition): handed back with hydrated", () => {
    const result = step(model(ready("interpret")), released(0, "L:5"))
    expect(effectsOf(result)).toEqual([
      {
        type: "store",
        input: { type: "hydrated", docId: DOC, version: "L:5" },
      },
    ])
  })

  it("stale, or in any other phase, changes nothing", () => {
    for (const entry of [
      unloading("interpret", "storing"),
      unloading("interpret", "leaving"),
      unloaded("interpret"),
      loading("interpret"),
    ]) {
      const before = model(entry)
      const stale = entry.phase === "unloading" ? released(7) : released(0)
      expect(step(before, stale)).toEqual([before])
    }
  })
})

describe("left", () => {
  it("current and leaving: dispose, and unloaded with the spec it loads from", () => {
    const promoted: Lifecycle = {
      ...unloading("interpret", "leaving", { suspended: true }),
      spec: { tier: "interpret", bound: Todo, from: { promote: 3 } },
    }
    const result = step(model(promoted), left(0))
    expect(effectsOf(result)).toEqual([
      { type: "dispose", docId: DOC, gen: 0, reason: "unloaded" },
    ])
    expect(result[0].docs.get(DOC)).toEqual({
      phase: "unloaded",
      spec: specs.interpret,
      suspended: true,
    })
  })

  it("a departing instance a door replaced: dispose that generation", () => {
    const [replaced] = step(
      model(unloading("interpret", "leaving")),
      get("create"),
    )
    expect(currentGen(replaced, DOC)).toBe(1)
    const result = step(replaced, left(0))
    expect(effectsOf(result)).toEqual([
      { type: "dispose", docId: DOC, gen: 0, reason: "unloaded" },
    ])
    expect(result[0].departing.size).toBe(0)
    expect(result[0].docs.get(DOC)).toMatchObject({ phase: "loading", gen: 1 })
  })
})

describe("doors during an unload", () => {
  it("get while storing cancels: keep, leaving off, and ready as it was", () => {
    for (const intent of ["create", "open"] as const) {
      const before = model(unloading("interpret", "storing"))
      const result = step(before, get(intent))
      expect(effectsOf(result)).toEqual([
        { type: "store", input: { type: "keep", docId: DOC } },
        { type: "leaving", docId: DOC, on: false },
      ])
      expect(result[0].docs.get(DOC)).toEqual(ready("interpret"))
      expect(unloadingOf(result[0], DOC, 0)).toBe(false)
    }
  })

  it("a cancel registers the way a load does, once hooks are set", () => {
    const entry = unloading("interpret", "storing", {
      suspended: true,
      registered: false,
    })
    const result = step(model(entry), get("create"))
    expect(effectsOf(result)).toEqual([
      { type: "store", input: { type: "keep", docId: DOC } },
      { type: "register", docId: DOC, gen: 0, suspended: true },
    ])
    expect(result[0].docs.get(DOC)).toMatchObject({
      phase: "ready",
      registered: true,
      suspended: true,
    })
    const unhooked = step(model(entry, { hooked: false }), get("create"))
    expect(types(unhooked)).toEqual(["store"])
  })

  it("a mismatching get refuses and leaves the unload in flight", () => {
    const before = model(unloading("interpret", "storing"))
    const result = step(before, get("create", Other))
    expect(result[0]).toBe(before)
    expect(types(result)).toEqual(["refuse"])
  })

  it("promoting an unloading replica cancels, then promotes, in one step", () => {
    const result = step(model(unloading("replicate", "storing")), get("create"))
    expect(types(result)).toEqual([
      "build",
      "store",
      "leaving",
      "interpreted",
      "adopt",
      "register",
      "wire",
    ])
    expect(result[0].docs.get(DOC)).toMatchObject({ phase: "ready", gen: 1 })
  })

  it("replicate refuses already-held in both stages, and commits nothing", () => {
    for (const stage of ["storing", "leaving"] as const) {
      const before = model(unloading("replicate", stage))
      const result = step(before, replicateInput)
      expect(result).toEqual([
        before,
        {
          type: "refuse",
          refusal: { kind: "already-held", docId: DOC, tier: "replicate" },
        },
      ])
    }
  })

  it("get while leaving loads a new instance, the departing one recorded", () => {
    const result = step(model(unloading("interpret", "leaving")), get("open"))
    expect(types(result)).toEqual(["build", "interpreted", "load"])
    expect(result[0].docs.get(DOC)).toMatchObject({
      phase: "loading",
      gen: 1,
      intent: { kind: "open", replaced: "unloaded" },
    })
    expect(result[0].departing).toEqual(new Map([[0, DOC]]))
  })

  it("get on unloaded loads with suspension carried, and refuses a mismatch", () => {
    const result = step(model(unloaded("replicate", true)), get("create"))
    expect(effectsOf(result)[0]).toEqual({
      type: "build",
      docId: DOC,
      gen: 1,
      spec: { tier: "interpret", bound: Todo, from: "hydration" },
    })
    expect(result[0].docs.get(DOC)).toMatchObject({
      phase: "loading",
      suspended: true,
      intent: CREATE,
    })
    expect(
      step(model(unloaded("interpret")), get("open", Other))[1],
    ).toMatchObject({
      type: "refuse",
      refusal: { kind: "mismatch" },
    })
  })

  it("replicate loads an unloaded replica again, and refuses an interpreted one", () => {
    const again = step(model(unloaded("replicate", true)), replicateInput)
    expect(types(again)).toEqual(["build", "load"])
    expect(again[0].docs.get(DOC)).toMatchObject({ suspended: true })
    expect(step(model(unloaded("interpret")), replicateInput)[1]).toEqual({
      type: "refuse",
      refusal: { kind: "already-held", docId: DOC, tier: "interpret" },
    })
  })

  it("reload loads an unloaded document as an open from its own spec, and elsewhere does nothing", () => {
    const reload: LifecycleInput = { type: "reload", docId: DOC }
    const result = step(model(unloaded("replicate")), reload)
    expect(effectsOf(result)[0]).toMatchObject({
      type: "build",
      spec: specs.replicate,
    })
    expect(result[0].docs.get(DOC)).toMatchObject({
      intent: { kind: "open", replaced: "unloaded" },
    })
    for (const entry of [undefined, ready("interpret"), ...phases.unloading]) {
      const before = model(entry)
      expect(step(before, reload)).toEqual([before])
    }
  })

  it("an open from unloaded that finds nothing removes the entry and tells, deleting nothing", () => {
    const [opened] = step(model(unloaded("interpret")), get("open"))
    const result = step(opened, loaded(1, { kind: "empty" }))
    expect(result[0].docs.has(DOC)).toBe(false)
    expect(types(result)).toEqual(["close", "dispose", "notify"])
    expect(effectsOf(result)[2]).toEqual({
      type: "notify",
      docId: DOC,
      hook: "destroyed",
    })
  })
})

describe("the other requests on an unloading or unloaded document", () => {
  it("destroy closes and disposes an unloading instance once, and deletes either", () => {
    const destroy: LifecycleInput = { type: "destroy", docId: DOC }
    expect(
      types(step(model(unloading("interpret", "storing")), destroy)),
    ).toEqual(["close", "dispose", "store", "notify"])
    expect(
      types(step(model(unloading("interpret", "leaving")), destroy)),
    ).toEqual(["dispose", "store", "notify"])
    expect(types(step(model(unloaded("interpret")), destroy))).toEqual([
      "store",
      "notify",
    ])
  })

  it("suspend and resume refuse unloading, and not-held on unloaded", () => {
    for (const door of ["suspend", "resume"] as const) {
      expect(
        step(model(unloading("interpret", "storing")), {
          type: door,
          docId: DOC,
        })[1],
      ).toEqual({
        type: "refuse",
        refusal: { kind: "unloading", docId: DOC, door },
      })
      expect(
        step(model(unloaded("interpret")), { type: door, docId: DOC })[1],
      ).toEqual({
        type: "refuse",
        refusal: { kind: "not-held", docId: DOC, door, phase: "unloaded" },
      })
    }
  })

  it("defer and hooked change nothing", () => {
    for (const entry of [...phases.unloading, ...phases.unloaded]) {
      const before = model(entry, { hooked: false })
      expect(step(before, { type: "defer", docId: DOC })).toEqual([before])
      expect(types(step(before, { type: "hooked" }))).toEqual([])
    }
  })

  it("close-all ends unloading and departing instances, and drops unloaded entries", () => {
    const docs = new Map<DocId, Lifecycle>([
      ["a", unloading("interpret", "storing")],
      ["b", { ...unloading("interpret", "leaving"), gen: 1 }],
      ["c", unloaded("interpret")],
    ])
    const before: LifecycleModel = {
      ...model(undefined),
      docs,
      departing: new Map([[2, "d"]]),
      nextGen: 3,
    }
    const result = step(before, { type: "close-all", reason: "disposed" })
    expect(
      effectsOf(result).map(e => [e.type, "docId" in e ? e.docId : undefined]),
    ).toEqual([
      ["close", "a"],
      ["dispose", "a"],
      ["dispose", "b"],
      ["dispose", "d"],
    ])
    expect(result[0].docs.size).toBe(0)
    expect(result[0].departing.size).toBe(0)
  })
})

describe("held phases", () => {
  it("an unloaded document holds no instance", () => {
    const before = model(unloaded("interpret"))
    expect(currentGen(before, DOC)).toBeUndefined()
    expect(phaseOf(before, DOC)).toBe("unloaded")
    expect(hydrationOf(before, DOC)).toEqual({ status: "loaded" })
    expect(deferredIds(before).size).toBe(0)
    expect(
      types(step(before, { type: "close-all", reason: "disposed" })),
    ).toEqual([])
  })

  it("metadataOfSpec gives the document's metadata for each tier", () => {
    const expected = {
      replicaType: Todo.replicaType,
      syncMode: Todo.syncMode,
      schemaHash: Todo.schemaHash,
    }
    expect(metadataOfSpec(specs.interpret)).toEqual(expected)
    expect(metadataOfSpec(specs.replicate)).toEqual({
      ...expected,
      replicaType: replica.factory.replicaType,
      syncMode: replica.syncMode,
    })
  })

  it("register carries suspension, for a load and for a promotion", () => {
    const [opened] = step(
      model({
        ...ready("interpret"),
        phase: "loading",
        intent: CREATE,
      } as Lifecycle),
      { type: "suspend", docId: DOC },
    )
    const loadedStep = step(
      opened,
      loaded(0, { kind: "stored", version: "L:1" }),
    )
    expect(effectsOf(loadedStep)).toContainEqual({
      type: "register",
      docId: DOC,
      gen: 0,
      suspended: true,
    })
    const promoted = step(model(ready("replicate", true)), get("create"))
    expect(effectsOf(promoted)).toContainEqual({
      type: "register",
      docId: DOC,
      gen: 1,
      suspended: true,
    })
  })

  it("unloadingOf: only the current instance, while it unloads", () => {
    const current = model(unloading("interpret", "storing"))
    expect(unloadingOf(current, DOC, 0)).toBe(true)
    expect(unloadingOf(current, DOC, 1)).toBe(false)
    expect(unloadingOf(model(ready("interpret")), DOC, 0)).toBe(false)
  })
})
