// ═══════════════════════════════════════════════════════════════════════════
//
//   @kyneta/schema — Advanced: The Composition Algebra
//
//   Under the hood of @kyneta/schema/basic. This example shows how the
//   interpreter stack decomposes into five composable layers and how
//   you can mix and match them for custom use cases.
//
//   If you're looking to get started, see example/basic/ instead.
//
//   Run with:  bun run example/advanced/main.ts   (from packages/schema/)
//
// ═══════════════════════════════════════════════════════════════════════════

import type {
  AnnotatedSchema,
  Changeset,
  Op,
  Ref,
  RRef,
  Schema as SchemaType,
  Seed,
} from "../../src/index.js"
import {
  applyChanges,
  change,
  changefeed,
  describe,
  formatPath,
  hasChangefeed,
  hasComposedChangefeed,
  hasTransact,
  incrementChange,
  interpret,
  plainSubstrateFactory,
  readable,
  Schema,
  SchemaValidationError,
  sequenceChange,
  stepIncrement,
  stepSequence,
  stepText,
  subscribe,
  subscribeNode,
  textChange,
  tryValidate,
  validate,
  writable,
} from "../../src/index.js"

import { json, log, section } from "../helpers.js"

// ═══════════════════════════════════════════════════════════════════════════
//   1. THE SCHEMA (same as basic, for continuity)
// ═══════════════════════════════════════════════════════════════════════════

section(1, "The Schema (same as basic, for continuity)")

const ProjectSchema = Schema.doc({
  name: Schema.annotated("text"),
  stars: Schema.annotated("counter"),
  tasks: Schema.list(
    Schema.struct({
      title: Schema.string(),
      done: Schema.boolean(),
      priority: Schema.number(1, 2, 3),
    }),
  ),
  settings: Schema.struct({
    darkMode: Schema.boolean(),
    fontSize: Schema.number(),
  }),
  content: Schema.discriminatedUnion("type", [
    Schema.struct({
      type: Schema.string("text"),
      body: Schema.annotated("text"),
    }),
    Schema.struct({
      type: Schema.string("image"),
      url: Schema.string(),
      caption: Schema.annotated("text"),
    }),
  ]),
  bio: Schema.nullable(Schema.string()),
  labels: Schema.record(Schema.string()),
})

log(describe(ProjectSchema))

// ═══════════════════════════════════════════════════════════════════════════
//   2. CONSTRUCTING createDoc BY HAND
// ═══════════════════════════════════════════════════════════════════════════

section(2, "Constructing createDoc by Hand")

log(`
    In the basic example, createDoc is a black box. Here we open it up.

    Step 1: plainSubstrateFactory.create(schema, seed)   → substrate
    Step 2: substrate.context()                          → WritableContext
    Step 3: interpret(schema, ctx)
              .with(readable)     // navigation + reading + caching
              .with(writable)     // .set, .insert, .increment
              .with(changefeed)   // subscribe / subscribeNode
              .done()

    Each .with() appends a transformer. .done() composes left-to-right
    starting from bottomInterpreter, then runs the catamorphism.
`)

const substrate = plainSubstrateFactory.create(ProjectSchema, {
  name: "Schema Algebra",
  content: { type: "text" as const, body: "A unified recursive grammar" },
} satisfies Seed<typeof ProjectSchema>)

const ctx = substrate.context()

const doc: Ref<typeof ProjectSchema> = interpret(ProjectSchema, ctx)
  .with(readable)
  .with(writable)
  .with(changefeed)
  .done() as any

log(`    doc.name() → "${doc.name()}"    doc.stars() → ${doc.stars()}`)

// ═══════════════════════════════════════════════════════════════════════════
//   3. QUICK MUTATIONS (brief recap)
// ═══════════════════════════════════════════════════════════════════════════

section(3, "Quick Mutations (brief recap)")

