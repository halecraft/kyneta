# Upgrading to 3.0

_What changed, what it costs you, and what to write instead._

The changelog says _what_ changed. This says _how_ to move, and _why_ each change was worth making. Sections are ordered by how likely you are to hit them, not by package.

<!--
Setup for the "3.0" snippets below, which are compiled out of this document so
that what you copy is known to work. The "2.x" snippets are marked uncompilable
on purpose: they show code that no longer exists, which is the point of them.
-->
<!-- ts-docs-prelude
import { Exchange, docStatus, initialize, whenSettled } from "@kyneta/exchange"
import { Schema, batch, createDoc, createDocAs, deleted, json, populated, populatedFeed, subscribe } from "@kyneta/schema"

const TodoDoc = json.bind(Schema.struct({ title: Schema.text() }))
declare const exchange: Exchange
-->

---

## Read this part first: two changes your compiler will not catch

Most of 3.0 announces itself — you upgrade, the build fails, you fix what it points at--except for the following two. Each compiles cleanly and behaves differently, so they're the places where a type-driven upgrade can leave you worse off than before.

### `get()` no longer throws on a suspended or replicate document

Two calls that used to throw now succeed. If you were relying on the throw — `try`/`catch` around `get()`, or a test asserting it rejects — that code no longer does what it did.

<!-- ts-docs-verifier:ignore -->

```ts
// 2.x — both of these threw
exchange.get(suspendedDocId, TodoDoc);
exchange.get(replicatedDocId, TodoDoc);
```

In 3.0 the first returns the document and **leaves it suspended**. Suspension is about sync-graph membership, not local readability; if `get()` resumed, an unrelated read would restart traffic that peers can observe.

The second _promotes_ the document: a replicate document is a bare replica with no schema, and you have just supplied the one thing it lacks. State accumulated while it was headless carries across the upgrade rather than being rebuilt.

### `ephemeral` documents merge per field, not per document

`ephemeral.bind(schema)` compiles unchanged and means something different. Each scalar leaf now carries its own timestamp, so two peers writing _different_ fields both survive — where previously the newest whole-document snapshot replaced everything.

If you were working around the clobbering — funnelling presence through one writer, or splitting a roster into a document per peer — you can stop.

Two consequences to know:

- **Nothing survives a restart.** That is what `durability: "transient"` always meant; it is now enforced rather than accidental. A restarted server will not resurrect yesterday's cursor positions.
- **No offer is discarded as stale.** `StateVersion.compare` always reports `"concurrent"`, because a payload that is older overall may still hold the newest value for one field. The substrate is chattier, and correct.

---

## `populated` and `deleted` swap places

The short name now belongs to the boolean, because asking "has data arrived?" is the routine thing and subscribing to the transition is the specialist one. The 2.x spelling had it the other way round.

<!-- ts-docs-verifier:ignore -->

```ts
// 2.x
if (isPopulated(doc)) {
  render(doc);
} // the boolean
subscribe(populated(doc), () => render(doc)); // the [CHANGEFEED] carrier
```

<!-- ts-docs-setup
const doc = createDoc(TodoDoc)
declare const render: (d: unknown) => void
-->

```ts
// 3.0
if (populated(doc)) {
  render(doc);
}
subscribe(populatedFeed(doc), () => render(doc));
```

`isPopulated` and `isDeleted` are removed — `populated` and `deleted` _are_ those functions now. `deleted` follows the same shape as `populated` throughout.

Both halves of the swap are compile errors, so the compiler will walk you through it. The one exception is worth knowing about, because it is silent: if you wrote `if (populated(doc))` in 2.x, you were testing a callable object, which is always truthy — so that branch ran unconditionally, including for the empty document you were presumably guarding against. The same line now does what it reads as. It is a fix, but it changes which branch runs, so look at any you have.

## Waiting for a document

The readiness API is gone. This is the change most 2.x code will hit first, because `waitForSync` was the documented way to await sync.

<!-- ts-docs-verifier:ignore -->

```ts
// 2.x
await sync(doc).waitForSync();
if (hasSync(doc)) {
  /* … */
}
const label = describeSyncStatus(doc);
```

<!-- ts-docs-setup
const doc = createDoc(TodoDoc)
-->

```ts
// 3.0
await whenSettled(doc); // wait for every truth source
const status = docStatus(doc); // "pending" | "empty" | "populated"
```

`whenSettled` resolves once storage has loaded _and_ peers have answered, so what you read afterwards is the whole document rather than the part that arrived first. `docStatus` is total — it always has an answer, which is why the old `hasSync` guard around `sync()` is no longer needed.

