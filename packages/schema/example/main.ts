// ═══════════════════════════════════════════════════════════════════════════
//
//   @kyneta/schema — Example Mini-App
//
//   This example builds a thin, high-level facade on top of the schema
//   algebra primitives, then uses that facade to demonstrate the apex
//   developer experience: the same ergonomics as @loro-extended/change,
//   but running on a plain JS object store with zero CRDT runtime.
//
//   The architecture decomposes into four composable interpreter layers:
//     1. readable    — callable function-shaped refs with caching
//     2. writable    — adds .set(), .insert(), .increment(), etc.
//     3. changefeed  — adds [CHANGEFEED] / subscribeTree observation
//
//   Compose them fluently:
//     interpret(schema, ctx).with(readable).with(writable).with(changefeed).done()
//
//   Or manually:
//     withChangefeed(withWritable(withCaching(withReadable(bottomInterpreter))))
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
  bottomInterpreter,
  withReadable,
  withCaching,
  withWritable,
  withChangefeed,
  createWritableContext,
  readable,
  writable,
  changefeed,
  CHANGEFEED,
  TRANSACT,
  hasChangefeed,
  hasComposedChangefeed,
  hasTransact,
  validate,
  tryValidate,
  SchemaValidationError,
  formatPath,
} from "../src/index.js"

import type {
  Writable,
  Readable,
  Plain,
  RefContext,
  WritableContext,
  ChangeBase,
  Changeset,
  TreeEvent,
  TextRef,
  CounterRef,
  ScalarRef,
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
//   @kyneta/change). Here it lives in the example to prove
//   the algebra supports this developer experience.
//
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a typed document from a schema, optionally seeded with
 * initial values. Returns a fully wired document with read, write,
 * and observation capabilities.
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
  readonly [K in keyof F]: Readable<F[K]> & Writable<F[K]>
} & {
  (): { [K in keyof F]: Plain<F[K]> }
  toJSON(): { [K in keyof F]: Plain<F[K]> }
} {
  // Derive defaults, overlay seed if provided
  const defaults = Zero.structural(schema) as Record<string, unknown>
  const initial = seed
    ? (Zero.overlay(seed, defaults, schema) as Record<string, unknown>)
    : defaults
  const store: Store = { ...initial }

  // Wire up the full interpreter stack via the fluent builder
  const ctx = createWritableContext(store)
  const surface = interpret(schema, ctx)
    .with(readable)
    .with(writable)
    .with(changefeed)
    .done() as object

  // Attach toJSON via the plain interpreter
  const toJSON = () => interpret(schema, plainInterpreter, store)

  Object.defineProperty(surface, "toJSON", {
    value: toJSON,
    enumerable: false,
    configurable: false,
  })

  return surface as any
}

