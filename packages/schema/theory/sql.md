# SQLite as a Schema Substrate

> Theory document. No implementation exists yet. This captures design
> analysis, architectural options, and composition patterns explored
> in preparation for a future `@kyneta/schema-sqlite` package.

---

## 1. The Question

The plain substrate is a `Record<string, unknown>` in memory. The Loro
substrate is a `LoroDoc` in memory. The Yjs substrate is a `Y.Doc` in
memory. All three are single-document, in-process, tree-shaped state
objects. A SQLite substrate breaks this model in several ways worth
thinking through carefully.

**Option A: SQLite as a durable mirror of the in-memory model.** The
`StoreReader` reads from an in-memory cache (same as plain substrate),
and `prepare`/`onFlush` write-through to SQLite. This is basically
`PlainSubstrate` with persistence bolted on. Useful but not
interesting — you could do it in 50 lines by wrapping
`createPlainSubstrate` with a flush hook.

**Option B: SQLite as the source of truth.** The `StoreReader` issues
actual SQL queries on every read. `prepare` executes SQL statements.
`onFlush` commits the transaction and captures the changeset. This is
the hard version, and the one worth building, because it proves the
abstraction works when the backing store has fundamentally different
access patterns.

This document focuses on Option B.

---

## 2. The Schema → SQL Mapping

The schema grammar maps well to relational structure:

```/dev/null/mapping.txt#L1-13
Schema.struct({                          →  database "my_doc"
  title: Schema.string(),             →  column "title" TEXT on root table
  count: Schema.number(),             →  column "count" REAL on root table
  settings: Schema.struct({           →  either embedded JSON or a child table
    theme: Schema.string(),
    fontSize: Schema.number(),
  }),
  tags: Schema.list(Schema.string()), →  child table "tags" (parent_id, idx, value)
  posts: Schema.list(Schema.struct({  →  child table "posts" (id, title, body)
    title: Schema.string(),
    body: Schema.string(),
  })),
})
```

There's a design choice at every composite node: **embed or normalize?**
A `Schema.struct` inside a `Schema.struct` could be a JSON column or a 1:1
joined table. A `Schema.list(Schema.string())` could be a JSON array
column or a child table with an index column.

The schema carries enough information to make this decision mechanically.
A default policy:

- Scalars → columns on the parent table
- Products (all-scalar fields) → columns on the parent table
- Products (nested composites) → child table with FK + 1:1 constraint
- Sequences of scalars → JSON array column
- Sequences of products → child table with `_idx` column
- Maps → child table with `_key` column

User overrides via annotations: `Schema.annotated("embedded",
Schema.struct(...))` vs. `Schema.annotated("table",
Schema.struct(...))`.

### Algebraic properties

The schema grammar is an **initial algebra with a closed set of
structural combinators** — no reference types, no cycles, no
many-to-many relationships. It's a tree grammar, and relational
databases represent trees perfectly well (adjacency list / nested set).

The mapping is a **catamorphism** (fold over the initial algebra) that
produces DDL. It is:

- **Total** — defined for every schema
- **Injective** — different schemas produce different table layouts
- **Lossless** — every schema node has a well-defined SQL representation

This is why the mapping avoids the classic ORM impedance mismatch. ORMs
must handle arbitrary object graphs (inheritance hierarchies,
bidirectional references, lazy-loaded collections, identity maps). The
schema algebra forbids the constructs that cause those problems.

---

## 3. The StoreReader

The interpreter stack reads from the store exclusively through this
interface:

```packages/schema/src/store.ts#L35-40
export interface StoreReader {
  read(path: Path): unknown
  arrayLength(path: Path): number
  keys(path: Path): string[]
  hasKey(path: Path, key: string): boolean
}
```

All four methods are synchronous. This is not a soft assumption — the
entire interpreter stack (`withNavigation`, `withReadable`, `withCaching`,
`withWritable`, `withChangefeed`) depends on synchronous reads. This
rules out async-only SQL libraries and mandates `better-sqlite3` (which
is synchronous by design).