doc.name.insert(doc.name().length, " v2")
doc.stars.increment(42)
doc.tasks.push({ title: "Design the grammar", done: true, priority: 1 })
doc.tasks.push({ title: "Implement catamorphism", done: false, priority: 2 })
doc.settings.set({ darkMode: true, fontSize: 16 })
doc.labels.set("bug", "red")

log(`
    doc.name() → "${doc.name()}"
    doc.stars() → ${doc.stars()}
    doc.tasks.length → ${doc.tasks.length}
    doc.settings.darkMode() → ${doc.settings.darkMode()}
    doc.labels.keys() → [${doc.labels.keys().map((k: string) => `"${k}"`).join(", ")}]
`)

// ═══════════════════════════════════════════════════════════════════════════
//   4. THE FIVE LAYERS
// ═══════════════════════════════════════════════════════════════════════════

section(4, "The Five Layers")

log(`
    ┌─────────────┬──────────────────────────────────────────────────────┐
    │ Layer       │ What it adds                                        │
    ├─────────────┼──────────────────────────────────────────────────────┤
    │ bottom      │ Function-shaped carriers with [CALL] slot           │
    │ navigation  │ Structural addressing (field getters, .at(), .keys) │
    │ readable    │ [CALL] filled with store reader + caching           │
    │ writable    │ .set(), .insert(), .increment(), .delete()          │
    │ changefeed  │ [CHANGEFEED] protocol — subscribe / subscribeNode   │
    └─────────────┴──────────────────────────────────────────────────────┘

    Fluent:  .with(readable).with(writable).with(changefeed).done()

    The 'readable' layer itself composes three sub-transformers:
      withCaching(withReadable(withNavigation(base)))

    Full manual expansion:
      withChangefeed(withWritable(withCaching(withReadable(withNavigation(bottomInterpreter)))))
`)

// ═══════════════════════════════════════════════════════════════════════════
//   5. READ-ONLY DOCUMENTS
// ═══════════════════════════════════════════════════════════════════════════

section(5, "Read-Only Documents")

log(`
    Drop layers to shed capabilities — not permissions, entire code paths.
`)

{
  const roStore = doc() as Record<string, unknown>
  const roDoc: RRef<typeof ProjectSchema> = interpret(ProjectSchema, { store: roStore })
    .with(readable)
    .done()

  log(`
    const roDoc = interpret(schema, { store }).with(readable).done()

    roDoc.name() → "${roDoc.name()}"
    roDoc.tasks.at(0)?.title() → "${roDoc.tasks.at(0)?.title()}"

    "set" in roDoc.stars → ${"set" in roDoc.stars}  (absent, not disabled)
    "insert" in roDoc.name → ${"insert" in roDoc.name}
    hasChangefeed(roDoc) → ${hasChangefeed(roDoc)}
    hasTransact(roDoc) → ${hasTransact(roDoc)}
  `)
}

// ═══════════════════════════════════════════════════════════════════════════
//   6. REFERENTIAL IDENTITY AND CACHING
// ═══════════════════════════════════════════════════════════════════════════

section(6, "Referential Identity and Caching")

log(`
    withCaching (included in 'readable') ensures repeated field access
    returns the same object identity — critical for React memoization.

    doc.name === doc.name → ${doc.name === doc.name}
    doc.settings === doc.settings → ${doc.settings === doc.settings}
    doc.tasks.at(0) === doc.tasks.at(0) → ${doc.tasks.at(0) === doc.tasks.at(0)}

    Namespace isolation — only schema fields appear:
    Object.keys(doc) → [${Object.keys(doc).map(k => `"${k}"`).join(", ")}]

    Symbol-keyed hooks (CALL, INVALIDATE, TRANSACT, CHANGEFEED)
    are invisible to Object.keys, JSON.stringify, and for..in.
`)

// ═══════════════════════════════════════════════════════════════════════════
//   7. SYMBOL-KEYED HOOKS
// ═══════════════════════════════════════════════════════════════════════════

