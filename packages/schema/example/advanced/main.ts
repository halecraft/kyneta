// ═══════════════════════════════════════════════════════════════════════════
//
//   @kyneta/schema — Advanced: Under the Hood
//
//   Under the hood of @kyneta/schema/basic. This example builds a document
//   by hand over a substrate, shows how its refs are made, writes a custom
//   interpreter for the schema catamorphism, and replays ops between
//   documents.
//
//   If you're looking to get started, see example/basic/ instead.
//
//   Run with:  bun run example/advanced/main.ts   (from packages/schema/)
//
// ═══════════════════════════════════════════════════════════════════════════

import { hasChangefeed } from "@kyneta/changefeed"
import type { Ref, RRef, Schema as SchemaNode } from "../../src/index.js"
import {
  applyChanges,
  batch,
  createInterpreter,
  createRef,
  describe,
  hasRecursiveChangefeed,
  hasTransact,
  incrementChange,
  interpret,
  plainSubstrateFactory,
  RawPath,
  Schema,
  sequenceChange,
  stepIncrement,
  stepSequence,
  stepText,
  subscribe,
  textChange,
} from "../../src/index.js"

import { json, log, section } from "../helpers.js"

// ═══════════════════════════════════════════════════════════════════════════
//   1. THE SCHEMA (same as basic, for continuity)
// ═══════════════════════════════════════════════════════════════════════════

section(1, "The Schema (same as basic, for continuity)")

const ProjectSchema = Schema.struct({
  name: Schema.text(),
  stars: Schema.counter(),
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
      body: Schema.string(),
    }),
    Schema.struct({
      type: Schema.string("image"),
      url: Schema.string(),
      caption: Schema.string(),
    }),
  ]),
  bio: Schema.string().nullable(),
  labels: Schema.record(Schema.string()),
})

log(describe(ProjectSchema))

// ═══════════════════════════════════════════════════════════════════════════
//   2. CONSTRUCTING createDoc BY HAND
// ═══════════════════════════════════════════════════════════════════════════

section(2, "Constructing createDoc by Hand")

log(`
    In the basic example, createDoc is a black box. Here we open it up.

    Step 1: plainSubstrateFactory.create(schema)   → substrate
    Step 2: createRef(schema, substrate)           → the document's root ref

    createRef makes the root ref over the substrate's writable context.
    Every other ref is made when you navigate to it.
`)

const substrate = plainSubstrateFactory.create(ProjectSchema)

const doc: Ref<typeof ProjectSchema> = createRef(ProjectSchema, substrate)

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
    doc.labels.keys() → [${doc.labels
      .keys()
      .map((k: string) => `"${k}"`)
      .join(", ")}]
`)

// ═══════════════════════════════════════════════════════════════════════════
//   4. HOW A REF IS MADE
// ═══════════════════════════════════════════════════════════════════════════

section(4, "How a Ref Is Made")

{
  const first = doc.tasks.at(0)
  const second = doc.tasks.at(1)
  log(`
    A ref is a callable holding its state: its context, its path, its parent,
    and a few slots filled on first use. What it does (reading, navigation,
    writing, observation) lives on a prototype built once per schema node.

    Object.getPrototypeOf(doc.tasks.at(0)) === Object.getPrototypeOf(doc.tasks.at(1))
      → ${Object.getPrototypeOf(first) === Object.getPrototypeOf(second)}

    So a method needs its ref: pass (v) => ref.set(v), not ref.set.

    A list item's or record entry's ref lives while something holds it, and
    while it is held, .at() hands back the same one.
  `)
}

// ═══════════════════════════════════════════════════════════════════════════
//   5. YOUR OWN INTERPRETER
// ═══════════════════════════════════════════════════════════════════════════

section(5, "Your Own Interpreter")

log(`
    interpret(schema, interpreter, ctx) is the catamorphism over a schema:
    one case per kind, children as thunks the case may force or not.
    Materializing, zeroing and validating are all interpreters.
    Here is one that lists every leaf's path.
