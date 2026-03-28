## What if a "Document" were backed by SQLite?

The plain substrate is a `Record<string, unknown>` in memory. The Loro substrate is a `LoroDoc` in memory. Both are single-document, in-process objects. A SQLite substrate breaks this model in several ways that are worth thinking through carefully.

**Option A: SQLite as a durable mirror of the in-memory model.** The `StoreReader` reads from an in-memory cache (same as plain substrate), and `prepare`/`onFlush` write-through to SQLite. This is the easy version — it's basically `PlainSubstrate` with persistence bolted on. Useful, but not very interesting. You could do this in 50 lines by wrapping `createPlainSubstrate` with a flush hook.

**Option B: SQLite as the source of truth.** The `StoreReader` issues actual SQL queries on every read. `prepare` queues SQL statements. `onFlush` executes them in a transaction. This is the hard version, and it's the one worth building, because it proves the abstraction works when the backing store has fundamentally different access patterns.

Let me focus on Option B because it's where the design gets genuinely novel.

## The Schema → SQL Mapping

Your schema grammar maps surprisingly well to relational structure:

```/dev/null/mapping.txt#L1-13
Schema.doc({                          →  database "my_doc"
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

There's a design choice at every composite node: **embed or normalize?** A `Schema.struct` inside a `Schema.doc` could be a JSON column or a 1:1 joined table. A `Schema.list(Schema.string())` could be a JSON array column or a child table with an index column. A `Schema.list(Schema.struct(...))` almost certainly wants to be a child table.

The interesting insight: **the schema already carries enough information to make this decision mechanically.** The recursive structure tells you nesting depth. The annotation tags tell you semantics. You could define a simple policy:

- Scalars → columns on the parent table
- Products → embedded JSON if all-scalar fields, otherwise a child table
- Sequences of scalars → JSON array column
- Sequences of products → child table with an `_idx` column
- Maps → child table with a `_key` column

Or you could let the user override with annotations — `Schema.annotated("embedded", Schema.struct(...))` vs. `Schema.annotated("table", Schema.struct(...))`. Your annotation mechanism already supports arbitrary tags with metadata.

## The StoreReader: Where It Gets Genuinely Interesting

Here's where the design tension really bites. Look at how the interpreter stack uses `StoreReader`:

```packages/schema/src/store.ts#L35-50
export interface StoreReader {
  read(path: Path): unknown
  arrayLength(path: Path): number
  keys(path: Path): string[]
  hasKey(path: Path, key: string): boolean
}
```

The interpreter calls `read(path)` on every node visit, and the navigation layer calls `arrayLength` and `keys` for collection iteration. For an in-memory object, these are O(1) pointer chases. For SQLite, each call is a query. A naïve implementation where `read([{type:"key",key:"posts"},{type:"index",index:3},{type:"key",key:"title"}])` issues `SELECT title FROM posts WHERE doc_id = ? AND _idx = 3` would work, but it would N+1 query when you iterate a list.

This is actually a **feature, not a bug**, because it surfaces a real architectural question: should the `StoreReader` be lazy (query-per-read) or should it prefetch? The answer depends on usage patterns, and the schema gives you enough information to decide:

**Lazy reader** — Each `read()` is a prepared statement execution. This is great for sparse access patterns (read one field of a large document). SQLite prepared statements are extremely fast — sub-microsecond for simple lookups. `better-sqlite3` is synchronous, so this fits the synchronous `StoreReader` interface perfectly.

**Prefetching reader** — On first access to a table, load all rows into a `Map`. Subsequent reads are memory lookups. Invalidate on flush. This is more like how the Loro store reader works (the Loro container tree is in-memory, navigation is pointer chasing).

**Hybrid** — Scalars and small products: lazy. Lists: prefetch the whole list on first `.length` or `.at()` access. This is probably the sweet spot.

The beautiful thing is that the `StoreReader` interface doesn't care which strategy you pick. The interpreter stack is oblivious.

## The Version Story: Change Data Capture

This is where SQLite gets surprisingly powerful. You have several options for tracking versions:

**1. WAL position.** SQLite's write-ahead log has a monotonic position. You can snapshot the WAL offset as your version. `exportSince(walPosition)` would replay the WAL. But this is fragile — WAL checkpointing destroys old entries.

**2. Shadow changelog table.** Same pattern as `PlainSubstrate`'s `log: Op[][]`, but persisted:

```/dev/null/sql.sql#L1-6
CREATE TABLE _changelog (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  ops TEXT NOT NULL,  -- JSON-serialized Op[]
  created_at INTEGER DEFAULT (unixepoch())
);
```

`onFlush` inserts a row. `exportSince(v)` is `SELECT ops FROM _changelog WHERE version > ?`. `exportSnapshot` dumps the current tables as JSON. This is dead simple and maps directly to `PlainVersion`. You could even reuse `PlainVersion` as-is.

**3. SQLite session extension.** SQLite has a built-in changeset/patchset mechanism (`sqlite3session`) that records row-level diffs. `better-sqlite3` exposes this. A session records INSERT/UPDATE/DELETE operations between two points, and produces a compact binary changeset that can be applied to another database. This maps almost perfectly to your `SubstratePayload`:

```/dev/null/concept.ts#L1-6
exportSince(since: SqliteVersion): SubstratePayload {
  // session was started at 'since' version
  const changeset = session.changeset()
  return { encoding: "binary", data: changeset }
}
importDelta(payload: SubstratePayload): void {
  db.applyChangeset(payload.data)
}
```

This is the most interesting option because it means SQLite is doing its own delta computation — you don't have to track ops manually. The version could be a monotonic counter incremented on each flush, and you'd start a new session per version epoch.

## The Change Mapping: Where Schema Meets SQL

The `prepare(path, change)` contract takes a path and a change. For a SQL substrate:

- `ReplaceChange` at a scalar path → `UPDATE table SET column = ? WHERE id = ?`
- `MapChange` on a product → `UPDATE table SET col1 = ?, col2 = ? WHERE id = ?` (for `set`) + column NULLing (for `delete`)
- `SequenceChange` on a list → This is the interesting one. `retain/insert/delete` cursor ops need to become:
  - `INSERT INTO child_table (_idx, ...) VALUES (?, ...)`
  - `DELETE FROM child_table WHERE _idx = ?`
  - `UPDATE child_table SET _idx = _idx + ? WHERE _idx >= ?` (re-indexing after insert/delete)
- `IncrementChange` → `UPDATE table SET column = column + ? WHERE id = ?`
- `TextChange` → This one genuinely doesn't map to SQL in any natural way. A text column is atomic from SQL's perspective. You'd have to `ReplaceChange` the whole string (read current, apply `stepText`, write back). That's fine — not every change type needs a native mapping.

The `SequenceChange` → SQL translation is the most intellectually interesting part. The cursor-based retain/insert/delete ops describe a linear scan with mutations — you'd walk the instructions, track the cursor position, and emit a batch of SQL statements. The re-indexing is O(n) in the worst case (inserting at position 0 shifts every row), but that's inherent to indexed-sequence-in-SQL, not a limitation of the substrate abstraction.

## The Changefeed: SQLite → Changefeed Bridge

This mirrors the Loro substrate's event bridge pattern. SQLite doesn't have a native change notification mechanism like `LoroDoc.subscribe()`, but you control all writes through `prepare`/`onFlush`, so you can emit changefeeds from the flush path — exactly what `PlainSubstrate` does. For externally-applied changes (via `importDelta`), you'd route through `executeBatch` the same way Loro does.

If you wanted to support external writers (other processes writing to the same SQLite file), you could use `sqlite3_update_hook` (exposed by `better-sqlite3` as `.function()` hooks) to detect external mutations. But that's an advanced feature — the basic version where all writes go through the substrate is sufficient.

## What This Would Actually Look Like to a Developer

```/dev/null/usage.ts#L1-15
import { bindSql } from "@kyneta/schema-sqlite"
import { Exchange, sync } from "@kyneta/exchange"

