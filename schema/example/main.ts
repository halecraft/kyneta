// ═══════════════════════════════════════════════════════════════════════════
//
//   @loro-extended/schema — Example Mini-App
//
//   This example builds a thin, high-level facade on top of the schema
//   algebra primitives, then uses that facade to demonstrate the apex
//   developer experience: the same ergonomics as @loro-extended/change,
//   but running on a plain JS object store with zero CRDT runtime.
//
//   Run with:  npx tsx example/main.ts   (from packages/schema/)
//
// ═══════════════════════════════════════════════════════════════════════════

import {
  Schema,
  LoroSchema,
  Zero,
  describe,
  interpret,
  plainInterpreter,
  writableInterpreter,
  createWritableContext,
  enrich,
  withChangefeed,
  createChangefeedContext,
  changefeedFlush,
  subscribeDeep,
  CHANGEFEED,
  hasChangefeed,
  validate,
  tryValidate,
  SchemaValidationError,
  formatPath,
} from "../src/index.js"

import type {
  Writable,
  Plain,
  WritableContext,
  ChangefeedContext,
  ChangeBase,
  Changefeed,
  TextRef,
  CounterRef,
  ScalarRef,
  SequenceRef,
  Store,
} from "../src/index.js"
import type {
  AnnotatedSchema,
  ProductSchema,
  SchemaNode,
} from "../src/index.js"

// ═══════════════════════════════════════════════════════════════════════════
//
//   FACADE — The high-level API built on schema primitives
//
//   In production this would live in its own package (or in
//   @loro-extended/change). Here it lives in the example to prove
//   the algebra supports this developer experience.
//
// ═══════════════════════════════════════════════════════════════════════════

// A document handle: the thing developers interact with.
// Hides stores, contexts, interpreters — just typed refs + convenience.

const DOC_INTERNALS = Symbol("doc-internals")

type DocInternals = {
  schema: AnnotatedSchema<"doc", ProductSchema>
  store: Store
  cfCtx: ChangefeedContext
}

function getInternals(doc: object): DocInternals {
  return (doc as any)[DOC_INTERNALS]
}

/**
 * Create a typed document from a schema, optionally seeded with initial values.
 *
 * ```ts
 * const doc = createDoc(MySchema)
 * const doc = createDoc(MySchema, { title: "Hello" })
 * ```
 */
function createDoc<F extends Record<string, SchemaNode>>(
  schema: AnnotatedSchema<"doc", ProductSchema<F>>,
  seed?: Record<string, unknown>,
): {
  readonly [K in keyof F]: Writable<F[K]>
} & {
  toJSON(): { [K in keyof F]: Plain<F[K]> }
} {
  // Derive defaults, overlay seed if provided
  const defaults = Zero.structural(schema) as Record<string, unknown>
  const initial = seed
    ? (Zero.overlay(seed, defaults, schema) as Record<string, unknown>)
    : defaults
  const store: Store = { ...initial }

  // Wire up writable + feed in one shot
  const wCtx = createWritableContext(store)
  const cfCtx = createChangefeedContext(wCtx)
  const enriched = enrich(writableInterpreter, withChangefeed)
  const surface = interpret(schema, enriched, cfCtx) as object

  // Attach toJSON via the plain interpreter
  const toJSON = () => interpret(schema, plainInterpreter, store)

  // Attach internal machinery (non-enumerable, hidden from Object.keys)
  Object.defineProperty(surface, DOC_INTERNALS, {
    value: { schema, store, cfCtx } satisfies DocInternals,
    enumerable: false,
    configurable: false,
  })

  Object.defineProperty(surface, "toJSON", {
    value: toJSON,
    enumerable: false,
    configurable: false,
  })

  return surface as any
}

/**
 * Batch mutations into a single atomic flush.
 *
 * ```ts
 * change(doc, d => {
 *   d.title.update("Hello World")
 *   d.count.increment(42)
 *   d.items.push("first")
 * })
 * ```
 *
 * Returns the doc for chaining.
 */
function change<D extends object>(doc: D, fn: (draft: D) => void): D {
  const { schema, store } = getInternals(doc as object)

  // Create a batched context sharing the same store
  const batchWCtx = createWritableContext(store, { autoCommit: false })
  const batchCfCtx = createChangefeedContext(batchWCtx)
  const enriched = enrich(writableInterpreter, withChangefeed)
  const draft = interpret(schema, enriched, batchCfCtx) as D

  // Execute the user's mutations (nothing hits the store yet)
  fn(draft)

  // Flush: apply all actions to the store atomically.
  // The original doc's refs read live from the shared store,
  // so .get() etc. immediately reflect the new values.
  changefeedFlush(batchCfCtx)

  return doc
}