`)

{
  const leaves = createInterpreter<void, string[]>(
    (_ctx, path) => [path.format()],
    {
      product: (_ctx, _path, _schema, fields) =>
        Object.values(fields).flatMap(field => field()),
      // A list's item is the same at every index: list it once, at [0].
      sequence: (_ctx, _path, _schema, item) => item(0),
      map: (_ctx, _path, _schema, item) => item("*"),
    },
  )
  const paths = interpret(ProjectSchema as SchemaNode, leaves, undefined)
  log(`
    interpret(ProjectSchema, leaves, undefined) →
      ${paths.join("\n      ")}
  `)
}

// ═══════════════════════════════════════════════════════════════════════════
//   6. REFERENTIAL IDENTITY
// ═══════════════════════════════════════════════════════════════════════════

section(6, "Referential Identity")

// Two reads of each, compared below.
const [name1, name2] = [doc.name, doc.name]
const [settings1, settings2] = [doc.settings, doc.settings]
const [task1, task2] = [doc.tasks.at(0), doc.tasks.at(0)]
const [read1, read2] = [doc(), doc()]

const before = doc()
doc.stars.increment(1)
const after = doc()

log(`
    Repeated navigation returns the same ref while it is held — critical
    for React memoization.

    doc.name === doc.name → ${name1 === name2}
    doc.settings === doc.settings → ${settings1 === settings2}
    doc.tasks.at(0) === doc.tasks.at(0) → ${task1 === task2}

    Reads are frozen, and keep their identity until what they read changes:

    doc() === doc() → ${read1 === read2}
    Object.isFrozen(doc()) → ${Object.isFrozen(doc())}
    after doc.stars.increment(1):
      after === before → ${after === before}
      after.settings === before.settings → ${after.settings === before.settings}  (unchanged, shared)

    Namespace isolation — only schema fields appear:
    Object.keys(doc) → [${Object.keys(doc)
      .map(k => `"${k}"`)
      .join(", ")}]

    Symbol-keyed hooks (CALL, TRANSACT, CHANGEFEED)
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
    │ [CALL]           │ What calling a ref does: ref() reads σ        │
    │ [TRANSACT]       │ Context discovery from any ref                │
    │ [CHANGEFEED]     │ Observation coalgebra (Moore machine)         │
    └──────────────────┴───────────────────────────────────────────────┘

    All use Symbol.for("kyneta:...") for cross-bundle identity.

    hasChangefeed(doc) → ${hasChangefeed(doc)}
    hasRecursiveChangefeed(doc) → ${hasRecursiveChangefeed(doc)}  (product — composed tree subscribe)
    hasRecursiveChangefeed(doc.settings) → ${hasRecursiveChangefeed(doc.settings)}  (product)
    hasRecursiveChangefeed(doc.name) → ${hasRecursiveChangefeed(doc.name)}  (leaf — trivial own-path lift, subscribeDescendants is degenerate)
    hasTransact(doc) → ${hasTransact(doc)}
`)

// Demonstrate TRANSACT discovery
const ops = batch(doc, d => {
  d.stars.increment(1)
})

log(`
    batch(doc, d => d.stars.increment(1)) → ${ops.length} op
    batch() found WritableContext via doc[TRANSACT].
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
const text1 = stepText(
  "Hello",
  textChange([{ retain: 5 }, { insert: " World" }]),
)
const text2 = stepText(text1, textChange([{ insert: "¡" }]))
const text3 = stepText(
  text2,
  textChange([{ retain: text2.length }, { insert: "!" }]),
)

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

log(
  `    stepSequence([1,2,3,4,5], [retain 1, insert [10,20], delete 1]) → [${seq.join(", ")}]`,
)

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
//   9. A REPLICA THAT RECEIVES OPS
// ═══════════════════════════════════════════════════════════════════════════

section(9, "A Replica That Receives Ops")

{
  const replicaDoc = createRef(
    ProjectSchema,
    plainSubstrateFactory.create(ProjectSchema),
  ) as Ref<typeof ProjectSchema>

  const events: string[] = []
  subscribe(replicaDoc, cs => {
    for (const e of cs.changes) events.push(e.path.format())
  })

  applyChanges(
    replicaDoc,
    [
      {
        path: RawPath.empty.field("name"),
        change: textChange([{ insert: "✨ " }]),
      },
    ],
    { origin: "external" },
  )

  // Code that only reads can take the read surface alone.
  const readOnly: RRef<typeof ProjectSchema> = replicaDoc

  log(`
    After applyChanges(replicaDoc, [...], { origin: "external" }):
      events → [${events.map(e => `"${e}"`).join(", ")}]
      replicaDoc.name() → "${replicaDoc.name()}"
      readOnly.name() → "${readOnly.name()}"   (RRef<S>: the read surface)
  `)
}

// ═══════════════════════════════════════════════════════════════════════════
//   10. THE ROUND-TRIP AT THE ALGEBRA LEVEL
// ═══════════════════════════════════════════════════════════════════════════

section(10, "The Round-Trip at the Algebra Level")

log(`
    batch() captures Ops. applyChanges() replays them on any doc.
    Ops are (Path, Change) pairs — values, with no reference to the document
    they came from.
`)

{
  const docA: Ref<typeof ProjectSchema> = createRef(
    ProjectSchema,
    plainSubstrateFactory.create(ProjectSchema),
  )
  const docB: Ref<typeof ProjectSchema> = createRef(
    ProjectSchema,
    plainSubstrateFactory.create(ProjectSchema),
  )

  const syncOps = batch(docA, d => {
    d.name.insert(d.name().length, " (synced)")
    d.stars.increment(100)
    d.tasks.push({ title: "Synced task", done: false, priority: 1 })
  })

  applyChanges(docB, syncOps, { origin: "sync" })

  log(`
    batch(docA, ...) → ${syncOps.length} ops
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
    Summary

    • A document:            createRef(schema, substrate), or createDoc(bound)
    • Code that only reads:  type it RRef<S>
    • A fold over a schema:  interpret(schema, interpreter, ctx)
    • Moving changes:        batch() captures ops, applyChanges() replays them
    ─────────────────────────────────────────────────────────
`)