const BlogSchema = Schema.doc({
  title: Schema.string(),
  posts: Schema.list(Schema.struct({
    title: Schema.string(),
    body: Schema.string(),
    published: Schema.boolean(),
  })),
})

const BlogDoc = bindSql(BlogSchema, { path: "./blog.db" })
const blog = exchange.get("blog", BlogDoc)

blog.title()                        // → SELECT title FROM _root WHERE id = 1
blog.posts.at(0).title()            // → SELECT title FROM posts WHERE _idx = 0
change(blog, b => b.posts.push({ title: "New", body: "", published: false }))
                                     // → INSERT INTO posts ...
```

Same `Ref<S>` API. Same `change()` / `subscribe()` / `sync()` surface. But the data lives on disk in a queryable relational format. You could open the `.db` file in any SQLite tool and see your data as tables.

## The Genuinely Novel Claim

What makes this more than a novelty: the same schema definition that drives your reactive UI also defines your database schema. The same `change()` call that triggers a DOM update also writes to SQLite. The same `subscribe()` that the compiler uses for delta-driven rendering can observe database mutations. And the same `exportSince` / `importDelta` that the exchange uses for peer sync works over SQLite changesets.

One schema. One API. Four concerns (typing, reactivity, persistence, sync) handled by one substrate contract.

## What I'd Recommend Starting With

If you want to build this, I'd suggest a phased approach:

**Phase 1:** Schema → DDL generation. Write a function `schemaToSql(schema)` that produces `CREATE TABLE` statements. This is a standalone catamorphism over your schema functor — it doesn't even need to implement `Substrate`. But it proves the mapping is sound and forces you to make the embed-vs-normalize decisions.

**Phase 2:** `SqliteStoreReader` — implement the four `StoreReader` methods against a live SQLite database. Use `better-sqlite3` for synchronous reads. Start with the lazy (query-per-read) strategy.

**Phase 3:** `SqliteSubstrate` — implement `prepare`, `onFlush`, `version`, `exportSnapshot`. Use the shadow changelog table approach (option 2 above) for versioning. Skip `exportSince` / `importDelta` initially (return `null` from `exportSince`; the exchange falls back to snapshots).

**Phase 4:** `bindSql` + exchange integration. Wire it up with `strategy: "sequential"` and prove it syncs with another peer.

**Phase 5:** Delta support via SQLite sessions or the changelog table. This turns the snapshot-only sync into efficient incremental sync.

The hardest part is Phase 1 (the schema → SQL mapping decisions). Everything else follows from the contracts you've already defined.

## The Honest Starting Point

`better-sqlite3` is a native Node addon. It doesn't run in browsers. `sql.js` (Emscripten-compiled SQLite) does run in browsers, but it operates on an in-memory `Uint8Array` — there's no filesystem, so "persistence" means serializing the entire database to IndexedDB or OPFS on every flush. That's viable but it's not really "SQLite as a database" anymore — it's "SQLite as a serialization format for an in-memory store."

So the realistic topologies are:

## Topology 1: Server-Side Only

The SQLite substrate runs on the server. The client runs a plain or Loro substrate. The exchange bridges them.

```/dev/null/topology1.txt#L1-11
┌─────────────────────┐          ┌──────────────────────┐
│  Server              │          │  Browser              │
│                      │  sync    │                       │
│  SqliteSubstrate     │◄────────►│  PlainSubstrate       │
│  (better-sqlite3)    │ exchange │  (in-memory)          │
│                      │          │                       │
│  blog.db on disk     │          │  Ref<S> → DOM         │
└─────────────────────┘          └──────────────────────┘
```

The server is the authoritative peer. It persists to disk. The client gets a `Ref<S>` backed by a plain in-memory substrate that syncs with the server via the exchange. This is actually the most natural topology — and it's powerful because:

- The server's data is queryable SQL. You can run analytics, backups, migrations with standard SQLite tooling.
- The client doesn't know or care that the server is using SQLite. It sees a `Ref<S>` and the exchange protocol.
- SSR works the same way as the recipe-book example: server renders from its substrate, serializes a snapshot into the HTML, client hydrates from the snapshot into a plain substrate, then the exchange catches it up with any changes that happened since.

The merge strategy would be `"sequential"` — the server has total authority, clients push changes and receive ordered deltas back. This is the classic client-server model, but with the kyneta twist that both sides share the same schema and speak the same change protocol.

This is the topology I'd actually build first, because it requires zero browser hacks and the value proposition is clear: **your server's database IS the document the client is editing.**

## Topology 2: Server-to-Server (Multi-Node)

Multiple server processes, each with their own SQLite file, syncing via the exchange.

```/dev/null/topology2.txt#L1-11
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Node A       │     │  Node B       │     │  Node C       │
│               │sync │               │sync │               │
│  SqliteSubstr │◄───►│  SqliteSubstr │◄───►│  SqliteSubstr │
│  data-a.db    │     │  data-b.db    │     │  data-c.db    │
└──────────────┘     └──────────────┘     └──────────────┘
```

This is Litestream / LiteFS territory — SQLite replication. With `strategy: "sequential"`, one node is the writer and others are read replicas receiving deltas. With the SQLite session extension producing binary changesets, `exportSince` and `importDelta` become native SQLite replication primitives.

This is interesting but niche. The more compelling version is hybrid:

## Topology 3: The Full Stack (Most Interesting)

This is where it gets genuinely compelling. One schema definition drives the entire stack:

```/dev/null/topology3.txt#L1-19
┌─────────────────────────────────────────────────┐
│  Server (Node.js)                                │
│                                                  │
│  Exchange                                        │
│  ├── "blog"     → SqliteSubstrate (blog.db)     │
│  ├── "presence" → PlainSubstrate  (LWW, memory) │
│  └── adapters: [WebSocketAdapter]                │
│                                                  │
└──────────────────┬──────────────────────────────┘
                   │ WebSocket (exchange protocol)