/**
 * Subscribe to changes on any ref with a changefeed.
 *
 * ```ts
 * subscribe(doc.title, change => console.log("title changed:", change))
 * ```
 *
 * Returns an unsubscribe function.
 */
function subscribe(
  ref: unknown,
  callback: (change: ChangeBase) => void,
): () => void {
  if (!hasChangefeed(ref)) {
    throw new Error(
      "subscribe() requires a changefeed ref (created via createDoc)",
    )
  }
  return (ref as any)[CHANGEFEED].subscribe(callback)
}

// ═══════════════════════════════════════════════════════════════════════════
//
//   THE EXAMPLE — Using the facade exactly like a developer would
//
// ═══════════════════════════════════════════════════════════════════════════

// ─── Helpers ─────────────────────────────────────────────────────────────

const section = (n: number, title: string) => {
  console.log()
  console.log(`${"═".repeat(68)}`)
  console.log(`  ${n}. ${title}`)
  console.log(`${"═".repeat(68)}`)
  console.log()
}

const log = (msg: string) => {
  for (const line of msg.split("\n")) {
    console.log(`  ${line}`)
  }
}

// ─── 1. Define a schema ──────────────────────────────────────────────────

section(1, "Define a Schema")

const ProjectSchema = LoroSchema.doc({
  name: LoroSchema.text(),
  description: LoroSchema.text(),
  stars: LoroSchema.counter(),

  tasks: Schema.list(
    LoroSchema.plain.struct({
      text: LoroSchema.text(),
      title: LoroSchema.plain.string(),
      done: LoroSchema.plain.boolean(),
      priority: LoroSchema.plain.number(1, 2, 3),
    }),
  ),

  settings: LoroSchema.plain.struct({
    visibility: LoroSchema.plain.string("public", "private"),
    maxTasks: LoroSchema.plain.number(),
    archived: LoroSchema.plain.boolean(),
  }),

  bio: Schema.nullable(LoroSchema.plain.string()),

  labels: Schema.record(LoroSchema.plain.string()),
})

log(describe(ProjectSchema))

// ─── 2. Create a document ────────────────────────────────────────────────

section(2, "Create a Document")

const doc = createDoc(ProjectSchema, {
  name: "Schema Algebra",
  settings: { visibility: "public" },
})

log(`const doc = createDoc(ProjectSchema, { name: "Schema Algebra", ... })`)
log("")
log(`doc.toJSON() →`)
log(
  `${JSON.stringify(doc.toJSON(), null, 2)
    .split("\n")
    .map(l => "  " + l)
    .join("\n")}`,
)

// ─── 3. Direct mutations (auto-commit) ──────────────────────────────────

section(3, "Direct Mutations (auto-commit)")

doc.name.insert(doc.name.get().length, " v2")
log(`doc.name.insert(end, " v2")`)
log(`doc.name.get() → "${doc.name.get()}"`)

doc.description.update("A unified recursive grammar for document structure")
log(`doc.description.update("A unified recursive grammar...")`)

doc.stars.increment(42)
log(`doc.stars.increment(42)`)
log(`doc.stars.get() → ${doc.stars.get()}`)

doc.stars.decrement(2)
log(`doc.stars.decrement(2) → ${doc.stars.get()}`)

doc.settings.visibility.set("private")
log(
  `doc.settings.visibility.set("private") → "${doc.settings.visibility.get()}"`,
)

doc.settings.maxTasks.set(50)
log(`doc.settings.maxTasks.set(50) → ${doc.settings.maxTasks.get()}`)

log("")
log(`doc.toJSON() →`)
log(
  `${JSON.stringify(doc.toJSON(), null, 2)
    .split("\n")
    .map(l => "  " + l)
    .join("\n")}`,
)

// ─── 4. Working with lists ──────────────────────────────────────────────

section(4, "Working with Lists")

doc.tasks.push({ title: "Design the grammar", done: true, priority: 1 })
doc.tasks.push({ title: "Implement catamorphism", done: true, priority: 1 })
doc.tasks.push({ title: "Write the facade", done: false, priority: 2 })
log(`doc.tasks.push(...)  ×3`)
log(`doc.tasks.length → ${doc.tasks.length}`)

const task = doc.tasks.get(0)
log(`doc.tasks.get(0).title.get() → "${task.title.get()}"`)
log(`doc.tasks.get(0).done.get()  → ${task.done.get()}`)

log("")
log("Iterating:")
for (const item of doc.tasks) {
  log(
    `  [${item.done.get() ? "✓" : " "}] ${item.title.get()} (priority: ${item.priority.get()})`,
  )
}