### The N+1 problem

When iterating a list of 100 posts, the interpreter calls:
- `arrayLength([{key: "posts"}])` → 1 query
- For each post i: `read([...path, {index: i}, {key: "title"}])` → 100 queries
- For each post i: `read([...path, {index: i}, {key: "body"}])` → 100 queries

That's 201 queries. This is structural — baked into the `StoreReader`
interface, which was designed for O(1) in-memory access.

### Mitigation strategies

**Lazy reader** — each `read()` is a prepared statement execution.
Great for sparse access (read one field of a large document). SQLite
prepared statements are sub-microsecond for simple lookups.

**Prefetching reader** — on first access to a table, load all rows
into a `Map`. Subsequent reads are memory lookups. Invalidate on flush.

**Hybrid** — scalars and small products: lazy. Lists: prefetch the
whole list on first `.length` or `.at()` access. Probably the sweet
spot.

The `StoreReader` interface doesn't care which strategy is used. The
interpreter stack is oblivious.

### Honest assessment

The `StoreReader` interface is fundamentally a **navigator**
(step-by-step path traversal), not a **query planner** (declarative
data needs). SQL is powerful precisely because it separates "what you
want" from "how to get it." The `StoreReader` throws away that
separation by forcing point-access patterns. This is a real limitation
— the SQL substrate can never expose SQL's set-oriented query power
through the `Ref<S>` API. The user always thinks in document terms; the
substrate translates behind the scenes.

---

## 4. The Version Story: Session-Based Change Capture

This is where the design gets its most distinctive character. SQLite's
**session extension** (`sqlite3session`) records row-level diffs as
binary changesets.

```/dev/null/session-concept.ts#L1-12
const session = db.session()
session.attach()  // track all tables

// ... any SQL mutations happen here ...
db.exec("UPDATE posts SET published = 1 WHERE _idx = 3")
db.exec("INSERT INTO posts (_idx, title, body) VALUES (10, 'New', '')")

// Extract the changeset — binary encoding of all mutations
const changeset = session.changeset()  // Uint8Array

// Changeset can be applied to another database with the same schema:
// otherDb.applyChangeset(changeset)
session.close()
```

For each affected row, the changeset contains:
- Table name
- Operation type (INSERT, UPDATE, DELETE)
- For UPDATE: old PK values + new column values (changed columns only)
- For INSERT: all column values
- For DELETE: PK values

### The session as the oplog

The key insight: **the session extension is agnostic to mutation source.**
It captures row-level diffs regardless of whether they came from
`prepare()` (schema API) or raw SQL statements. This means the SQL
database can be its own oplog, and the oplog is complete.

```/dev/null/session-as-oplog.txt#L1-12
Session is always recording.

Mutation via schema API:
  change(blog, b => b.posts.at(3).published.set(true))
    → prepare(path, change)
      → UPDATE posts SET published = 1 WHERE _idx = 3
        → session captures it

Mutation via raw SQL:
  db.exec("UPDATE posts SET published = 1 WHERE _idx = 3")
    → session captures it

Both produce the same changeset entry.
```

### Versioning via changeset log

```/dev/null/schema.sql#L1-5
CREATE TABLE _changelog (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  changeset BLOB NOT NULL,           -- binary session changeset
  created_at INTEGER DEFAULT (unixepoch())
);
```

On each flush: extract changeset from session → append to `_changelog`
→ bump version counter → start new session.

`exportSince(v)` returns concatenated changesets from `_changelog WHERE
version > ?`. `exportSnapshot()` returns JSON-serialized full state (or
the raw `.db` file). `importDelta()` applies a binary changeset via
`db.applyChangeset()`.

This maps directly to `PlainVersion` (monotonic integer, total order).
Reuse `PlainVersion` as-is.

### Other versioning options (rejected or deferred)

- **WAL position** — fragile, checkpointing destroys old entries.
- **Shadow op log (JSON)** — simpler but misses out-of-band SQL writes.
  The session extension subsumes this.

---

## 5. The Change Mapping