┌──────────────────┴──────────────────────────────┐
│  Browser                                         │
│                                                  │
│  Exchange                                        │
│  ├── "blog"     → PlainSubstrate  (memory)      │
│  ├── "presence" → PlainSubstrate  (LWW, memory) │
│  └── adapters: [WebSocketAdapter]                │
│                                                  │
└─────────────────────────────────────────────────┘
```

The server exchange hosts heterogeneous documents — the blog data lives in SQLite on disk, presence state lives in a plain LWW substrate in memory. The client exchange mirrors both, but everything is in-memory plain substrates. The exchange protocol doesn't care — it's the same discover/interest/offer flow regardless of what's behind the substrate interface on each side.

The developer writes:

```/dev/null/server-code.ts#L1-14
// server.ts
const BlogDoc = bindSql(BlogSchema, { path: "./blog.db" })
const PresenceDoc = bindLww(PresenceSchema)

const server = new Exchange({
  identity: { name: "server", type: "service" },
  adapters: [new WebSocketServerAdapter({ port: 8080 })],
})

const blog = server.get("blog", BlogDoc, { seed: { title: "My Blog" } })
const presence = server.get("presence", PresenceDoc)
```

```/dev/null/client-code.ts#L1-14
// client.ts
const BlogDoc = bindPlain(BlogSchema)      // same schema, different substrate
const PresenceDoc = bindLww(PresenceSchema) // same on both sides