For a status label, compose one from connectivity, `peerStates`, and `docStatus`. `describeSyncStatus` and `SyncStatusSummary` bundled those three into a string that could not be right for every UI; building the label where you render it costs a few lines and stops being wrong.

`sync(doc).settled()` and `createDerivedSyncStore` are removed on the same grounds. In React, use `useDocStatus` and `useInitialize`.

---

## Seeding defaults

New in 3.0, and the reason `initialize` exists at all: writing defaults into a document that might already have data is a race unless you wait for every source that could have something to say. In 2.x this wasn't possible to do safely.

<!-- ts-docs-setup
const doc = createDoc(TodoDoc)
-->

```ts
// Writes only if the document is genuinely empty, at most once per document.
await initialize(doc, (d) => d.title.insert(0, "Untitled"));
```

The draft `d` is typed from the document you pass. If you wrote `initialize<Foo>(…)` against an early 3.0 build, `Foo` must now be the document's type — previously the parameter was unconstrained and every caller silently received `unknown`.

The same applies to `Source.of` in `@kyneta/index`: its accessor now receives a real `DocRef` and its key function a real item. Callbacks that were never checked are now checked, so this can surface mistakes the `unknown` was hiding.

---

## Creating a document with a specific identity

<!-- ts-docs-verifier:ignore -->

```ts
// 2.x — a placeholder argument to reach the one you wanted
createDoc(bound, undefined, "peer-a");
```

<!-- ts-docs-setup
const bound = TodoDoc
-->

```ts
// 3.0
createDocAs("peer-a", bound);
```

`createDoc(bound, payload?)` no longer takes an identity and always uses a random one. The split exists because a _random_ default reads as "no decision" and behaves like one — right up until operations are exported, attributed, or compared across runs. Now a caller either does not care and never sees the parameter, or cares and must say so.

---

## Schema compatibility

Two questions were being answered with whichever comparison was to hand:

| Question                          | Law                         |
| --------------------------------- | --------------------------- |
| Can my schema read this document? | `mismatchForInterpretation` |
| Is there a shape we both speak?   | `mismatchForSync`           |

`supportsHash` is the primitive; `hashesIntersect` applies it pairwise. Membership implies intersection but not the reverse, which is why one law cannot stand in for the other.

`supportedHashes` moved from `DocMetadata` to `ReadCapability`, and is required there. A document has one shape; a peer has a set of shapes it can cope with. Making it required on the capability is what turns a swapped argument into a compile error instead of a subtly wrong answer.

---

## Removed symbols

| Removed | Use instead |
| --- | --- |
| `waitForSync`, `sync(doc).settled()` | `whenSettled(doc)` |
| `hasSync` | `docStatus(doc)` — total, so no guard needed |
| `describeSyncStatus`, `SyncStatusSummary` | compose from connectivity + `peerStates` + `docStatus` |
| `createDerivedSyncStore` | `useDocStatus` / `useInitialize` |
| `isPopulated`, `isDeleted` | `populated`, `deleted` (now booleans) |
| `formatPath(path)` | `path.format()` |
| `advanceSchema(schema, segment)` | `walkPath` |
| `findJsonBoundary`, `JsonBoundaryHit` | `findOpaqueBoundary`, `OpaqueBoundaryHit` |
| `TimestampVersion` | — removed with the whole-document LWW substrate |
| `buildUpgrade` | — had no remaining consumer |

## `.decay()` below an opaque boundary now throws

A schema that bound in 2.x may fail to bind in 3.0 — but it never worked. Decay compares one stored timestamp against `now`, and a `sum` variant or `.json()` blob is stored as a single register, so a field inside one has no timestamp of its own and could never age out independently. The binding was accepted and the decay silently never fired.

Move `.decay()` onto the `sum` or `.json()` node itself, which decays the whole value together. The error message says as much. `.decay()` on ordinary fields is unaffected.

---

## Mixed-version deployments

3.0 peers cannot sync `ephemeral` documents with 2.x peers. The wire tag changed from `["plain", 1, 0]` to `["ephemeral", 1, 0]`, and the stored tuple gained a third slot for tombstones, which a 2.x peer reads as a container rather than a value.

Nothing ephemeral is persisted, so there is nothing to migrate — but a mixed deployment will simply not exchange presence until both sides are upgraded. Plan for the two sides to move together, or accept that presence goes dark in between.

Documents on the other binding targets are unaffected.