### Forward: Op → SQL (`prepare` path)

- `ReplaceChange` at scalar path → `UPDATE table SET column = ? WHERE ...`
- `MapChange` on product → `UPDATE table SET col1 = ?, col2 = ? WHERE ...` (for `set`) + column NULLing (for `delete`)
- `SequenceChange` on list → cursor walk → `INSERT`, `DELETE`, re-index `UPDATE ... SET _idx = _idx + ?`
- `IncrementChange` → `UPDATE table SET column = column + ? WHERE ...`
- `TextChange` → read current string, apply `stepText`, write back as `ReplaceChange`. Text columns are atomic from SQL's perspective.

The `SequenceChange` cursor-to-index translation is the hardest part.
The cursor instructions describe a linear scan with mutations, which
must become absolute-position SQL operations with re-indexing. An insert
at position 0 in a 10,000-row table means `UPDATE SET _idx = _idx + 1
WHERE _idx >= 0` — touching every row. This is O(n) in the worst case,
inherent to indexed-sequence-in-SQL.

Mitigation: gap-based indexing (use floating-point `_idx` values with
gaps, only re-index when gaps are exhausted).

### Reverse: Session Changeset → Op[] (`flush` path)

This is the genuinely novel direction. On flush, the session changeset
contains row-level diffs. The schema provides the mapping back to typed
ops:

```/dev/null/reverse-example.txt#L1-6
Changeset entry:
  Table: "posts", Op: UPDATE, PK: (_idx = 3), Old: {published: 0}, New: {published: 1}

Derived Op:
  path: [{key:"posts"}, {index:3}, {key:"published"}]
  change: {type:"replace", value: true}
```

For `UPDATE` on a scalar column, the reverse mapping is unambiguous.

For `INSERT`/`DELETE` in child tables, the reverse mapper must
reconstruct a `SequenceChange` from batched row-level diffs. All changes
to the same table are collected, sorted by operation type and `_idx`,
and the cursor instruction sequence is reconstructed. This is a
non-trivial but pure function from `(table_changes, schema)` →
`SequenceChange`.

### Why the reverse mapping matters

It enables **out-of-band SQL writes** to flow into the changefeed:

```/dev/null/outofband.txt#L1-10
Admin runs:  UPDATE posts SET published = 1 WHERE reviewed = 1;
      │
      ▼
Session captures: row changes for posts at _idx 3, 7, 12
      │
      ▼
Flush extracts changeset → reverse map → Op[]
      │
      ▼
Changefeed fires → all connected clients see posts become published
```

The session extension unifies all mutation sources. Schema API writes
and raw SQL writes produce the same changeset entries. The reverse
mapper converts them all to typed ops. The changefeed doesn't know or
care where the mutation originated.

---

## 6. The Changefeed Bridge

The `prepare()` method executes SQL directly. The session records
everything. On `onFlush()`:

1. Extract changeset from session
2. Convert entire changeset → `Op[]` via schema-driven reverse mapping
3. Deliver all ops through changefeed (with re-entrancy guard)
4. Append changeset to `_changelog`
5. Bump version
6. Start new session

This means `prepare()` doesn't need to track what it did — the session
IS the op buffer. The flush cycle reads the session's changeset and
derives ops via the reverse mapping.

For `importDelta()` (receiving a changeset from another peer): apply
the changeset to the database, then the session captures the resulting
row changes, and the next flush delivers them through the changefeed.
A `pendingImportOrigin` stash (same pattern as Loro/Yjs substrates)
carries the origin tag for subscriber filtering.

---

## 7. Abstraction Quality Assessment

### Where the abstraction is sound

The schema → SQL mapping is a total, injective catamorphism. Every
schema node has a lossless SQL representation. The `Substrate` interface
(`prepare`, `onFlush`, `version`, `exportSnapshot`, `exportSince`,
`importDelta`) maps cleanly to SQLite primitives. Cross-substrate
interop works via the synchronizer's Strategy 2 fallback (reconstruct →
replay as `ReplaceChange` ops).

### Where the abstraction strains