doc.tasks.delete(1)
log(`doc.tasks.delete(1) → length is now ${doc.tasks.length}`)

// ─── 5. Working with records (dynamic keys) ─────────────────────────────

section(5, "Working with Records (dynamic keys)")

// Records use Proxy — any string key returns a typed ref
;(doc.labels as any).bug = "red" // set via proxy
;(doc.labels as any).feature = "blue"
;(doc.labels as any).docs = "green"
log(`doc.labels.bug = "red"`)
log(`doc.labels.feature = "blue"`)
log(`doc.labels.docs = "green"`)
log(
  `Object.keys(doc.labels) → [${Object.keys(doc.labels)
    .map(k => `"${k}"`)
    .join(", ")}]`,
)
log(`"bug" in doc.labels → ${"bug" in doc.labels}`)
log(`"missing" in doc.labels → ${"missing" in doc.labels}`)
log(`doc.labels.bug.get() → "${(doc.labels as any).bug.get()}"`)

// ─── 6. Batched mutations with change() ─────────────────────────────────

section(6, "Batched Mutations with change()")

log(`Before: stars = ${doc.stars.get()}, name = "${doc.name.get()}"`)

change(doc, d => {
  d.name.update("Schema Algebra v3")
  d.stars.increment(100)
  d.settings.archived.set(true)
  d.tasks.push({ title: "Ship it!", done: false, priority: 3 })
})

log(`change(doc, d => {`)
log(`  d.name.update("Schema Algebra v3")`)
log(`  d.stars.increment(100)`)
log(`  d.settings.archived.set(true)`)
log(`  d.tasks.push({ title: "Ship it!", ... })`)
log(`})`)
log("")
log(`After: stars = ${doc.stars.get()}, name = "${doc.name.get()}"`)
log(`doc.settings.archived.get() → ${doc.settings.archived.get()}`)
log(`doc.tasks.length → ${doc.tasks.length}`)

// ─── 7. Subscribing to changes ──────────────────────────────────────────

section(7, "Subscribing to Changes")

const actions: ChangeBase[] = []
const unsub = subscribe(doc.name, action => {
  actions.push(action)
})

log(`subscribe(doc.name, action => ...)`)
log("")

doc.name.insert(0, "✨ ")
log(`doc.name.insert(0, "✨ ")`)
doc.name.insert(doc.name.get().length, " ✨")
log(`doc.name.insert(end, " ✨")`)
log(`→ "${doc.name.get()}"`)
log(
  `→ ${actions.length} actions received, types: [${actions.map(a => `"${a.type}"`).join(", ")}]`,
)

unsub()
doc.name.insert(0, "IGNORED ")
log("")
log(`After unsub → still ${actions.length} actions (delivery stopped)`)
// Undo the pollution so later sections are clean
doc.name.update("Schema Algebra v3")

// ─── 8. Portable refs ───────────────────────────────────────────────────

section(8, "Portable Refs")

log("Refs carry their context in closures — pass them anywhere.")
log("")

// A function that knows nothing about our document
function resetSettings(
  visibility: ScalarRef<"public" | "private">,
  maxTasks: ScalarRef<number>,
  archived: ScalarRef<boolean>,
) {
  visibility.set("public")
  maxTasks.set(100)
  archived.set(false)
}

log(
  `Before: visibility="${doc.settings.visibility.get()}", maxTasks=${doc.settings.maxTasks.get()}, archived=${doc.settings.archived.get()}`,
)
resetSettings(
  doc.settings.visibility,
  doc.settings.maxTasks,
  doc.settings.archived,
)
log(
  `resetSettings(doc.settings.visibility, doc.settings.maxTasks, doc.settings.archived)`,
)
log(
  `After:  visibility="${doc.settings.visibility.get()}", maxTasks=${doc.settings.maxTasks.get()}, archived=${doc.settings.archived.get()}`,
)

log("")

// A generic "append tag" function for any TextRef
function tag(ref: TextRef, label: string) {
  ref.insert(ref.get().length, ` [${label}]`)
}

tag(doc.name, "released")
log(`tag(doc.name, "released") → "${doc.name.get()}"`)

// A generic counter helper
function ensureMinimum(ref: CounterRef, min: number) {
  const current = ref.get()
  if (current < min) ref.increment(min - current)
}

log(`doc.stars.get() → ${doc.stars.get()}`)
ensureMinimum(doc.stars, 200)
log(`ensureMinimum(doc.stars, 200) → ${doc.stars.get()}`)

// ─── 9. Referential identity & namespace isolation ──────────────────────

section(9, "Referential Identity & Namespace Isolation")