section(7, "Symbol-Keyed Hooks")

log(`
    ┌──────────────────┬───────────────────────────────────────────────┐
    │ Symbol           │ Purpose                                       │
    ├──────────────────┼───────────────────────────────────────────────┤
    │ [CALL]           │ Controls what carrier() does (read from store)│
    │ [INVALIDATE]     │ Change-driven cache invalidation              │
    │ [TRANSACT]       │ Context discovery from any ref                │
    │ [CHANGEFEED]     │ Observation coalgebra (Moore machine)         │
    └──────────────────┴───────────────────────────────────────────────┘

    All use Symbol.for("kyneta:...") for cross-bundle identity.

    hasChangefeed(doc) → ${hasChangefeed(doc)}
    hasComposedChangefeed(doc) → ${hasComposedChangefeed(doc)}  (product — tree-level subscribe)
    hasComposedChangefeed(doc.settings) → ${hasComposedChangefeed(doc.settings)}  (product)
    hasComposedChangefeed(doc.name) → ${hasComposedChangefeed(doc.name)}  (leaf — subscribeNode only)
    hasTransact(doc) → ${hasTransact(doc)}  (writable installed [TRANSACT])
`)

// Demonstrate TRANSACT discovery
const ops = change(doc, d => { d.stars.increment(1) })

log(`
    change(doc, d => d.stars.increment(1)) → ${ops.length} op
    change() found WritableContext via doc[TRANSACT].
    No WeakMap, no global registry — just symbol-keyed discovery.
`)

// ═══════════════════════════════════════════════════════════════════════════
//   8. PURE STATE TRANSITIONS WITH step
// ═══════════════════════════════════════════════════════════════════════════

section(8, "Pure State Transitions with step")

log(`
    step(state, change) → newState — pure functions, no interpreter needed.
    The lowest level of the algebra: just data in, data out.
`)

// stepText
const text1 = stepText("Hello", textChange([{ retain: 5 }, { insert: " World" }]))
const text2 = stepText(text1, textChange([{ insert: "¡" }]))
const text3 = stepText(text2, textChange([{ retain: text2.length }, { insert: "!" }]))

log(`
    stepText("Hello",  [retain 5, insert " World"]) → "${text1}"
    stepText("${text1}", [insert "¡"])                → "${text2}"
    stepText("${text2}", [retain ${text2.length}, insert "!"])   → "${text3}"
`)

// stepSequence
const seq = stepSequence(
  [1, 2, 3, 4, 5],
  sequenceChange([{ retain: 1 }, { insert: [10, 20] }, { delete: 1 }]),
)

log(`    stepSequence([1,2,3,4,5], [retain 1, insert [10,20], delete 1]) → [${seq.join(", ")}]`)

// stepIncrement
const c1 = stepIncrement(42, incrementChange(8))
const c2 = stepIncrement(c1, incrementChange(-5))

log(`
    stepIncrement(42, incrementChange(8))  → ${c1}
    stepIncrement(${c1}, incrementChange(-5)) → ${c2}

    Same change types used by .insert(), .push(), .increment() —
    applied as pure functions without interpreter machinery.
`)

// ═══════════════════════════════════════════════════════════════════════════
//   9. COMPOSING CUSTOM STACKS
// ═══════════════════════════════════════════════════════════════════════════

section(9, "Composing Custom Stacks")

log(`
    Mix and match layers for your use case:
`)