1. **Performance opacity.** The user can't predict, from the `Ref<S>`
   API alone, whether an operation is O(1) in-memory or O(n) disk I/O.
   A list insert at position 0 is O(n) array splice in PlainSubstrate,
   O(log n) CRDT op in Loro, but O(n) SQL row reindexing on disk in
   SqliteSubstrate — potentially orders of magnitude slower.

2. **No set-oriented queries.** SQL's power is `SELECT ... WHERE ...
   ORDER BY ... LIMIT`. The `Ref<S>` API is document-shaped: navigate
   to a node, read it. There's no way to express "all posts matching
   a predicate" through the change algebra. The user must iterate,
   filter, and emit individual ops.

3. **TextChange degeneracy.** `TextChange` (character-level
   retain/insert/delete) has no natural SQL mapping. Text columns are
   atomic. The SQL substrate falls back to whole-string replacement —
   meaning character-level collaboration is not possible through this
   substrate. For collaboration, use Loro or Yjs.

4. **Schema evolution.** In-memory substrates are ephemeral — schema
   changes mean restarting with new defaults. A persistent SQLite
   database needs migration logic (`ALTER TABLE` generation from schema
   diffs). The schema algebra has no concept of migration today.

### Honest positioning

The SQL substrate is not an ORM. It's a **server-side persistence
substrate** that makes document data queryable while participating in
the exchange protocol. It is inherently `strategy: "sequential"` —
total order, server authority, no concurrent versions. It is not a
collaborative substrate.

---

## 8. Three Ways to Compose SQL with the Architecture

The SQL substrate is not the only way to get SQL into the picture. There
are three composition patterns, each answering a different need.

### 8a. Storage Adapter (Opaque Persistence)

A `StorageAdapter` persists `SubstratePayload` blobs to a backing store
(LevelDB, SQLite-as-KV, IndexedDB, filesystem). The database never sees
the document structure — it stores opaque `Uint8Array` chunks. On
restart, the exchange syncs from the storage adapter like any other peer.

The kyneta exchange already has the `"storage"` channel kind
infrastructure (ported from loro-extended). The `StorageAdapter` base
class, `waitForSync({ kind: "storage" })`, and storage-channel routing
in the synchronizer program all exist today.

```/dev/null/storage-adapter.txt#L1-8
LoroSubstrate (CRDT, in-memory)
      │
      └── StorageAdapter (opaque blobs → LevelDB/SQLite-KV)
            └── durability ✅
            └── queryability ❌
            └── collaboration ✅ (Loro handles it)
```

**Value:** durable persistence for any substrate. **Limitation:** data
is structurally invisible to the database. No queries, no analytics, no
SQL tooling.

**Build this first.** It's simpler, immediately useful, gives
persistence to all existing substrates, and the infrastructure is
already in place.

### 8b. Schema-Driven Projection (Read-Only Materialized View)

A `SchemaProjection` subscribes to a ref's changefeed and projects
changes to a SQL database. The CRDT substrate is the source of truth;
the SQL database is a derived, queryable artifact.

```/dev/null/projection.txt#L1-8
LoroSubstrate (source of truth)
      │
      ├── StorageAdapter (durability)
      │
      └── subscribe() → SchemaProjection
            └── SQLite (.db)
                  └── queryability ✅
                  └── read-only (no writes back to CRDT)
                  └── collaboration ✅ (Loro handles it)
```

Developer API:

```/dev/null/projection-api.ts#L1-11
import { projectToSql } from "@kyneta/schema-sqlite"

const blogProjection = projectToSql(BlogSchema, { path: "./blog.db" })
blogProjection.attach(blogRef)