const client = new Exchange({
  identity: { name: "alice" },
  adapters: [new WebSocketAdapter({ url: "ws://localhost:8080" })],
})

const blog = client.get("blog", BlogDoc)
const presence = client.get("presence", PresenceDoc)

await sync(blog).waitForSync()
// blog.title() now reads the server's SQLite data
```

Notice what happened there: **the client and server use different `BoundSchema` for the same document ID.** The client uses `bindPlain(BlogSchema)`, the server uses `bindSql(BlogSchema)`. The exchange doesn't care — the sync protocol works over `SubstratePayload`, which is opaque. As long as the server's `exportSnapshot` produces JSON that the client's `PlainSubstrateFactory.fromSnapshot` can consume (or vice versa), they interoperate.

This is already true today between `bindPlain` and `bindLoro` — the snapshot import strategy in the synchronizer tries `importDelta` first, then falls back to reconstructing via `fromSnapshot`, then falls back to replaying as `ReplaceChange` ops. A SQL substrate that exports JSON snapshots would slot into this chain naturally.

## The Key Realization

The SQLite substrate doesn't need to run on the client at all. It's a **server-side persistence substrate** that participates in the same exchange protocol as every other substrate. The client doesn't know it's talking to SQLite. The server doesn't know the client is in-memory.

This is actually the strongest version of the demo, because it proves something about the architecture that would be hard to believe without seeing it: **the substrate is truly an implementation detail hidden behind the exchange protocol.** Two peers with completely different backing stores, different versioning schemes, different storage semantics — and the same three messages (discover, interest, offer) make them converge.

## What Would Need to Be True

For this to work with the current exchange, one practical constraint: the `SubstratePayload` formats need to be compatible at the exchange level. Looking at how the synchronizer handles snapshot import:

```packages/exchange/src/synchronizer.ts#L588-626
  #importSnapshot(runtime: DocRuntime, payload: SubstratePayload): void {
    // Strategy 1: try importDelta (works for Loro and any substrate
    // whose importDelta accepts snapshot payloads)
    try {
      runtime.substrate.importDelta(payload, "sync")
      return
    } catch {
      // importDelta doesn't support this payload format — use strategy 2
    }

    // Strategy 2: reconstruct from snapshot, read state, replay into
    // existing substrate as ReplaceChange ops.
    const tempSubstrate = runtime.factory.fromSnapshot(payload, runtime.schema)
    const tempSnapshot = tempSubstrate.exportSnapshot()

    if (
      tempSnapshot.encoding === "json" &&
      typeof tempSnapshot.data === "string"
    ) {
      const state = JSON.parse(tempSnapshot.data) as Record<string, unknown>
      const ctx = runtime.substrate.context()

      // Build ops: one ReplaceChange per top-level key
      const ops: Array<{
        path: Array<{ type: "key"; key: string }>
        change: { type: "replace"; value: unknown }
      }> = []
      for (const [key, value] of Object.entries(state)) {
        ops.push({
          path: [{ type: "key" as const, key }],
          change: { type: "replace" as const, value },
        })
      }

      if (ops.length > 0) {
        executeBatch(ctx, ops, "sync")
      }
    }
  }