{
  // Pure read-only
  const roSubstrate = plainSubstrateFactory.create(ProjectSchema, {
    name: "Snapshot",
    content: { type: "text" as const, body: "" },
  } satisfies Seed<typeof ProjectSchema>)

  const pureReadOnly: RRef<typeof ProjectSchema> = interpret(
    ProjectSchema, roSubstrate.context(),
  ).with(readable).done()

  log(`
    readable only:
      pureReadOnly.name() → "${pureReadOnly.name()}"
      "set" in pureReadOnly.name → ${"set" in pureReadOnly.name}
      hasTransact(pureReadOnly) → ${hasTransact(pureReadOnly)}
  `)

  // Full reactive replica — can receive external ops
  const replicaSub = plainSubstrateFactory.create(ProjectSchema, {
    name: "Replica",
    content: { type: "text" as const, body: "" },
  } satisfies Seed<typeof ProjectSchema>)

  const replicaDoc: Ref<typeof ProjectSchema> = interpret(
    ProjectSchema, replicaSub.context(),
  ).with(readable).with(writable).with(changefeed).done() as any

  const events: string[] = []
  subscribe(replicaDoc, cs => {
    for (const e of cs.changes) events.push(formatPath(e.path))
  })

  applyChanges(replicaDoc, [
    { path: [{ type: "key" as const, key: "name" }], change: textChange([{ insert: "✨ " }]) },
  ], { origin: "external" })

  log(`
    readable + writable + changefeed (reactive replica):
      After applyChanges(replicaDoc, [...], { origin: "external" }):
        events → [${events.map(e => `"${e}"`).join(", ")}]
        replicaDoc.name() → "${replicaDoc.name()}"

    Note: applyChanges() requires [TRANSACT] — writable must be present
    for any doc that receives external ops.
  `)
}

log(`
    Stack cheat sheet:
      readable                           → snapshot rendering, validation
      readable + writable                → local mutation, no observation
      readable + writable + changefeed   → full reactive document (default)
`)

// ═══════════════════════════════════════════════════════════════════════════
//   10. THE ROUND-TRIP AT THE ALGEBRA LEVEL
// ═══════════════════════════════════════════════════════════════════════════

section(10, "The Round-Trip at the Algebra Level")

log(`
    change() captures Ops. applyChanges() replays them on any doc.
    Ops are (Path, Change) pairs — no reference to originating interpreter.
`)

{
  const seed = {
    name: "Sync Demo",
    content: { type: "text" as const, body: "" },
  } satisfies Seed<typeof ProjectSchema>

  const subA = plainSubstrateFactory.create(ProjectSchema, seed)
  const docA: Ref<typeof ProjectSchema> = interpret(ProjectSchema, subA.context())
    .with(readable).with(writable).with(changefeed).done() as any

  const subB = plainSubstrateFactory.create(ProjectSchema, seed)
  const docB: Ref<typeof ProjectSchema> = interpret(ProjectSchema, subB.context())
    .with(readable).with(writable).with(changefeed).done() as any

  const syncOps = change(docA, d => {
    d.name.insert(d.name().length, " (synced)")
    d.stars.increment(100)
    d.tasks.push({ title: "Synced task", done: false, priority: 1 })
  })

  applyChanges(docB, syncOps, { origin: "sync" })

  log(`
    change(docA, ...) → ${syncOps.length} ops
    applyChanges(docB, ops, { origin: "sync" })

    docA() deep-equals docB() → ${json(docA()) === json(docB())} ✓
    docB.name() → "${docB.name()}"
    docB.stars() → ${docB.stars()}

    Ops are the universal currency — capture anywhere, apply anywhere.
  `)
}

// ═══════════════════════════════════════════════════════════════════════════
//   11. FINAL SNAPSHOT
// ═══════════════════════════════════════════════════════════════════════════

section(11, "Final Snapshot")

log(
  `doc() →\n${json(doc())
    .split("\n")
    .map((l: string) => `    ${l}`)
    .join("\n")}`,
)

log(`
    ─────────────────────────────────────────────────────────
    Summary: The composition algebra gives you precise control.

    • Need read-only?       .with(readable).done()
    • Need mutation?        .with(readable).with(writable).done()
    • Need observation?     Add .with(changefeed)
    • Need custom layers?   Implement InterpreterLayer and .with() it

    Every combination is valid. Capabilities compose, not configure.
    ─────────────────────────────────────────────────────────
`)