// blog.db is now a live, queryable materialized view
const recentPosts = blogProjection.db.prepare(
  "SELECT * FROM posts WHERE published = 1 ORDER BY _idx DESC LIMIT 10"
).all()
```

**Value:** queryable SQL alongside CRDT collaboration. Clean separation
of concerns. The projection is a library, not a substrate — it
composes with any substrate via the changefeed protocol. Detachable and
rebuildable from current ref state.

**Limitation:** SQL database is read-only. Out-of-band SQL writes are
not supported.

**Implementation note:** this requires the same schema → DDL
catamorphism and change → SQL translation as the full substrate, but
skips `StoreReader`, versioning, `exportSnapshot`, `exportSince`,
`importDelta`. Roughly half the implementation work.

### 8c. SQL-Native Substrate (Full Substrate + Out-of-Band Writes)

The SQL database IS the substrate. The session extension captures ALL
mutations (schema API + raw SQL). The changefeed delivers ops derived
from session changesets. The version log stores binary changesets for
`exportSince`.

```/dev/null/sql-substrate.txt#L1-10
SqliteSubstrate (source of truth)
      │
      ├── prepare(path, change) → executes SQL
      ├── raw SQL writes → also captured by session
      │
      ├── onFlush() → session changeset → reverse map → Op[]
      │                → changefeed fires
      │                → changeset appended to _changelog
      │
      └── queryability ✅, durability ✅, out-of-band writes ✅
          collaboration ❌ (sequential only)
```

```/dev/null/sql-substrate-arch.txt#L1-18
┌────────────────────────────────────────────────────────┐
│  SqliteSubstrate                                        │
│                                                         │
│  ┌──────────────┐     ┌────────────────┐               │
│  │  Session ext. │────▶│  Changeset log  │─ exportSince()│
│  │  (always on)  │     │  (_changelog)   │              │
│  └──────┬───────┘     └────────────────┘               │
│         │ captures all mutations                        │
│  ┌──────┴────────────────────────────┐                 │
│  │          SQLite database           │                 │
│  │   _root: (title TEXT, ...)         │◀─ prepare()     │
│  │   posts: (_idx, title, body, ...)  │◀─ raw SQL       │
│  │   _changelog: (version, changeset)│◀─ importDelta() │
│  └───────────────────────────────────┘                 │
│         │                                               │
│         │ on flush: changeset → reverse map → Op[]      │
│         ▼                                               │
│  ┌──────────────┐                                      │
│  │  Changefeed   │─ subscribers see ALL mutations       │
│  └──────────────┘                                      │
└────────────────────────────────────────────────────────┘
```

**Value:** the most complete story. One schema drives DDL, typed API,
reactivity, sync, AND queryable persistence. External processes (admin
tools, batch jobs, migrations) can write raw SQL and their changes
propagate to connected clients via the changefeed.

**Limitation:** no CRDT merge semantics. `strategy: "sequential"` only.
The SequenceChange cursor-to-index translation and the reverse mapping
(changeset → Op[]) are the hardest implementation pieces.

### Comparison matrix

| | Storage Adapter | Projection | SQL Substrate |
|---|---|---|---|
| Queryable SQL | ❌ | ✅ (read-only) | ✅ (read + write) |
| Out-of-band SQL writes | N/A | ❌ | ✅ |
| CRDT collaboration | ✅ | ✅ | ❌ |
| Durability | ✅ | ✅ (derived) | ✅ (native) |
| Implementation effort | Low | Medium | High |
| Backing substrate | Any | Any (via changefeed) | Self (is the substrate) |

### Recommendation: build in order

1. **Storage Adapter** — immediate value, low effort, enables
   persistence for Loro/Yjs substrates.
2. **Schema-Driven Projection** — medium effort, shares the schema →
   DDL and change → SQL work with option 3, gives queryability
   alongside CRDT collaboration.
3. **SQL-Native Substrate** — high effort, proves the algebra's
   generality, enables out-of-band SQL writes, the full "have your
   cake and eat it too" story.

Options 2 and 3 share the same core implementation work: schema → DDL
catamorphism + change → SQL forward mapping. Option 3 additionally
requires the reverse mapping (changeset → Op[]) and the `StoreReader`.

---

## 9. Out-of-Band SQL Writes: The Bidirectional Problem

The moment SQL writes flow back into the schema store, you move from a
projection (one-way derivation) to a **bidirectional synchronization**.
This is categorically harder.

A materialized view is a morphism: `CRDT state → SQL tables`.
A bidirectional sync is a **lens**: a pair of morphisms
(`get: state → SQL`, `put: SQL × state → state`) that must satisfy
round-trip laws.

### Why the session extension solves it for the SQL substrate

In composition 8c (SQL-native substrate), the session extension
eliminates the bidirectional problem by making the SQL database the
sole authority. There is no separate state to sync with. The session
captures all mutations — schema API and raw SQL alike — into a single
changeset. The reverse mapper converts changesets to ops. The changefeed
delivers ops to subscribers.

There is no second authority. No lens laws to maintain. No conflict
resolution between SQL writes and CRDT writes. The database is the
state.

### Why it's harder for the projection pattern

In composition 8b (projection), the CRDT is the authority and the SQL
database is derived. An out-of-band SQL write creates a second mutation
authority with no shared concurrency model. You'd need:

1. **Detection** — triggers or `sqlite3_update_hook` to capture changes
2. **Reverse mapping** — row changes → schema ops (same algorithm)
3. **Application** — route ops through `executeBatch` into the CRDT
4. **Re-entrancy suppression** — prevent the changefeed from projecting
   the same changes back to SQL

This is technically possible but **epistemically suspect**. Two
independent writers mutating the same data through different APIs,
with no shared concurrency model. The failure modes are subtle.

### The command ingestion alternative

Rather than bidirectional sync, external processes can connect to the
exchange as peers and mutate through the schema API:

```/dev/null/command-ingestion.ts#L1-12
// External process connects as an exchange peer
const adminExchange = new Exchange({
  identity: { name: "admin-batch", type: "service" },
  adapters: [new WebSocketAdapter({ url: "ws://localhost:8080" })],
})