/**
 * Batch mutations into a single atomic transaction.
 *
 * Uses the `[TRANSACT]` symbol to discover the `WritableContext`
 * from any ref — no internal WeakMap or re-interpretation needed.
 *
 * During the transaction, dispatch buffers changes. On commit,
 * changes replay through dispatch so changefeed subscribers fire.
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
  if (!hasTransact(doc)) {
    throw new Error(
      "change() requires a ref with [TRANSACT] (created via createDoc)",
    )
  }
  const ctx: WritableContext = (doc as any)[TRANSACT]
  ctx.beginTransaction()
  try {
    fn(doc)
    ctx.commit()
  } catch (e) {
    ctx.abort()
    throw e
  }
  return doc
}

/**
 * Subscribe to changes on any ref with a changefeed.
 *
 * Unwraps the `Changeset` protocol so callers receive individual
 * changes — a convenience for the example code. Production code
 * should use the `Changeset` protocol directly.
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
  return ref[CHANGEFEED].subscribe((changeset: Changeset<ChangeBase>) => {
    for (const change of changeset.changes) {
      callback(change)
    }
  })
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
  // Indent-aware: if the string starts with a newline followed by
  // whitespace, treat that whitespace as the "base indent" to strip.
  let lines = msg.split("\n")

  // Detect optional leading newline
  if (lines.length > 1 && lines[0]!.trim() === "") {
    lines = lines.slice(1) // drop the empty first line
  }

  // Detect optional trailing empty line (closing backtick on its own line)
  if (lines.length > 1 && lines[lines.length - 1]!.trim() === "") {
    lines = lines.slice(0, -1)
  }

  // Find the minimum indentation across non-empty lines
  let minIndent = Infinity
  for (const line of lines) {
    if (line.trim() === "") continue
    const match = line.match(/^(\s*)/)
    if (match) minIndent = Math.min(minIndent, match[1]!.length)
  }
  if (!isFinite(minIndent)) minIndent = 0

  for (const line of lines) {
    console.log(`  ${line.slice(minIndent)}`)
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

const showDoc = () => {
  log(
    `\ndoc() → \n${JSON.stringify(doc(), null, 2)
      .split("\n")
      .map(l => "  " + l)
      .join("\n")}`,
  )
}

log(`const doc = createDoc(ProjectSchema, { name: "Schema Algebra", ... })\n`)
showDoc()

// ─── 3. Direct mutations (auto-commit) ──────────────────────────────────

section(3, "Direct Mutations (auto-commit)")

doc.name.insert(doc.name().length, " v2")
doc.description.update("A unified recursive grammar for document structure")
log(`
    doc.name.insert(end, " v2")
    doc.name() → "${doc.name()}"

    doc.description.update("A unified recursive grammar...")
`)

doc.stars.increment(42)
log(`
    doc.stars.increment(42)
    doc.stars() → ${doc.stars()}
`)

doc.stars.decrement(2)
log(`
    doc.stars.decrement(2) → ${doc.stars()}
`)

doc.settings.visibility.set("private")
doc.settings.maxTasks.set(50)

log(`
    doc.settings.visibility.set("private") → "${doc.settings.visibility()}"

    doc.settings.maxTasks.set(50) → ${doc.settings.maxTasks()}
`)

// Product .set() — bulk struct replacement in a single ReplaceChange
doc.settings.set({ visibility: "public", maxTasks: 100, archived: false })
log(`
    doc.settings.set({ visibility: "public", maxTasks: 100, archived: false })
      → visibility="${doc.settings.visibility()}"
      → maxTasks=${doc.settings.maxTasks()}
      → archived=${doc.settings.archived()}
`)

log("\n\n")

showDoc()

// ─── 4. Working with lists ──────────────────────────────────────────────

section(4, "Working with Lists")

doc.tasks.push({ title: "Design the grammar", done: true, priority: 1 })
doc.tasks.push({ title: "Implement catamorphism", done: true, priority: 1 })
doc.tasks.push({ title: "Write the facade", done: false, priority: 2 })

const task = doc.tasks.at(0)!
log(`
    doc.tasks.push(...)  ×3
    doc.tasks.length → ${doc.tasks.length}

    Navigate with .at(i) → ref (callable, subscribable):
    doc.tasks.at(0).title() → "${task.title()}"
    doc.tasks.at(0).done()  → ${task.done()}

    Read with .get(i) → plain value (symmetric with mutation):
    doc.tasks.get(0) → ${JSON.stringify(doc.tasks.get(0))}

    Iterating (yields refs):
    ${[...doc.tasks].map(item => `  [${item.done() ? "✓" : " "}] ${item.title()} (priority: ${item.priority()})`).join("\n    ")}
`)

doc.tasks.delete(1)
log(`doc.tasks.delete(1) → length is now ${doc.tasks.length}`)

// ─── 5. Working with records (dynamic keys) ─────────────────────────────

section(5, "Working with Records (dynamic keys)")

// Records have two access verbs:
//   .at(key)  → navigate to a ref (callable, subscribable)
//   .get(key) → read the plain value (symmetric with .set())
// Plus: .set(), .delete(), .has(), .keys(), .size, .entries(),
//       .values(), .clear(). Type-safe, no casts.
doc.labels.set("bug", "red")
doc.labels.set("feature", "blue")
doc.labels.set("docs", "green")
log(`
    doc.labels.set("bug", "red")
    doc.labels.set("feature", "blue")
    doc.labels.set("docs", "green")
    doc.labels.keys() → [${doc.labels
      .keys()
      .map((k: string) => `"${k}"`)
      .join(", ")}]
    doc.labels.has("bug") → ${doc.labels.has("bug")}
    doc.labels.has("missing") → ${doc.labels.has("missing")}
    doc.labels.size → ${doc.labels.size}

    Read with .get(key) → plain value (symmetric with .set()):
    doc.labels.get("bug") → "${doc.labels.get("bug")}"
    JSON.stringify(doc.labels.get("bug")) → ${JSON.stringify(doc.labels.get("bug"))}

    Navigate with .at(key) → ref (callable, subscribable):
    doc.labels.at("bug")!() → "${doc.labels.at("bug")!()}"
`)

// ─── 6. Transactions with change() ──────────────────────────────────────

section(6, "Transactions with change()")

log(`Before: stars = ${doc.stars()}, name = "${doc.name()}"`)

change(doc, d => {
  d.name.update("Schema Algebra v3")
  d.stars.increment(100)
  // Product .set() in transaction: one ReplaceChange instead of N scalar writes
  d.settings.set({ visibility: "private", maxTasks: 25, archived: true })
  d.tasks.push({ title: "Ship it!", done: false, priority: 3 })
})

log(`
    change(doc, d => {
      d.name.update("Schema Algebra v3")
      d.stars.increment(100)
      d.settings.set({ visibility: "private", maxTasks: 25, archived: true })
      d.tasks.push({ title: "Ship it!", ... })
    })

    After: stars = ${doc.stars()}, name = "${doc.name()}"
    doc.settings.visibility() → "${doc.settings.visibility()}"
    doc.settings.maxTasks() → ${doc.settings.maxTasks()}
    doc.settings.archived() → ${doc.settings.archived()}
    doc.tasks.length → ${doc.tasks.length}
`)

// ─── 7. Subscribing to changes ──────────────────────────────────────────

section(7, "Subscribing to Changes")

const actions: ChangeBase[] = []
const unsub = subscribe(doc.name, action => {
  actions.push(action)
})

log(`subscribe(doc.name, action => ...)\n`)

doc.name.insert(0, "✨ ")
doc.name.insert(doc.name().length, " ✨")
log(`
    doc.name.insert(0, "✨ ")
    doc.name.insert(end, " ✨")
    → "${doc.name()}"
    → ${actions.length} actions received, types: [${actions.map(a => `"${a.type}"`).join(", ")}]
`)

unsub()
doc.name.insert(0, "IGNORED ")
log(`After unsub → still ${actions.length} actions (delivery stopped)`)
// Undo the pollution so later sections are clean
doc.name.update("Schema Algebra v3")

// ─── 8. Portable refs ───────────────────────────────────────────────────

section(8, "Portable Refs")

log(`
    Refs carry their context in closures — pass them anywhere.
`)

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
  `Before: visibility="${doc.settings.visibility()}", maxTasks=${doc.settings.maxTasks()}, archived=${doc.settings.archived()}`,
)
resetSettings(
  doc.settings.visibility,
  doc.settings.maxTasks,
  doc.settings.archived,
)
log(`
    resetSettings(doc.settings.visibility, doc.settings.maxTasks, doc.settings.archived)
    After:  visibility="${doc.settings.visibility()}", maxTasks=${doc.settings.maxTasks()}, archived=${doc.settings.archived()}
`)

// Contrast: product .set() replaces the entire struct in one call.
// Leaf .set() for surgical edits, product .set() for bulk replacement.
doc.settings.set({ visibility: "private", maxTasks: 50, archived: true })
log(`
    Or: doc.settings.set({ visibility: "private", maxTasks: 50, archived: true })
      → visibility="${doc.settings.visibility()}", maxTasks=${doc.settings.maxTasks()}, archived=${doc.settings.archived()}
`)
// Restore for later sections
doc.settings.set({ visibility: "public", maxTasks: 100, archived: false })

// A generic "append tag" function — typed with Readable & Writable
// The intersection captures both "callable read" and "mutation methods".
function tag(ref: (() => string) & TextRef, label: string) {
  ref.insert(ref().length, ` [${label}]`)
}

tag(doc.name, "released")

// A generic counter helper — typed with Readable & Writable
function ensureMinimum(ref: (() => number) & CounterRef, min: number) {
  const current = ref()
  if (current < min) ref.increment(min - current)
}

log(`doc.stars() → ${doc.stars()}`)
ensureMinimum(doc.stars, 200)
log(`
    tag(doc.name, "released") → "${doc.name()}"
    ensureMinimum(doc.stars, 200) → ${doc.stars()}
`)

// ─── 9. Referential identity & namespace isolation ──────────────────────

section(9, "Referential Identity & Namespace Isolation")

log(`
    doc.name === doc.name → ${doc.name === doc.name}
    doc.settings === doc.settings → ${doc.settings === doc.settings}

    Object.keys(doc) → [${Object.keys(doc)
      .map(k => `"${k}"`)
      .join(", ")}]
    "toJSON" in Object.keys(doc) → ${Object.keys(doc).includes("toJSON")}
    typeof doc.toJSON → "${typeof doc.toJSON}"

    hasChangefeed(doc) → ${hasChangefeed(doc)}
    hasChangefeed(doc.name) → ${hasChangefeed(doc.name)}
    hasChangefeed(doc.stars) → ${hasChangefeed(doc.stars)}
    hasChangefeed(doc.tasks) → ${hasChangefeed(doc.tasks)}
    hasChangefeed(doc.settings) → ${hasChangefeed(doc.settings)}

    hasTransact(doc) → ${hasTransact(doc)}
    hasTransact(doc.name) → ${hasTransact(doc.name)}
`)

// ─── 10. Validation ─────────────────────────────────────────────────────

section(10, "Validation")

log(`
    validate() and tryValidate() check plain data against a schema.
    They use the same interpreter algebra — no separate validation logic.
`)

// 10a. Validate the current doc snapshot (should pass)
// validate() returns Plain<S> — TypeScript infers the fully typed result.
// We access typed fields to demonstrate the narrowing works at compile time.
const snapshot = doc.toJSON()
const validated = validate(ProjectSchema, snapshot)
log(`
    validate(ProjectSchema, doc.toJSON()) → passes ✓
      validated.name = "${validated.name}"
      validated.stars = ${validated.stars}
      validated.settings.visibility = "${validated.settings.visibility}"
`)

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

function describeValue(v: unknown): string {
  if (v === null) return "null"
  if (v === undefined) return "undefined"
  if (typeof v === "string") return `"${v}"`
  return String(v)
}

const result = tryValidate(ProjectSchema, badData)
if (!result.ok) {
  log(`
    tryValidate(ProjectSchema, badData) → ${result.errors.length} errors:
    ${result.errors.map(err => `  ✗ ${err.path}: expected ${err.expected}, got ${describeValue(err.actual)}`).join("\n    ")}
  `)
}

// 10c. validate() throws on invalid data
try {
  validate(ProjectSchema, { ...badData, bio: 42 })
} catch (e) {
  if (e instanceof SchemaValidationError) {
    log(`
        validate() throws SchemaValidationError:
          path: "${e.path}"
          expected: "${e.expected}"
          message: "${e.message}"
    `)
  }
}

// ─── 11. Compositional tree subscriptions ───────────────────────────────

section(11, "Compositional Tree Subscriptions (subscribeTree)")

log(`
    subscribeTree notifies for changes anywhere in a subtree.
    It is part of the [CHANGEFEED] protocol on composite refs —
    no raw context object needed. Each event carries an origin
    path relative to the subscription point.
`)

// Product refs have ComposedChangefeed with subscribeTree
log(`
    hasComposedChangefeed(doc.settings) → ${hasComposedChangefeed(doc.settings)}
    hasComposedChangefeed(doc.tasks) → ${hasComposedChangefeed(doc.tasks)}
    hasComposedChangefeed(doc.name) → ${hasComposedChangefeed(doc.name)}  (leaf — no tree)
`)

const treeEvents: { path: string; type: string }[] = []
const treeUnsub = doc.settings[CHANGEFEED].subscribeTree(
  (changeset: Changeset<TreeEvent>) => {
    for (const event of changeset.changes) {
      treeEvents.push({
        path: formatPath(event.path),
        type: event.change.type,
      })
    }
  },
)

doc.settings.maxTasks.set(999)
doc.settings.visibility.set("private")

log(`
    After 2 leaf mutations (maxTasks, visibility):
      ${treeEvents.length} tree events received:
      ${treeEvents.map(e => `  path: ${e.path}, type: ${e.type}`).join("\n      ")}
`)

// Contrast: product .set() dispatches at the product path, not at each leaf
doc.settings.set({ visibility: "public", maxTasks: 100, archived: false })

const last = treeEvents[treeEvents.length - 1]!
log(`
    After doc.settings.set({...}) — 1 product-level dispatch:
      ${treeEvents.length} total tree events (${treeEvents.length - 2} new):
        path: ${last.path}, type: ${last.type}

    Leaf .set() → path includes the scalar segment (e.g. settings.maxTasks)
    Product .set() → path is [] (change is at the subscription point itself)
`)

treeUnsub()
doc.settings.maxTasks.set(100) // not observed

// ─── 12. Transaction + tree subscription integration ────────────────────

section(12, "Transaction + Tree Subscription Integration")

log(`
    During a transaction, dispatch buffers changes — the store is
    unchanged and changefeed subscribers do NOT fire. On commit,
    changes replay through dispatch, so subscribers fire exactly
    once per change at commit time.
`)

const txEvents: { path: string; type: string }[] = []
doc.settings[CHANGEFEED].subscribeTree((changeset: Changeset<TreeEvent>) => {
  for (const event of changeset.changes) {
    txEvents.push({
      path: formatPath(event.path),
      type: event.change.type,
    })
  }
})

// Use the transaction API directly (change() wraps this)
const ctx = (doc as any)[TRANSACT] as WritableContext
ctx.beginTransaction()
doc.settings.visibility.set("private")
doc.settings.maxTasks.set(42)

log(`
    After 2 mutations inside transaction (before commit):
      txEvents.length → ${txEvents.length}  (zero — notifications suppressed)
      doc.settings.visibility() → "${doc.settings.visibility()}"  (store unchanged)
`)

const flushed = ctx.commit()

log(`
    After commit:
      txEvents.length → ${txEvents.length}  (fired at commit time)
      flushed.length → ${flushed.length}
      doc.settings.visibility() → "${doc.settings.visibility()}"  (store updated)
      doc.settings.maxTasks() → ${doc.settings.maxTasks()}
`)

// Restore
doc.settings.set({ visibility: "public", maxTasks: 100, archived: false })

// ─── 13. Read-only documents ────────────────────────────────────────────

section(13, "Read-Only Documents")

log(`
    The readable layer alone produces a callable, navigable document
    with no mutation methods and no dispatch context.
`)

{
  const roStore = { ...doc.toJSON() }
  const roCtx: RefContext = { store: roStore }

  // Manual composition — equivalent to .with(readable).done()
  const readableInterpreter = withCaching(withReadable(bottomInterpreter))
  const roDoc = interpret(
    ProjectSchema,
    readableInterpreter,
    roCtx,
  ) as Readable<typeof ProjectSchema>

  log(`
      const roDoc = interpret(schema, readableInterpreter, { store })
      roDoc.name() → "${roDoc.name()}"
      roDoc.stars() → ${roDoc.stars()}
      roDoc.settings.visibility() → "${roDoc.settings.visibility()}"
      roDoc.tasks.at(0).title() → "${roDoc.tasks.at(0)!.title()}"
      roDoc.tasks.length → ${roDoc.tasks.length}
      typeof roDoc.name → "${typeof roDoc.name}" (function-shaped ref)

      // No mutation methods:
      "set" in roDoc.stars → ${"set" in roDoc.stars}
      "insert" in roDoc.name → ${"insert" in roDoc.name}
      "increment" in roDoc.stars → ${"increment" in roDoc.stars}

      // No observation:
      hasChangefeed(roDoc.name) → ${hasChangefeed(roDoc.name)}
      hasTransact(roDoc.name) → ${hasTransact(roDoc.name)}
  `)
}

// ─── 14. Template literal coercion via toPrimitive ──────────────────────

section(14, "Template Literal Coercion (toPrimitive)")

log(`
    Leaf refs support [Symbol.toPrimitive] — no ref() call needed
    in template literals or coercion contexts.

    \`Project: \${doc.name}\` → "Project: ${doc.name}"
    \`Stars: \${doc.stars}\` → "Stars: ${doc.stars}"
    \`Desc: \${doc.description}\` → "Desc: ${doc.description}"

    // Hint-aware coercion:
    +doc.stars → ${+doc.stars}  (number hint)
    String(doc.name) → "${String(doc.name)}"  (string hint)
    doc.stars[Symbol.toPrimitive]("number") → ${doc.stars[Symbol.toPrimitive]("number")}
    doc.stars[Symbol.toPrimitive]("string") → "${doc.stars[Symbol.toPrimitive]("string")}"
`)

// ─── 15. The composition algebra ────────────────────────────────────────

section(15, "The Composition Algebra")

log(`
    Four composable interpreter layers, independently useful:

      Fluent builder API:
        interpret(schema, ctx)
          .with(readable)              → read-only callable refs
          .with(writable)              → read + mutation
          .with(changefeed)            → read + mutation + observation
          .done()

      Manual composition (equivalent):
        withChangefeed(withWritable(withCaching(withReadable(bottomInterpreter))))

    Each level adds only the context it needs:
      RefContext        { store }
      WritableContext   { store, dispatch, beginTransaction, commit, abort }

    Symbol-keyed composability hooks:
      [READ]        — controls what carrier() does (bottomInterpreter → withReadable)
      [INVALIDATE]  — change-driven cache invalidation (withCaching → withWritable)
      [TRANSACT]    — context discovery from any ref (withWritable)
      [CHANGEFEED]  — observation coalgebra with subscribeTree (withChangefeed)
`)

// ─── 16. Final Snapshot ─────────────────────────────────────────────────

section(16, "Final Snapshot")
showDoc()
