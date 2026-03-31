// ═══════════════════════════════════════════════════════════════════════════
//
//   @kyneta/loro-schema — Your First Collaborative Document
//
//   Same schema, same API as @kyneta/schema — but backed by Loro CRDTs.
//   Two peers, independent edits, automatic merge. No conflict resolution
//   code. No merge functions. It just works.
//
//   Run with:  bun run example/basic/main.ts   (from packages/schema-loro/)
//
// ═══════════════════════════════════════════════════════════════════════════

import {
  change,
  createLoroDoc,
  createLoroDocFromEntirety,
  exportEntirety,
  exportSince,
  LoroSchema,
  merge,
  Schema,
  subscribe,
  version,
} from "../../src/index.js"

import { json, log, peer, section } from "../helpers.js"

// ═══════════════════════════════════════════════════════════════════════════
//
//   1. DEFINE A SCHEMA
//
// ═══════════════════════════════════════════════════════════════════════════

section(1, "Define a Schema")

const NoteSchema = LoroSchema.doc({
  title: LoroSchema.text(),
  likes: LoroSchema.counter(),
  tags: Schema.list(Schema.string()),
  tasks: Schema.list(
    Schema.struct({
      text: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

log(`
    const NoteSchema = LoroSchema.doc({
      title: LoroSchema.text(),       // collaborative rich text
      likes: LoroSchema.counter(),    // convergent counter
      tags:  Schema.list(string()),   // plain list
      tasks: Schema.list(struct({     // list of structs
        text: Schema.string(),
        done: Schema.boolean(),
      })),
    })
`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   2. CREATE A DOCUMENT
//
// ═══════════════════════════════════════════════════════════════════════════

section(2, "Create a Document")

const doc = createLoroDoc(NoteSchema, { title: "Meeting Notes" })

log(`
    const doc = createLoroDoc(NoteSchema, { title: "Meeting Notes" })

    doc.title() → "${doc.title()}"
    doc.likes() → ${doc.likes()}
    doc.tags.length → ${doc.tags.length}
    doc.tasks.length → ${doc.tasks.length}
`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   3. MUTATE AND READ
//
// ═══════════════════════════════════════════════════════════════════════════

section(3, "Mutate and Read")

change(doc, d => {
  d.title.insert(13, " (Q4)")
  d.likes.increment(3)
  d.tags.push("planning")
  d.tasks.push({ text: "Review budget", done: false })
})

log(`
    change(doc, d => {
      d.title.insert(13, " (Q4)")
      d.likes.increment(3)
      d.tags.push("planning")
      d.tasks.push({ text: "Review budget", done: false })
    })

    doc.title()            → "${doc.title()}"
    doc.likes()            → ${doc.likes()}
    doc.tags.at(0)()       → "${(doc.tags.at(0) as any)()}"
    doc.tasks.at(0).text() → "${(doc.tasks.at(0) as any).text()}"
    doc.tasks.at(0).done() → ${(doc.tasks.at(0) as any).done()}
`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   4. TWO PEERS, INDEPENDENT EDITS
//
//   This is where CRDTs shine. Two peers start from the same state,
//   make completely independent edits (no communication), and then
//   sync. The result is a merged document that preserves all edits.
//
// ═══════════════════════════════════════════════════════════════════════════

section(4, "Two Peers, Independent Edits")

// Both peers start from the same snapshot
const snapshot = exportEntirety(doc)
const peerA = createLoroDocFromEntirety(NoteSchema, snapshot)
const peerB = createLoroDocFromEntirety(NoteSchema, snapshot)

log(`Two peers created from the same snapshot.`)
log(`Both start with: title="${peerA.title()}", likes=${peerA.likes()}\n`)

// Peer A: edits the title and adds a tag
change(peerA, d => {
  d.title.insert(0, "📋 ")
  d.tags.push("important")
})
peer("A", `title="${peerA.title()}", tags=[${peerA.tags.length} items]`)

// Peer B: increments likes and adds a task
change(peerB, d => {
  d.likes.increment(10)
  d.tasks.push({ text: "Send invites", done: false })
})
peer("B", `likes=${peerB.likes()}, tasks=[${peerB.tasks.length} items]`)

log(`
    Before sync:
      Peer A sees its own edits but not B's.
      Peer B sees its own edits but not A's.
`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   5. SYNC — THE WOW MOMENT
//
//   Three lines. Both peers converge to the same state.
//   Text merged character-by-character. Counters summed.
//   Lists have both items. No conflict resolution code.
//
// ═══════════════════════════════════════════════════════════════════════════

section(5, "Sync — Both Peers Converge")

const vA = version(peerA)
const vB = version(peerB)

// Exchange deltas (just the changes since the other peer's version)
const deltaAtoB = exportSince(peerA, vB)
const deltaBtoA = exportSince(peerB, vA)
if (deltaAtoB) merge(peerB, deltaAtoB)
if (deltaBtoA) merge(peerA, deltaBtoA)

log(`
    Synced! Both peers now have identical state:
`)

peer("A", `title="${peerA.title()}"`)
peer("A", `likes=${peerA.likes()}`)
peer(
  "A",
  `tags=[${Array.from({ length: peerA.tags.length }, (_, i) => `"${(peerA.tags.at(i) as any)()}"`).join(", ")}]`,
)
peer(
  "A",
  `tasks=[${Array.from({ length: peerA.tasks.length }, (_, i) => `"${(peerA.tasks.at(i) as any).text()}"`).join(", ")}]`,
)

console.log()

peer("B", `title="${peerB.title()}"`)
peer("B", `likes=${peerB.likes()}`)
peer(
  "B",
  `tags=[${Array.from({ length: peerB.tags.length }, (_, i) => `"${(peerB.tags.at(i) as any)()}"`).join(", ")}]`,
)
peer(
  "B",
  `tasks=[${Array.from({ length: peerB.tasks.length }, (_, i) => `"${(peerB.tasks.at(i) as any).text()}"`).join(", ")}]`,
)

log(`
    ✓ Title: A's emoji prefix merged with the original text
    ✓ Likes: A's 3 + B's 10 = 13 (counters sum, not overwrite)
    ✓ Tags: both peers' additions are present
    ✓ Tasks: both peers' additions are present
`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   6. SUBSCRIBE ACROSS SYNC
//
//   Subscribers fire when remote changes arrive — not just local edits.
//
// ═══════════════════════════════════════════════════════════════════════════

section(6, "Subscribe Across Sync")

const events: string[] = []
subscribe(peerB, () => {
  events.push(`peerB updated → title="${peerB.title()}"`)
})

// Peer A makes a new edit
change(peerA, d => d.title.insert(peerA.title().length, " ✅"))

// Sync A → B
const newDelta = exportSince(peerA, version(peerB))
if (newDelta) merge(peerB, newDelta)

log(`
    subscribe(peerB, () => { ... })

    Peer A edits: d.title.insert(end, " ✅")
    Sync A → B:   merge(peerB, delta)

    Events received by peerB's subscriber:
`)

for (const e of events) {
  log(`      → ${e}`)
}

log(`
    ✓ Subscriber fired on remote sync, not just local edits
`)

// ═══════════════════════════════════════════════════════════════════════════
//
//   7. SNAPSHOT AND RESTORE
//
//   Full state can be exported and used to create a new peer — useful
//   for SSR, persistence, or onboarding a new collaborator.
//
// ═══════════════════════════════════════════════════════════════════════════

section(7, "Snapshot and Restore")

const fullSnapshot = exportEntirety(peerA)
const peerC = createLoroDocFromEntirety(NoteSchema, fullSnapshot)

log(`
    const snapshot = exportEntirety(peerA)
    const peerC = createLoroDocFromEntirety(NoteSchema, snapshot)

    Snapshot size: ${(fullSnapshot.data as Uint8Array).byteLength} bytes (binary, compact)

    peerC.title()      → "${peerC.title()}"
    peerC.likes()      → ${peerC.likes()}
    peerC.tags.length  → ${peerC.tags.length}
    peerC.tasks.length → ${peerC.tasks.length}
`)

// Peer C can immediately start editing
change(peerC, d => d.title.insert(0, "🆕 "))
log(`    Peer C edits: d.title.insert(0, "🆕 ")`)
log(`    peerC.title() → "${peerC.title()}"`)

log(`
    ✓ New peer reconstructed from snapshot with full state
    ✓ Immediately functional — can read, write, and sync
`)

// ═══════════════════════════════════════════════════════════════════════════

console.log()
log(`Done! The same typed ref API you already know, now with automatic`)
log(`conflict-free collaboration. No merge functions. No conflict`)
log(`resolution code. Just define a schema and start editing.`)
console.log()