const blog = adminExchange.get("blog", BlogDoc)
await sync(blog).waitForSync()

change(blog, b => {
  for (const post of b.posts) {
    if (post.reviewed()) post.published.set(true)
  }
})
```

All mutations flow through the CRDT. The projection remains read-only.
No bidirectional bridge needed. This works for compositions 8a and 8b.

For composition 8c (SQL-native substrate), this isn't needed — the SQL
database natively accepts both schema API writes and raw SQL writes
through the session extension.

---

## 10. Topologies

### Topology 1: Server-Authoritative (The Natural Starting Point)

```/dev/null/topology1.txt#L1-8
┌─────────────────────┐          ┌──────────────────────┐
│  Server              │          │  Browser              │
│                      │  sync    │                       │
│  SqliteSubstrate     │◄────────►│  PlainSubstrate       │
│  (better-sqlite3)    │ exchange │  (in-memory)          │
│                      │          │                       │
│  blog.db on disk     │          │  Ref<S> → DOM         │
└─────────────────────┘          └──────────────────────┘
```

The server is the authoritative peer with `strategy: "sequential"`.
The client uses `bindPlain(BlogSchema)`. The server uses
`bindSql(BlogSchema, { path: "./blog.db" })`. The exchange doesn't
care — different `BoundSchema` for the same document ID, interoperable
via `SubstratePayload`.

Cross-substrate interop works today via the synchronizer's Strategy 2
fallback: reconstruct temp substrate from snapshot → read state as JSON
→ replay as `ReplaceChange` ops. A SQL substrate that exports
`{ encoding: "json", data: JSON.stringify(allTablesAsNestedObject) }`
interoperates with `PlainSubstrate` out of the box, with zero changes
to the exchange.

**Build this first.** Zero browser hacks. Clear value proposition:
your server's database IS the document the client is editing.

### Topology 2: Collaborative + Durable + Queryable

```/dev/null/topology2.txt#L1-14
┌────────────────────────────────────────────────────────┐
│  Server                                                 │
│                                                         │
│  LoroSubstrate (collaboration, source of truth)         │
│       │                                                 │
│       ├── StorageAdapter → LevelDB (durability)         │
│       │                                                 │
│       └── SchemaProjection → SQLite (queryability)      │
│                                                         │
│  Exchange ◄────────────────────────► Clients            │
│                      (PlainSubstrate, in-memory)        │
└────────────────────────────────────────────────────────┘
```

All three concerns: CRDT collaboration via Loro, durable persistence
via storage adapter, queryable SQL via schema-driven projection.
External queries read from SQLite. All writes go through the CRDT.

### Topology 3: Full Stack with Heterogeneous Documents

```/dev/null/topology3.txt#L1-19
┌─────────────────────────────────────────────────┐
│  Server (Node.js)                                │
│                                                  │
│  Exchange                                        │
│  ├── "blog"     → SqliteSubstrate (blog.db)     │
│  ├── "collab"   → LoroSubstrate + StorageAdapter │
│  ├── "presence" → PlainSubstrate (LWW, memory)  │
│  └── adapters: [WebSocketAdapter]                │
│                                                  │
└──────────────────┬──────────────────────────────┘
                   │ WebSocket (exchange protocol)
