// ═══════════════════════════════════════════════════════════════════════════
//
//   @kyneta/schema — Getting Started
//
//   Everything you need to build reactive, syncable documents.
//   Import from "@kyneta/schema/basic" — one import, batteries included.
//
//   Run with:  bun run example/basic/main.ts   (from packages/schema/)
//
// ═══════════════════════════════════════════════════════════════════════════

import type {
  CounterSchema,
  Changeset,
  Op,
  Ref,
  SubstratePayload,
  TextSchema,
} from "../../src/basic/index.js"

import {
  Schema,
  createDoc,
  createDocFromEntirety,
  change,
  applyChanges,
  subscribe,
  subscribeNode,
  version,
  delta,
  exportEntirety,
  validate,
  tryValidate,
  SchemaValidationError,
  describe,
} from "../../src/basic/index.js"

import { json, log, section } from "../helpers.js"

// ═══════════════════════════════════════════════════════════════════════════
//
//   1. DEFINE A SCHEMA
//
// ═══════════════════════════════════════════════════════════════════════════

section(1, "Define a Schema")

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

  bio: Schema.nullable(Schema.string()),

  labels: Schema.record(Schema.string()),
})

log(`Schema.struct({ name, stars, tasks, settings, content, bio, labels })`)
log(`\n${describe(ProjectSchema)}`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   2. CREATE A DOCUMENT
//
// ═══════════════════════════════════════════════════════════════════════════

section(2, "Create a Document")

const doc = createDoc(ProjectSchema)

change(doc, d => {
  d.name.insert(0, "My Project")
  d.content.set({ type: "text", body: "Hello world" })
})

log(`
    const doc = createDoc(ProjectSchema)
    change(doc, d => {
      d.name.insert(0, "My Project")
      d.content.set({ type: "text", body: "Hello world" })
    })

    doc() →
${json(doc())
  .split("\n")
  .map((l: string) => `      ${l}`)
  .join("\n")}
`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   3. READ VALUES
//
// ═══════════════════════════════════════════════════════════════════════════

section(3, "Read Values")

log(`
    Every ref is callable — call it to read the current value:
      doc.name()  → "${doc.name()}"
      doc.stars() → ${doc.stars()}

    Template literal coercion — no () needed:
      \`Name: \${doc.name}\` → "Name: ${doc.name}"
      \`Stars: \${doc.stars}\` → "Stars: ${doc.stars}"

    Numeric coercion:
      +doc.stars → ${+doc.stars}
`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   4. MUTATIONS
//
// ═══════════════════════════════════════════════════════════════════════════

section(4, "Mutations")

// Text — surgical character-level edit
doc.name.insert(doc.name().length, " v2")
log(`doc.name.insert(end, " v2") → "${doc.name()}"`)

// Counter — delta increment
doc.stars.increment(42)
log(`doc.stars.increment(42)     → ${doc.stars()}`)

// Sequence — push items to a list
doc.tasks.push({ title: "Design schema", done: true, priority: 1 })
doc.tasks.push({ title: "Write tests", done: false, priority: 2 })
log(`doc.tasks.push(...) ×2      → length ${doc.tasks.length}`)

// Replace — whole-value swap
doc.settings.darkMode.set(true)
log(`doc.settings.darkMode.set(true) → ${doc.settings.darkMode()}`)

// Map — key-level set
doc.labels.set("bug", "red")
doc.labels.set("feature", "blue")
log(
  `doc.labels.set("bug", "red") → keys: [${doc.labels
    .keys()
    .map((k: string) => `"${k}"`)
    .join(", ")}]`,
)

// Product .set() — bulk struct replacement
doc.settings.set({ darkMode: false, fontSize: 16 })
log(`
    doc.settings.set({ darkMode: false, fontSize: 16 })
      → darkMode=${doc.settings.darkMode()}, fontSize=${doc.settings.fontSize()}
`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   5. COLLECTIONS
//
// ═══════════════════════════════════════════════════════════════════════════

section(5, "Collections")

log(`
    Lists:
      doc.tasks.at(0).title() → "${doc.tasks.at(0)?.title()}"
      doc.tasks.get(0)        → ${json(doc.tasks.get(0))}
      doc.tasks.length        → ${doc.tasks.length}

    Iteration (yields refs):
    ${[...doc.tasks].map(t => `  [${t.done() ? "✓" : " "}] ${t.title()} (priority: ${t.priority()})`).join("\n    ")}
`)

doc.tasks.insert(0, { title: "Setup repo", done: true, priority: 1 })
log(`doc.tasks.insert(0, { title: "Setup repo", ... }) → length ${doc.tasks.length}`)

doc.tasks.delete(0, 1)
log(`doc.tasks.delete(0, 1) → length ${doc.tasks.length}`)

log(`
    Records:
      doc.labels.at("bug")!()  → "${doc.labels.at("bug")?.()}"
      doc.labels.get("bug")    → "${doc.labels.get("bug")}"
      doc.labels.has("bug")    → ${doc.labels.has("bug")}
      doc.labels.has("nope")   → ${doc.labels.has("nope")}
      doc.labels.keys()        → [${doc.labels.keys().map((k: string) => `"${k}"`).join(", ")}]
      doc.labels.size          → ${doc.labels.size}
`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   6. SUMS AND NULLABLES
//
// ═══════════════════════════════════════════════════════════════════════════

section(6, "Sums and Nullables")

// Discriminated union — standard TS narrowing works out of the box.
if (doc.content.type === "text") {
  log(`
    Discriminated union — native TypeScript narrowing:
      doc.content.type   → "${doc.content.type}"  (raw string, not a ref)
      doc.content.body() → "${doc.content.body()}"  (TS narrows — no cast)
  `)
}

// Nullable — null by default, set a value, read, set back
log(`    Nullable:
      doc.bio() → ${doc.bio()}  (null by default)`)

doc.bio.set("Full-stack engineer")
log(`      doc.bio.set("Full-stack engineer") → "${doc.bio()}"`)

doc.bio.set(null)
log(`      doc.bio.set(null) → ${doc.bio()}`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   7. TRANSACTIONS
//
// ═══════════════════════════════════════════════════════════════════════════

section(7, "Transactions with change()")

log(`    change(doc, fn) captures mutations as Op[] — all five change types:`)

const ops = change(doc, d => {
  d.name.insert(0, "✨ ")                                      // text
  d.stars.increment(10)                                         // counter
  d.tasks.push({ title: "Ship it!", done: false, priority: 3 }) // sequence
  d.settings.set({ darkMode: true, fontSize: 20 })              // replace
  d.labels.set("priority", "high")                               // map
})

log(`
    const ops = change(doc, d => {
      d.name.insert(0, "✨ ")              // text
      d.stars.increment(10)                 // counter
      d.tasks.push({ title: "Ship it!" })   // sequence
      d.settings.set({ darkMode: true, fontSize: 20 })    // replace
      d.labels.set("priority", "high")      // map
    })

    ops.length → ${ops.length}
    Change types: [${ops.map((o: Op) => `"${o.change.type}"`).join(", ")}]
`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   8. ROUND-TRIP: change → applyChanges
//
// ═══════════════════════════════════════════════════════════════════════════

section(8, "Round-Trip: change → applyChanges")

log(`    Capture mutations on one doc, apply them to a separate doc.`)

const docA = createDoc(ProjectSchema)
change(docA, d => {
  d.name.insert(0, "Shared Doc")
  d.content.set({ type: "text", body: "" })
})
const docB = createDoc(ProjectSchema)
change(docB, d => {
  d.name.insert(0, "Shared Doc")
  d.content.set({ type: "text", body: "" })
})

// Subscribe docB before applying — observe the origin tag
const docBChangesets: Changeset[] = []
subscribeNode(docB.stars, cs => docBChangesets.push(cs))

// Capture on docA
const roundTripOps = change(docA, d => {
  d.name.insert(d.name().length, " v2")
  d.stars.increment(100)
  d.tasks.push({ title: "Review", done: false, priority: 1 })
})

// Apply to docB with origin tag
applyChanges(docB, roundTripOps, { origin: "sync" })

const aSnap = json(docA())
const bSnap = json(docB())

log(`
    const ops = change(docA, d => { ... })
    applyChanges(docB, ops, { origin: "sync" })

    docA() deep-equals docB() → ${aSnap === bSnap} ✓
    docB.name()  → "${docB.name()}"
    docB.stars() → ${docB.stars()}
    Subscriber origin: "${docBChangesets[0]?.origin}"
`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   9. OBSERVATION
//
// ═══════════════════════════════════════════════════════════════════════════

section(9, "Observation")

// Leaf subscription with subscribeNode
const starEvents: Changeset[] = []
const unsub1 = subscribeNode(doc.stars, cs => starEvents.push(cs))

doc.stars.increment(5)

log(`
    subscribeNode(doc.stars, cb)
    doc.stars.increment(5)
    → ${starEvents.length} changeset received, type = "${starEvents[0]?.changes[0]?.type}"
`)

unsub1()
doc.stars.increment(1) // not observed
log(`    After unsub → still ${starEvents.length} total (delivery stopped)`)

// Tree subscription — one listener at the root captures everything
const treeEvents: { path: string; type: string }[] = []
const unsub2 = subscribe(doc, cs => {
  for (const event of cs.changes) {
    treeEvents.push({
      path: event.path.format(),
      type: event.change.type,
    })
  }
})

doc.tasks.at(0)?.done.set(true)
doc.tasks.at(1)?.priority.set(3)
doc.settings.fontSize.set(14)

log(`
    subscribe(doc, cb) — one subscription on the root
    doc.tasks.at(0)!.done.set(true)
    doc.tasks.at(1)!.priority.set(3)
    doc.settings.fontSize.set(14)

    → ${treeEvents.length} tree events:
    ${treeEvents.map(e => `  path: ${e.path}, type: ${e.type}`).join("\n    ")}
`)

unsub2()

// ═══════════════════════════════════════════════════════════════════════════
//
//   10. SYNC
//
// ═══════════════════════════════════════════════════════════════════════════

section(10, "Sync: version, delta, exportEntirety")

// Version tracking
const v1 = version(doc)
doc.stars.increment(1)
const v2 = version(doc)

log(`
    version(doc) before → ${v1}
    doc.stars.increment(1)
    version(doc) after  → ${v2}
`)

// Delta — get ops since a version
const opsFromV1 = delta(doc, v1)
log(`    delta(doc, ${v1}) → ${opsFromV1.length} op(s) since version ${v1}`)

// Snapshot — export and reconstruct
const snapshot: SubstratePayload = exportEntirety(doc)
const docClone = createDocFromEntirety(ProjectSchema, snapshot)

log(`
    const snapshot = exportEntirety(doc)
    const docClone = createDocFromEntirety(ProjectSchema, snapshot)

    docClone.name()  → "${docClone.name()}"
    docClone.stars() → ${docClone.stars()}
    docClone.tasks.length → ${docClone.tasks.length}

    Same state, independent document.
`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   11. VALIDATION
//
// ═══════════════════════════════════════════════════════════════════════════

section(11, "Validation")

log(`    Same schema — no separate validation library needed.`)

// Happy path
const snapshotData = doc()
const validated = validate(ProjectSchema, snapshotData)
log(`
    validate(schema, doc()) → passes ✓
      validated.name  = "${validated.name}"
      validated.stars = ${validated.stars}
`)

// Error collection with tryValidate
const badData = {
  name: "ok",
  stars: "not a number",
  tasks: [{ title: "task", done: true, priority: 99 }],
  settings: { darkMode: false, fontSize: 14 },
  content: { type: "text", body: "" },
  bio: null,
  labels: {},
}

const result = tryValidate(ProjectSchema, badData)
if (!result.ok) {
  const descVal = (v: unknown) =>
    v === null ? "null" : v === undefined ? "undefined"
      : typeof v === "string" ? `"${v}"` : String(v)

  log(`
    tryValidate(schema, badData) → ${result.errors.length} error(s):
    ${result.errors.map(e => `  ✗ ${e.path}: expected ${e.expected}, got ${descVal(e.actual)}`).join("\n    ")}
  `)
}

// Throws on first error
try {
  validate(ProjectSchema, { ...badData, bio: 42 })
} catch (e) {
  if (e instanceof SchemaValidationError) {
    log(`
    validate() throws SchemaValidationError:
      path: "${e.path}"
      expected: "${e.expected}"
    `)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//
//   12. PORTABLE REFS
//
// ═══════════════════════════════════════════════════════════════════════════

section(12, "Portable Refs")

log(`    Refs are self-contained — pass them to generic helper functions.`)

// A generic function that appends a tag to any text ref
function tag(ref: Ref<TextSchema>, label: string) {
  ref.insert(ref().length, ` [${label}]`)
}

// A generic function that ensures a counter meets a minimum
function ensureMinimum(ref: Ref<CounterSchema>, min: number) {
  const current = ref()
  if (current < min) ref.increment(min - current)
}

tag(doc.name, "released")
ensureMinimum(doc.stars, 200)

log(`
    function tag(ref, label) { ref.insert(end, " [label]") }
    function ensureMinimum(ref, min) { if (ref() < min) ref.increment(min - ref()) }

    tag(doc.name, "released")       → "${doc.name()}"
    ensureMinimum(doc.stars, 200)   → ${doc.stars()}

    Template literal coercion:
      \`Stars: \${doc.stars}\` → "Stars: ${doc.stars}"
      \`Name: \${doc.name}\`   → "Name: ${doc.name}"
      +doc.stars              → ${+doc.stars}
`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   13. BATCHED NOTIFICATION
//
// ═══════════════════════════════════════════════════════════════════════════

section(13, "Batched Notification")

log(`    applyChanges delivers ONE changeset per affected path, not per op.`)

{
  const batchDoc = createDoc(ProjectSchema)
  change(batchDoc, d => {
    d.name.insert(0, "Batch")
    d.content.set({ type: "text", body: "" })
  })
  const changesets: Changeset[] = []
  subscribeNode(batchDoc.stars, cs => changesets.push(cs))

  // Generate 3 separate increment ops
  const ops1 = change(batchDoc, d => d.stars.increment(1))
  const ops2 = change(batchDoc, d => d.stars.increment(2))
  const ops3 = change(batchDoc, d => d.stars.increment(3))
  changesets.length = 0 // reset from the individual changes above

  // Create a fresh doc and apply all 3 ops as one batch
  const batchDoc2 = createDoc(ProjectSchema)
  change(batchDoc2, d => {
    d.name.insert(0, "Batch")
    d.content.set({ type: "text", body: "" })
  })
  const batchChangesets: Changeset[] = []
  subscribeNode(batchDoc2.stars, cs => batchChangesets.push(cs))

  applyChanges(batchDoc2, [...ops1, ...ops2, ...ops3], { origin: "undo" })

  log(`
    3 increment ops applied via applyChanges as one batch:
      changesets received → ${batchChangesets.length} (batched into one)
      changeset.changes   → ${batchChangesets[0]?.changes.length} change(s)
      changeset.origin    → "${batchChangesets[0]?.origin}"
      batchDoc2.stars()   → ${batchDoc2.stars()} (fully applied: 1+2+3)

    Subscribers see fully-applied state when notified.
  `)
}

// ═══════════════════════════════════════════════════════════════════════════
//
//   14. FINAL SNAPSHOT
//
// ═══════════════════════════════════════════════════════════════════════════

section(14, "Final Snapshot")

log(
  `doc() →\n${json(doc())
    .split("\n")
    .map((l: string) => `    ${l}`)
    .join("\n")}`,
)