log(`doc.name === doc.name → ${doc.name === doc.name}`)
log(`doc.settings === doc.settings → ${doc.settings === doc.settings}`)
log("")
log(
  `Object.keys(doc) → [${Object.keys(doc)
    .map(k => `"${k}"`)
    .join(", ")}]`,
)
log(`"toJSON" in Object.keys(doc) → ${Object.keys(doc).includes("toJSON")}`)
log(`typeof doc.toJSON → "${typeof doc.toJSON}"`)
log("")
log(`isFeedable(doc) → ${hasChangefeed(doc)}`)
log(`isFeedable(doc.name) → ${hasChangefeed(doc.name)}`)
log(`isFeedable(doc.stars) → ${hasChangefeed(doc.stars)}`)
log(`isFeedable(doc.tasks) → ${hasChangefeed(doc.tasks)}`)
log(`isFeedable(doc.settings) → ${hasChangefeed(doc.settings)}`)

// ─── 10. Validation ─────────────────────────────────────────────────────

section(10, "Validation")

log("validate() and tryValidate() check plain data against a schema.")
log("They use the same interpreter algebra — no separate validation logic.")
log("")

// 10a. Validate the current doc snapshot (should pass)
// validate() returns Plain<S> — TypeScript infers the fully typed result.
// We access typed fields to demonstrate the narrowing works at compile time.
const snapshot = doc.toJSON()
const validated = validate(ProjectSchema, snapshot)
log(`validate(ProjectSchema, doc.toJSON()) → passes ✓`)
log(`  validated.name = "${validated.name}"`)
log(`  validated.stars = ${validated.stars}`)
log(`  validated.settings.visibility = "${validated.settings.visibility}"`)
log("")

// 10b. Validate invalid data — caught errors with path and message
const badData = {
  name: "ok",
  description: "ok",
  stars: "not a number", // ← wrong type
  tasks: [
    { title: "task", done: true, priority: 99 }, // ← priority not in [1,2,3]
  ],
  settings: {
    visibility: "unlisted", // ← not "public" or "private"
    maxTasks: 10,
    archived: false,
  },
  bio: null,
  labels: {},
}

const result = tryValidate(ProjectSchema, badData)
if (!result.ok) {
  log(`tryValidate(ProjectSchema, badData) → ${result.errors.length} errors:`)
  for (const err of result.errors) {
    log(
      `  ✗ ${err.path}: expected ${err.expected}, got ${describeValue(err.actual)}`,
    )
  }
}
log("")

// 10c. validate() throws on invalid data
try {
  validate(ProjectSchema, { ...badData, bio: 42 })
} catch (e) {
  if (e instanceof SchemaValidationError) {
    log(`validate() throws SchemaValidationError:`)
    log(`  path: "${e.path}"`)
    log(`  expected: "${e.expected}"`)
    log(`  message: "${e.message}"`)
  }
}

function describeValue(v: unknown): string {
  if (v === null) return "null"
  if (v === undefined) return "undefined"
  if (typeof v === "string") return `"${v}"`
  return String(v)
}

// ─── 11. Deep subscriptions ─────────────────────────────────────────────

section(11, "Deep Subscriptions (subscribeDeep)")

log("subscribeDeep notifies for changes anywhere in a subtree.")
log("The Changefeed coalgebra is unchanged — subscribeDeep is")
log("context-level infrastructure in the observation layer.")
log("")

const { cfCtx } = getInternals(doc as object)
const deepEvents: { origin: string; type: string }[] = []
const deepUnsub = subscribeDeep(cfCtx, [], (event) => {
  deepEvents.push({
    origin: formatPath(event.origin),
    type: event.change.type,
  })
})

doc.name.update("Deep Test")
doc.stars.increment(1)
doc.settings.maxTasks.set(999)

log(`After 3 mutations (name, stars, settings):`)
log(`  ${deepEvents.length} deep events received:`)
for (const e of deepEvents) {
  log(`    origin: ${e.origin}, type: ${e.type}`)
}

deepUnsub()
doc.name.update("Schema Algebra v3 [released]") // restore, not observed

// ─── 12. Final snapshot ─────────────────────────────────────────────────

section(12, "Final Snapshot")

log("doc.toJSON() →")
log(
  JSON.stringify(doc.toJSON(), null, 2)
    .split("\n")
    .map(l => "  " + l)
    .join("\n"),
)

// ─── Done ───────────────────────────────────────────────────────────────

console.log()
console.log("═".repeat(68))
console.log()
log("This entire app ran on plain JS objects.")
log("No CRDT runtime. No Loro. No network. No dependencies.")
log("")
log("The same schema, the same developer experience,")
log("can target any backend via different interpreters.")
console.log()