┌──────────────────┴──────────────────────────────┐
│  Browser                                         │
│                                                  │
│  Exchange                                        │
│  ├── "blog"     → PlainSubstrate (memory)       │
│  ├── "collab"   → LoroSubstrate (memory)        │
│  ├── "presence" → PlainSubstrate (LWW, memory)  │
│  └── adapters: [WebSocketAdapter]                │
└─────────────────────────────────────────────────┘
```

Different documents use different substrates based on their needs.
Blog data in SQLite (queryable, sequential). Collaborative documents
in Loro (CRDT merge). Presence in plain LWW (ephemeral). The exchange
protocol is substrate-agnostic — discover/interest/offer works
regardless of what's behind each substrate.

---

## 11. What This Would Look Like to a Developer

```/dev/null/usage.ts#L1-16
import { bindSql } from "@kyneta/schema-sqlite"
import { Exchange, sync } from "@kyneta/exchange"

const BlogSchema = Schema.struct({
  title: Schema.string(),
  posts: Schema.list(Schema.struct({
    title: Schema.string(),
    body: Schema.string(),
    published: Schema.boolean(),
  })),
})

// Server: SQL substrate
const BlogDoc = bindSql(BlogSchema, { path: "./blog.db" })
const blog = exchange.get("blog", BlogDoc)

blog.title()                        // → SELECT title FROM _root WHERE id = 1
blog.posts.at(0).title()            // → SELECT title FROM posts WHERE _idx = 0
change(blog, b => b.posts.push({ title: "New", body: "", published: false }))
                                     // → INSERT INTO posts ...

// Raw SQL works too — session captures it, changefeed delivers it
blog.db.exec("UPDATE posts SET published = 1 WHERE title LIKE '%release%'")
```

```/dev/null/client-usage.ts#L1-7
// Client: plain substrate, same schema, different binding
const BlogDoc = bindPlain(BlogSchema)
const blog = client.get("blog", BlogDoc)
await sync(blog).waitForSync()