```

Strategy 2 is the universal fallback: reconstruct a temp substrate from the snapshot, read its state as JSON, then replay into the live substrate as `ReplaceChange` ops. This means **any substrate that can export JSON snapshots can interoperate with any other substrate that accepts `ReplaceChange` ops** — which is all of them, since `step(state, { type: "replace", value })` is universal.

So a `SqliteSubstrate` that exports `{ encoding: "json", data: JSON.stringify(allTablesAsNestedObject) }` would interoperate with `PlainSubstrate` out of the box, today, with zero changes to the exchange.

The delta path is trickier — SQLite session changesets are a binary format that only other SQLite databases understand. But for the sequential strategy where the server is authoritative, the server sends its deltas as JSON-serialized `Op[]` (same as `PlainSubstrate.exportSince`), and the client's plain substrate consumes them via `importDelta`. That works today.

## So: Single-Process CLI or Full Stack?

Both, but the full-stack story is the interesting one. The CLI case (SQLite substrate in a single Node process, no sync) is just the persistence story — useful but pedestrian. The full-stack case — SQLite on the server, plain in-memory on the client, exchange bridging them over WebSocket — is where it demonstrates something genuinely new about the architecture. And it requires no new exchange capabilities; just a new substrate implementation and a `bindSql` convenience function.