// Client doesn't know it's talking to SQLite
blog.title()  // reads from in-memory plain store, synced from server
```

---

## 12. The Genuinely Novel Claims

**Claim 1: One schema, five concerns.** The same schema definition
drives typing (`Ref<S>`, `Plain<S>`), reactivity (`CHANGEFEED`),
persistence (SQL DDL + transactions), queryability (standard SQL
tooling), and sync (exchange protocol). No other system does this from
a single source of truth.

**Claim 2: The substrate is truly an implementation detail.** Two peers
with completely different backing stores (SQLite on server, plain JS in
browser), different versioning schemes, different storage semantics —
and the same three messages (discover, interest, offer) make them
converge. This is hard to believe without seeing it, which is why
building it matters.

**Claim 3: Out-of-band SQL writes are first-class.** The session
extension captures all mutations regardless of source. Admin scripts,
batch jobs, migration tools, and interactive SQL tools can modify the
database directly, and their changes propagate through the changefeed
to all connected clients. No special bridging required.

---

## 13. Implementation Plan

### Phase 0: Storage Adapter (prerequisite, separate package)

Implement a `StorageAdapter` for the kyneta exchange. Persist
`SubstratePayload` blobs to a backing store. This gives durable
persistence to Loro/Yjs substrates immediately, independent of the
SQL substrate work. The exchange infrastructure (`"storage"` channel
kind, `waitForSync({ kind: "storage" })`) already exists.

### Phase 1: Schema → DDL Catamorphism

Write `schemaToSql(schema)` that produces `CREATE TABLE` statements.
A standalone fold over the schema functor. Forces the embed-vs-normalize
decisions. Shared by both the projection (8b) and the substrate (8c).

Existing utilities: `advanceSchema()` for schema descent,
`unwrapAnnotation()` for stripping annotations, `structuralKind()` for
node discrimination. `Zero.structural(schema)` for default values
(needed for initial table population).

### Phase 2: Change → SQL Forward Mapping

Implement `applyChangeToSql(db, schema, path, change)`. Translates
each `ChangeBase` type to SQL statements. The SequenceChange cursor-
to-index translation is the hardest part — consider gap-based indexing
to mitigate worst-case re-indexing.

### Phase 3: Schema-Driven Projection

Combine phases 1 and 2 into a `projectToSql(schema, opts)` that
returns a projection attachable to any ref via `ref[CHANGEFEED]
.subscribeTree()`. This is useful on its own — read-only queryable
SQL alongside any substrate.

### Phase 4: SqliteStoreReader

Implement the four `StoreReader` methods against a live SQLite database.
Start with the hybrid strategy (lazy scalars, prefetching lists).

### Phase 5: Reverse Mapping (Changeset → Op[])

Implement the session changeset → `Op[]` reverse mapping. Batch row
changes per table, sort by operation type and `_idx`, reconstruct
cursor instructions for `SequenceChange`. This is the hardest
algorithmic piece.

### Phase 6: SqliteSubstrate

Wire together: StoreReader + forward mapping (prepare) + session
management (onFlush) + reverse mapping (changefeed bridge) + changeset
log (versioning) + export/import. Use `strategy: "sequential"`.

### Phase 7: `bindSql` + Exchange Integration

Create `bindSql(schema, opts)` convenience wrapper. Prove
cross-substrate sync: SqliteSubstrate on server ↔ PlainSubstrate on
client, via the exchange.

### Phase 8: Out-of-Band SQL Write Support

Expose the raw `better-sqlite3` database handle. Verify that raw SQL
writes are captured by the always-on session, reverse-mapped to ops,
and delivered through the changefeed.

---

## 14. Open Questions

1. **Does `better-sqlite3` expose the session extension?** Needs
   verification. If not, alternatives: `better-sqlite3` custom build,
   FFI wrapper, or `node-sqlite3` with session support.

2. **Performance of always-on session recording?** SQLite sessions are
   designed to be lightweight, but "always on for every table" has a
   cost. Benchmarking needed.

3. **Can changesets be meaningfully applied across databases?**
   Changesets use primary keys for row identity. If two databases have
   different `_idx` assignments, applying a changeset produces
   nonsense. This constrains `importDelta` to databases that share
   row identity — guaranteed for `strategy: "sequential"` (one
   authority, replicas apply its changesets), breaks for concurrent
   writers.

4. **Gap-based indexing for sequences?** Using floating-point `_idx`
   values with gaps avoids worst-case O(n) re-indexing on every insert.
   Only re-index when gaps are exhausted. Adds complexity but
   dramatically improves list mutation performance.

5. **Schema migration story?** `ALTER TABLE` generation from schema
   diffs is a second catamorphism over pairs of schemas. Not needed
   for MVP but essential for production use.

6. **Postgres generalization?** The core design (schema → DDL, change →
   SQL, session-based CDC) is not SQLite-specific. Postgres has logical
   replication / `wal2json` for CDC, `LISTEN/NOTIFY` for change events.
   A Postgres substrate is architecturally similar but would use async
   I/O (requiring an async `StoreReader` variant or a connection-pool
   prefetch strategy).
