fix(index): Source.fromExchange applies one membership rule on every path

# Background

`Source.fromExchange(exchange, bound)` — and `Source.of`, which delegates to it — turns "every document in this Exchange matching this schema" into a `Source<V>`, the entry point to the ℤ-set index layer. It lives in `packages/index/src/source.ts:367`.

Its membership changes three ways, and all of them end in `exchange.get(docId, bound)`:

1. **A scan on construction** (`source.ts:421`), walking `exchange.documents()`.
2. **A subscription** (`source.ts:407`), reacting to `exchange.documents.subscribe`.
3. **The handle** (`source.ts:447`) — `createDoc` and `delete`, which mutate the exchange directly.

Each maintains membership by hand, and they disagree. The scan filters documents before using them; the subscription does not; the handle skips the filter entirely and keeps its own copy of the bookkeeping besides. Those divergences are this plan.

Nothing in the package can catch them. All sixteen tests in `packages/index/src/__tests__/source-of.test.ts` drive a hand-built mock of the Exchange (`createMockExchange`, line 37) that re-implements a six-method cross-package contract; none uses a real Exchange. `fromExchange` takes `exchange: any` (`source.ts:368`), so nothing type-checks the mock against the real thing either. A mock asserted against its own semantics agrees with itself forever, and the contract it stands in for is free to move.

# Problem Statement

**1. The subscription path crashes on replicate-mode documents.** The scan filters before using a document:

```ts
if (info.mode !== "interpret") continue;
if (info.suspended) continue;
```

`tryAdd` (`source.ts:377`), which the subscription calls, applies neither. Only the `mode` half is missing in the sense that matters — Problem 3 shows the `suspended` line is the scan's own error, and Task 1.1 deletes it rather than propagating it. `Exchange.get()` throws for a replicate document (`exchange.ts:814-816`) — it has no schema and no ref to return. And `Synchronizer.registerDoc` (`synchronizer.ts:738`) is mode-agnostic: it emits `doc-created` for a replicate registration just as for an interpreted one.

Reproduced against a real Exchange:

```
Source.of attached; indexed: 0
=> THREW inside the changefeed subscriber:
    Document 'doc-1' is registered in replicate mode. Cannot call exchange.get()...
```

The throw escapes into a changefeed dispatch, so it does not merely skip one document — it interrupts the dispatch feeding everything downstream. Reachable by any peer that both replicates and indexes documents of the same schema: a relay, or the standalone multi-peer inspector in `packages/exchange/PRODUCT.md`.

**2. `handle.createDoc` emits the same document twice.** `doc-created` fires _synchronously_ inside `exchange.get()` — measured, not assumed. So in `createDoc` (`source.ts:448`) the subscriber runs, adds the entry and emits `+1` before `createDoc` reaches its own `entries.set` and `emit`. Both fire:

```
emissions from ONE createDoc(): 2
   delta: [["doc-1",1]]
   delta: [["doc-1",1]]
```

`snapshot()` hides this, because `entries` is a `Map` and dedupes to one. The emitted stream does not, and the stream is what every downstream consumer integrates:

```
after createDoc  → integrated weight: 2
after delete     → integrated weight: 1
source.snapshot() size: 0
```

A create followed by a delete leaves a phantom entry in every integrated view while the source's own snapshot correctly reports empty. The source disagrees with itself.

`delete` (`:463`) escapes the same fate by accident. It calls `entries.delete(key)` _before_ `exchange.destroy(docId)`, so the subscriber's `tryRemove` finds nothing and returns early. Two sibling methods, opposite disciplines, one of them wrong — the same failure this plan diagnoses between the scan and the subscription, one level down.

`ExchangeSourceHandle` is exported (`packages/index/src/index.ts:62`) and has no in-repo callers, so this is latent for downstream consumers rather than currently biting.

**3. The two paths disagree about suspension, and the subscriber's event handling is right only by accident.** `DocChange` (`packages/exchange/src/types.ts:174`) has six members; the subscriber handles `doc-created` and `doc-removed`. Measuring the other four turns up one real defect and three near-misses. Both halves are worth recording: "four ignored events" reads as four bugs, and is wrong in both directions.

**Suspension is the defect, and it belongs to the scan rather than the subscriber.** The scan drops suspended documents (`source.ts:423`); the subscriber ignores `doc-suspended` / `doc-resumed` and keeps them. So whether a document is a member depends on whether this source first saw it at construction or afterwards. Suspension is not a reason to leave an index:

> **Suspension** — an orthogonal flag about sync-graph membership, not a fourth phase. A suspended document is still in interpret phase. — `packages/exchange/TECHNICAL.md:48`

Measured: a suspended document stays in `documents()` as `{"mode":"interpret","suspended":true}`, `get()` returns the same ref, and the ref still reads. `suspend` "sets a flag and sends `dismiss`; the ref and substrate are untouched" (`TECHNICAL.md:374`), and it means _intent to resume_ (`:369`).

So a suspended document is a fully readable member of "every document in this Exchange matching this schema," which is what a `Source` is. Excluding it means `exchange.suspend(docId)` deletes a row from every `Collection` and `Index.by` view built on that source, and `resume` puts it back — a `-1` then a `+1`, which `packages/index/TECHNICAL.md:228` notes reaches downstream subscribers as `removed` + `added`. Churn in the UI because the network went quiet.

**Neither `doc-promoted` nor `doc-deferred` can cost this source a document.** Both measured, and both worth stating so nobody writes a test that cannot pass.

`doc-deferred` cannot strand an indexed one. `deferDoc` emits it only when the exchange does not already hold the document (`synchronizer.ts:779-781`):

```ts
const event: DocChange | undefined = !sync.documents.has(docId)
  ? { type: "doc-deferred", docId }
  : undefined;
```

`interpret → deferred` is therefore unreachable; the event fires only on first sight of a document that should not be indexed, and is not.

`doc-promoted` cannot deliver one this source should track. Attaching registers the bound schema, and with a schema registered an announcement this peer can read lands in `interpret` **directly**. Measured on two peers over a bridge, with `resolve: () => Defer()` set on the receiver:

```
readable by the registered schema → interpret,  event: doc-created
not readable                      → deferred,   event: doc-deferred
```

The unreadable one is correctly excluded on the hash clause. `doc-promoted` is produced only by `registerSchema`'s deferred sweep, which runs *before* the subscription is installed — so those documents arrive through the construction scan, never through the subscriber.

**The membership rule is therefore: in `exchange.documents()`, and readable by this schema.** `remove()` and `destroy()` are the exits — both drop the document from `documents()`, so `reconcile` removes it. Suspension is not an exit.

That the two unreachable cases are handled correctly today is luck rather than design. Nothing in the subscriber's `if (change.type === …)` records which events were considered, or why dropping the rest was safe. A rule that re-decides membership from current state needs no such record — which is the case for Task 1.2, and it is robustness rather than four live bugs.

**4. The line a `Source` must not cross is _tier_, not phase.** It is tempting to state this as "attaching a `Source` must not mutate the Exchange," and that is wrong. Measured on two exchanges over a bridge, where `bob` defers a document `alice` created:

```
bob sees doc as:      {"mode":"deferred","suspended":false}
after registerSchema: {"mode":"interpret","suspended":false}
```

`fromExchange` calls `exchange.registerSchema(bound)` at `source.ts:403` — before the subscription and before the scan — and `registerSchema` sweeps every deferred document, promoting the ones the new schema can read (`exchange.ts:1110-1144`). So deferred promotion happens on attach, before any filter in this plan runs, and it is **intended**: `Source.fromExchange(exchange, bound)` declares that this peer can now read this schema, and a deferred document is precisely one it previously could not. Promoting it is the feature.

The exchange has already written the line that does matter, in the same sweep's comments (`exchange.ts:1121-1126`) explaining why it covers deferred but deliberately not replicate:

> a relay that registered a schema to interpret _one_ document would silently acquire full substrates for all of them.

**So: a `Source` may change a document's readability, never its tier.** Deferred → interpret resolves "we could not read this." Replicate → interpret is a tier decision — headless relay to full substrate — and indexing must never make it on the operator's behalf. One clause of `isTrackable` enforces the whole law, and it survives `PLAN-2026-08-13-replicate-promotion` landing without an edit: when `get()` gains the ability to upgrade a replicate document, the predicate is what stops a `Source` from doing it by accident.

**5. Minor: nothing marks module-internal exports.** `__getCacheHandlerCountAtPath` (`packages/schema/src/interpreters/with-caching.ts:207`) is exported from its module for a test and deliberately absent from the barrel — verified: in neither `packages/schema/src/index.ts` nor the built `dist/index.d.ts`. It does not leak. The gap is that nothing says so at the definition, so a future reader could as easily delete it as promote it. The convention has a wording — `@internal Not exported from the package barrel` — and no instances: no occurrence of it survives anywhere in the tree.

# Success Criteria

1. **A `Source` never changes a document's tier.** No document acquires a substrate it did not have by being indexed: a `replicate` document is still `replicate` after a `Source` attaches, scans, subscribes, and reconciles. `Source.fromExchange` / `Source.of` never call `get()` on a document that would reject it. Deferred → interpret is _permitted and expected_ — it is `registerSchema`'s sweep, it is what attaching a `Source` means, and it is asserted positively rather than forbidden.
2. **Every path agrees, in contents and in deltas.** After any sequence of lifecycle events and handle calls: (a) the source's contents equal what a fresh `Source.fromExchange` over the same Exchange would produce, and (b) the _integrated emitted deltas_ equal those contents.

   Clause (b) is what catches a double-emit, and it is the reason the criterion is worded this way. Contents alone cannot catch one: `entries` is a `Map`, so it silently dedupes, and `snapshot()` reports the right answer while the stream downstream consumers actually integrate reports the wrong one. Any test that asserts only on `snapshot()` passes today against a live defect.

3. Exactly one rule writes to `entries` and emits. No path — scan, subscription, or handle — keeps its own copy of that bookkeeping.
4. New `DocChange` members are handled correctly without editing the subscriber.
5. **Suspension does not affect membership.** A suspended document stays indexed, and `suspend` / `resume` emit no deltas. Sync-graph state does not decide query results.
6. At least one test exercises `Source.fromExchange` against a **real** `Exchange`, covering replicate registration and non-upgrade, deferred promotion, suspend, resume, and the handle's two methods.
7. The false documentation claims are corrected — two in `packages/index/TECHNICAL.md`, one in `packages/exchange/TECHNICAL.md`.
8. The module-internal export convention is applied and recorded.
9. Full `pnpm verify` passes.

# ✅ Phase 1: One predicate, one rule

The insight: membership is one question, asked in three places. The scan asks it of every document, the subscription asks it of one, and the handle asks it of the document it has just created or destroyed. They diverged because the question was written out three times — explicitly in the scan, implicitly and incompletely by whichever events the subscriber handled, and not at all in the handle.

- ✅ Task 1.1: Replace the scan's inline filter in `packages/index/src/source.ts` with a pure predicate over gathered values:

  ```ts
  /** Which documents this source tracks. Pure — the caller does the lookups. */
  function isTrackable(
    info: DocInfo | undefined,
    docHash: string | undefined,
    reader: ReadCapability,
  ): boolean;
  ```

  **Two clauses, not three:** the document is in `interpret` mode, and this source's schema can read its shape. `info === undefined` — the document has gone from `documents()` — falls out as false, which is what `reconcile` relies on to remove.

  **Drop the scan's `suspended` check** (`source.ts:423`) rather than carrying it across. Per Problem 3, suspension is orthogonal to membership: the document is still interpreted, still in `documents()`, still holding a live and readable ref. Testing it here lets sync state decide query results. Dropping it also means `doc-suspended` and `doc-resumed` pass through `reconcile` as natural no-ops — trackable before, trackable after — needing no special case, which is what Task 1.2 is for.

  **The hash clause is `supportsHash`, not string equality.** Today both the scan (`source.ts:427`) and `tryAdd` (`:382`) compare `docHash !== schemaHash`, which excludes any document written at an ancestor shape — so a source bound to a migrated schema silently drops the very documents that schema exists to keep reading. `supportsHash(reader, docHash)` from `@kyneta/schema` is the law for exactly this question, and needs nothing index does not already have: `metadataOf(bound)` builds the `ReadCapability` once, outside the predicate. Keep the `docHash === undefined` escape — a document the exchange cannot name a hash for is not evidence of a mismatch.

  **Comment the predicate as this source's policy, not as a guard against `exchange.get()`.** The distinction is load-bearing for whoever reads it next. The wording to aim for: _a source tracks documents that are already live and interpreted; it does not materialise ones that are not._ `get()` is more permissive than this — after `PLAN-2026-08-13-replicate-promotion` it will upgrade a replicate document, which this predicate must still refuse to index — and that is the point. The two questions are independent, and writing the predicate as policy is what keeps them that way.

  **The `mode !== "interpret"` clause is where Problem 4's law lives.** It is the whole of "a source never changes a document's tier." Note what it does _not_ do: it does not prevent deferred promotion, which has already happened in `registerSchema` (`source.ts:403`) by the time any of this runs, and which is intended. Say so in the comment, because the natural reading of an `interpret`-only filter is "this stops deferred documents from being promoted," and that reading is false. What it stops is a _replicate_ document being upgraded — today by keeping `get()` away from it, and after replicate-promotion by being the only thing that still would.

  Taking gathered values rather than the exchange keeps it a truth table, testable with no Exchange at all — the same reasoning behind `deriveConnectivity` (`synchronizer.ts:358`) and `planInitialization`.

- ✅ Task 1.2: Replace the event-type dispatch with one rule:

  ```ts
  /** Re-decide this document's membership. Both helpers are idempotent. */
  function reconcile(docId: string): void;
  ```

  Add if trackable, remove otherwise. `doc-removed` needs no special case — the document is gone from `documents()`, so it is not trackable, so it is removed.

  Once Task 1.4 lands, nothing calls `tryAdd` or `tryRemove` except `reconcile`. Make them its two halves — nested inside it, or immediately adjacent and documented as private to it — rather than three sibling functions. Three peers is the shape that let a caller reach past the filter in the first place.

  The subscriber becomes `for (const change of cs.changes) reconcile(change.docId)`. This _is_ the phase's thesis rather than a restatement of it: one question, asked of every document by the scan, of one document by the subscription, and of one document by the handle. A seventh `DocChange` member added later is handled on the day it ships — as are the four the subscriber ignores today, without anyone having to decide which of them mattered. (`@kyneta/devtools`' `classify.ts:67` already avoids enumeration this way — `doc-removed` deletes, everything else sets.)

- ✅ Task 1.3: Replace the scan loop body with `reconcile` outright:

  ```ts
  for (const docId of exchange.documents().keys()) reconcile(docId);
  ```

  Not a loop that _resembles_ the subscription's filter — the same call. Anything less leaves two shapes free to drift apart.

  Emitting during the scan is harmless. `createSourceEmitter` (`source.ts:144`) holds a plain `Set` of subscribers with no buffering, and `fromExchange` has not returned, so nothing is subscribed and `emit` is a no-op. `tryRemove` on an absent key likewise returns early.

  **The ordering this depends on holds.** `reconcile` reads `DocInfo` from `exchange.documents()`, which must already reflect the document when the subscriber runs. It does: `doc-created` and `doc-removed` both fire _synchronously_ inside `exchange.get()` and `exchange.destroy()`, after the model updates and before the call returns — measured, and recorded in the Transitive Effect Analysis. Should that ever change, read `DocInfo` from the synchronizer rather than reintroducing an unguarded `get()`.

- ✅ Task 1.4: Route the handle's two methods through `reconcile` as well, instead of hand-maintaining `entries` and emitting directly:

  ```ts
  createDoc(key) {
    // keep the existing "key already exists" throw — a caller-error check,
    // not membership bookkeeping
    const docId = m.toDocId(key)
    const ref = exchange.get(docId, bound)
    reconcile(docId)
    return ref
  }
  delete(key) {
    if (!entries.has(key)) return false
    const docId = m.toDocId(key)
    exchange.destroy(docId)
    reconcile(docId)
    return true
  }
  ```

  **This is correct under either emission ordering**, which is why it is preferable to simply reordering the existing statements. If `doc-created` fires synchronously — as it does today — the subscriber has already added the entry, and `reconcile`'s `entries.has` guard makes this call a no-op. If it is ever deferred, `reconcile` does the work here and the later subscriber no-ops. Neither ordering can double-emit, because only one rule ever writes to `entries`.

  Two consequences to accept deliberately rather than discover:

  - A document `createDoc` creates enters the source only if `isTrackable` says so. In practice it always is — `exchange.get(docId, bound)` yields an interpreted, unsuspended document at `bound`'s own hash — but the membership decision now belongs to the predicate rather than to the method.
  - `reconcile` derives the key via `m.toKey(docId)`, where `createDoc` previously used the caller's `key` directly. This requires `toKey` and `toDocId` to round-trip. The default mapping does, and a mapping that does not is already incoherent for `delete`, which has always gone through `toDocId`.

- ✅ Task 1.5: Comment the invariant at `reconcile`: the source's contents always equal what a fresh scan would produce, and the integrated deltas always equal the contents. That one sentence is what makes all three paths reviewable together.

# ✅ Phase 2: Test against a real Exchange

- ✅ Task 2.1: Add `packages/index/src/__tests__/source-exchange.test.ts` using a real `Exchange`.

  `@kyneta/exchange` is a **devDependency** of `@kyneta/index`, which is all a test file needs. Do not add a runtime import to `source.ts`: `exchange: any` is there to keep the dependency optional at runtime, and a type-level import would put `@kyneta/exchange` in the emitted `.d.ts` for consumers who never install it.

  Most cases need no transport — a transportless `new Exchange({ id: "test" })` exercises creation, replicate registration, suspend, resume, destroy and the handle locally. The deferred cases are the exception: a document is only deferred when a peer announces one this peer cannot read, so those need two exchanges over a `Bridge`.

  **§Tests holds the full list of cases.** Below are only the ones needing explanation — what to assert, or what not to collapse. One enumeration, so the two cannot drift apart, which is the failure this plan exists to fix.

  - **Tier is conserved.** Snapshot every document's `mode` before attaching a source and after a full mixed sequence, and assert no document moved _out of_ `replicate`. This is Problem 4's law as one assertion rather than a case list, and it is what survives replicate-promotion landing.

    Write it as a conservation check, not as "a replicate document stays replicate for this one docId". A case list passes while a sibling case quietly fails, and the sibling cases here are the ones that move — a new phase, or a `get()` that learns to upgrade.

  - **Two remote-document cases, arriving by two different routes.** They read alike and must not be merged into one:
    - _Already deferred at attach._ A source attaching to an exchange that already holds a matching deferred document promotes and indexes it, via `registerSchema`'s sweep (`exchange.ts:1110-1144`) followed by the construction scan.
    - _Announced after attach._ A document another peer announces once the source is live reaches the index through the subscription. Assert its mode is `interpret`: with the schema registered it never defers, so this is `doc-created`, not `doc-promoted`. That is the fact Problem 3 records, and asserting it here is what keeps the two cases from being collapsed by someone who assumes a promotion is involved.

    Both need two exchanges over a `Bridge`, following `packages/exchange/src/__tests__/doc-feed.test.ts:261`.

  - **Suspend and resume do not change membership.** The document stays indexed across both, and — asserted on integrated deltas — emits nothing at either transition. A `-1`/`+1` pair here would reach downstream `Collection` subscribers as `removed` + `added` for a document that never changed, which is the churn Problem 3 rules out.
  - **`createDoc` emits exactly one delta**, and `delete` returns the integrated weight to zero. Assert on integrated deltas, not `snapshot()` — `snapshot()` passes today against the live double-emit, because `entries` is a `Map`.
  - **All three paths agree** — after a mixed sequence, a freshly constructed `Source.fromExchange` has the same keys as the long-lived one, _and_ the long-lived one's integrated deltas equal its own contents. Assert on key sets and integrated weights, not event counts, so the test states the invariant rather than the mechanism.

- ✅ Task 2.2: Keep `source-of.test.ts` and its mock. Its sixteen tests cover the adapter's own logic — ℤ-set delta shape, key mapping, entity extraction, namespacing — which is what a mock is legitimately for. Add a note at the top of each file pointing at the other, so the split reads as deliberate rather than duplicated.

# ✅ Phase 3: Documentation

- ✅ Task 3.1: `packages/index/TECHNICAL.md` §"Testing" — remove the false `Bridge` + `BridgeTransport` claim and describe the split introduced in Phase 2: mock-driven tests for the adapter's delta algebra, real-Exchange tests for the lifecycle contract. Say why both exist, since that is the thing a future contributor needs in order to put a new test in the right file.

- ✅ Task 3.2: `packages/index/TECHNICAL.md` §"subscription discipline" — two corrections to the same section.

  State which documents an exchange-backed source tracks: those in `exchange.documents()` in `interpret` mode whose shape the bound schema can read. Say that a source never promotes or materialises a document it did not already find live, and that the handle's `createDoc`/`delete` go through the same rule rather than around it. No event table — Task 1.2 removes the need for one.

  Say explicitly that **suspension is not a membership condition**, and why: it is sync-graph state, the ref stays live, and letting it decide membership would make pausing sync delete rows from every derived view. This is the one place a reader is likely to assume the opposite, since the pre-existing scan tested it.

  Then fix the opening claim at `:213`, which credits exchange-backed sources with "per-doc subscriptions" they do not have. `fromExchange` holds one subscription, to `exchange.documents`; the per-entry sub-subscriptions in point 3 are `fromList`'s.

- ✅ Task 3.3: `packages/schema/TECHNICAL.md` — record the module-internal export convention: a symbol exported from its module but deliberately absent from the barrel is package-internal and carries `@internal Not exported from the package barrel`. Cite `__getCacheHandlerCountAtPath` as the worked example — after Phase 4 it is the only instance in the tree. Say plainly what the marker asserts, so the next such export is annotated rather than re-invented.

- ✅ Task 3.4: `packages/exchange/TECHNICAL.md:365` — correct the "Suspend vs destroy" table. Its `suspend` row claims the document is removed from `exchange.documents`; it is not. A suspended document stays in the map as `{"mode":"interpret","suspended":true}` — which is what the `suspended` field exists for, and what makes `doc-suspended` / `doc-resumed` meaningful events. The `destroy` and `remove` rows in the same table are accurate; only `suspend` is wrong.

  Worth fixing here rather than filing separately: this row is the most likely source of the belief that a suspended document has left the exchange, which is the belief that put the `suspended` check in the scan.

- ✅ Task 3.5: No README changes. `Source.fromExchange`'s signature and its behaviour for interpreted documents are unchanged, and `packages/index/README.md` does not document `ExchangeSourceHandle` at all — checked, so the `createDoc` fix has no README surface to correct.

# ✅ Phase 4: The internal-export marker

- ✅ Task 4.1: Annotate `__getCacheHandlerCountAtPath` with `@internal Not exported from the package barrel`.

  Keep the function. Its test guards a real historical bug — cache handlers accreting across re-interpretations — whose symptom is unbounded memory and per-write work, not any behavioural difference. There is no public-surface proxy, so a behavioural test would pass whether or not handlers accreted: a weaker test wearing a stronger one's costume. A backdoor is the honest instrument; what was missing was the label.

# Tests

Reuse existing helpers. `@kyneta/index` tests already import from `@kyneta/schema`; the new file adds `Exchange` from `@kyneta/exchange`, a devDependency.

One shared helper carries most of Phase 2. `foldDeltas(source)` subscribes and accumulates every emitted delta into a `Map<string, number>` — three lines, and the instrument Success Criterion 2(b) is written for. Every assertion below that names a weight uses it, because `snapshot()` cannot see a double-emit.

**Phase 1 — pure** (extend `source-of.test.ts`)

- `isTrackable` as a small table over `{ mode × hash }`. No Exchange needed. Three rows earn their place beyond the obvious ones: `info === undefined` (a document that has since vanished), because `reconcile` relies on it to remove; a document written at an ancestor shape of the source's schema, which must be _tracked_ — that is the row string equality gets wrong; and a **suspended** document, which must also be tracked, since `suspended` is deliberately not an input.

**Phase 2 — the contract** (`source-exchange.test.ts`, real `Exchange`)

- Replicate registration with a matching schema hash does not throw and is not indexed.
- `handle.createDoc` emits one `+1`, not two; a following `delete` returns the integrated weight to zero.
- Tier conservation: no document leaves `replicate` across attach + a full mixed sequence.
- Attaching a source promotes a matching deferred document and indexes it — `registerSchema`'s sweep (two exchanges over a `Bridge`).
- A document announced by another peer after attach enters the source, landing in `interpret` directly rather than deferring (two exchanges over a `Bridge`).
- `suspend` and `resume` leave membership unchanged and emit no deltas.
- Scan/subscription/handle agreement after a mixed sequence — create, replicate, suspend, resume, `handle.createDoc`, `handle.delete`, destroy — checked as both key sets and integrated weights.
- A genuinely unrelated schema hash is excluded on every path, while an ancestor shape of the bound schema is included.

**Phase 4** — no new tests; the annotation is at the definition only.

# Transitive Effect Analysis [scratch]

**`Exchange.documents` → `Source.fromExchange` → `Collection` → `Index.by` / `Index.join` → application views.** A throw in the source's subscriber aborts the changefeed dispatch feeding the whole pipeline. That is why the crash matters more than its narrow trigger suggests: it does not skip a document, it interrupts the dispatch.

**`@kyneta/devtools` → `@kyneta/index`.** Checked: devtools uses `Source.create` and `Source.fromReactiveMap` (`packages/devtools/src/world.ts`), **not** `Source.of` / `fromExchange`. The crash does not reach the one in-repo runtime consumer today — but would the moment devtools indexed exchange-backed documents, a natural next step for the multi-peer inspector.

**`Synchronizer.registerDoc` → `doc-created` → every `documents` subscriber.** The event is mode-agnostic by design; the sync graph really does gain a document either way. The asymmetry lives in `get()`. `packages/exchange/src/line.ts:790` filters on `doc-created` too, but parses the docId (`parseLineDocId`) and checks `parsed.to !== exchange.peerId`, never calling `get()` on the discovered document — no equivalent bug there.

**`reconcile` → repeated adds.** Reconciling on every event means the same document can be re-decided several times in a row. The existing `entries.has(key)` guard makes a repeat a no-op, so this cannot double-count. That guard must stay after the trackability check and before `get()`. It is also what makes Task 1.4 safe: the handle calling `reconcile` after an operation the subscriber already handled is absorbed by the same guard.

**Document events are synchronous, and `documents()` is current when they fire.** Measured against a real transportless `Exchange`: the `documents` subscriber runs _inside_ `exchange.get()` and inside `exchange.destroy()`, before either returns, and `documents()` already reflects the change. Document events are queued in `SyncModel.pendingDocEvents` and flushed at quiescence — but quiescence is reached within the originating call, not on a later tick.

Two things rest on this. Problem 2 is caused by it: the subscriber's bookkeeping lands before `createDoc`'s own, so both run. Task 1.3 is licensed by it: `reconcile` can read `DocInfo` from `documents()` when the subscriber fires. Task 1.4's `delete` also depends on the `destroy` half — the subscriber removes the entry, `reconcile` no-ops, and the `true` return is honest.

**`isTrackable` reads `exchange.documents()` → allocation.** `documents()` returns the live `ReadonlyMap`, not a copy, so per-event calls are cheap. Unlike `getPeerStates`, which allocates a fresh array per call and forced the snapshot caching in `@kyneta/react`'s `createSyncStore`, there is no identity hazard.

**`get()` is more permissive than this filter, and the gap is deliberate.** After `PLAN-2026-08-13-replicate-promotion`, `get()` will upgrade a replicate document; index must still refuse to index one. The predicate is a statement about what a source tracks, not about what `get()` tolerates, so changes to one do not propagate to the other. That independence is the reason for Task 1.1's framing; collapsing the predicate into a `get()`-precondition check would erase it.

**`fromExchange` → `registerSchema` → the deferred sweep.** `source.ts:403` registers the bound schema, and `exchange.ts:1110-1144` immediately promotes every deferred document that schema can read — before the subscription is installed and before the scan runs. Two consequences.

First, no filter in this plan can prevent deferred promotion, because it has already happened by the time any filter runs. Any success criterion or test phrased as "attaching a source leaves a deferred document deferred" is unsatisfiable, and will fail against a real Exchange. Second, the promoted documents then arrive through the ordinary path — they are `interpret`, unsuspended, at a hash the reader supports — so `isTrackable` includes them, which is correct.

The sweep is scoped to deferred and refuses to widen to replicate, and its comment says why. That scoping is what makes `isTrackable`'s `mode` clause sufficient rather than merely helpful: index does not have to defend the tier boundary on the registration path, only on the `get()` path.

**`registerSchema` is a mutation, and `fromExchange` performs it unconditionally.** Worth knowing even though this plan does not change it: constructing a `Source` is not a read-only act, and cannot be, since a source that did not register its schema would never see the remote documents it exists to index.

**The mock in `source-of.test.ts` will drift again.** Nothing prevents it. The Phase 2 tests are the guard: a future divergence fails there rather than passing everywhere.

# Resources for Implementation [scratch]

**Read before starting**

- `packages/index/TECHNICAL.md` §"`Source` constructors", §"subscription discipline", §"Testing".
- `packages/exchange/TECHNICAL.md` §"`exchange.get` — phase in, action out" — what `get()` does with each document phase, and where it refuses. The filter in Task 1.1 is deliberately narrower than this; knowing exactly how much narrower is the point.
- `packages/schema/TECHNICAL.md` §"The two laws over `supportedHashes`" — why the schema-hash clause is a membership test rather than an equality check.
- `packages/exchange/PRODUCT.md` — why a peer that both replicates and indexes is a real deployment.

**The specific code**

- `packages/index/src/source.ts:367` (`fromExchange`), `:377` (`tryAdd`), `:395` (`tryRemove`), `:407` (subscriber), `:421` (scan), `:427` and `:382` (the two hash comparisons), `:447` (the handle — `createDoc` at `:448`, `delete` at `:463`), `:917` (`of`, delegating).
- `packages/index/src/source.ts:144` (`createSourceEmitter`) — no buffering, which is what makes scan-time emission a no-op in Task 1.3.
- `packages/exchange/src/types.ts:149` (`DocInfo`), `:174` (`DocChange`).
- `packages/exchange/src/exchange.ts:772` (`#getImpl`), `:814-816` (the replicate throw), `:805-850` (deferred promotion and the axis checks), `:796` (the bound-mismatch throw), `:1041` (`getDocSchemaHash`).
- `packages/exchange/src/exchange.ts:1105-1144` (`registerSchema` and its deferred sweep) — **read this before Task 1.1.** Its comment at `:1121-1126` is where the tier boundary in Problem 4 is already written down, and the sweep is why deferred promotion is not something `isTrackable` can or should prevent.
- `packages/exchange/src/__tests__/doc-feed.test.ts:261` — the two-exchange `Bridge` setup for producing a deferred document, reused by the Phase 2 deferred test.
- `packages/exchange/src/synchronizer.ts:358` (`deriveConnectivity` — the pure-classifier convention `isTrackable` follows), `:738` (`registerDoc`).
- `packages/schema/src/interpreters/with-caching.ts:207` — the backdoor to annotate.

**Convention to follow**

- `packages/exchange/src/interpret.ts` — `planInterpretation` models the pure-classifier shape `isTrackable` follows, and its docstring models explaining _why_ a parameter is absent rather than what the function does.

# Alternatives Considered

**Have index consult `@kyneta/exchange`'s own interpretation classifier.** `planInterpretation` (`packages/exchange/src/interpret.ts`) already decides what `get()` will do with a document, from its phase and metadata. Index could import it and filter on the actions that mean "this will work". Tempting, and wrong for two reasons.

It answers a different question. That classifier reports what `get()` _will do_; index needs to know what it _should track_. Those diverge on the cases that matter here — `planInterpretation` returns `promote` for a deferred document, and a source must not promote anything. Filtering on it would mean writing "and not the promote case" at the call site, which is the policy restated as an exception to somebody else's rule.

It is also not index's to depend on. The classifier is internal to `@kyneta/exchange` — not exported from the barrel — precisely because it encodes that package's rules for its own front door. Exporting it to serve a filter in another package would make one package's implementation detail into another's contract, and every future adjustment to `get()` would become a cross-package question.

**Guard `tryAdd` by catching the `Exchange.get()` throw.** Converts a wrong-document-set bug into a silent one, and couples index to the shape of an exception another package raises for its own reasons.

**Wrap the subscriber body in try/catch.** One line, stops the crash escaping. Same objection, and it leaves the suspension disagreement untouched — the source would still disagree with a fresh scan, and nothing would say so.

**Filter on event type alone — treat `doc-created` as interpret-only.** False: `registerDoc` emits `doc-created` for replicate registrations deliberately. The event describes the sync graph; the filter is about what this source tracks. Conflating those questions is what produced the bug.

**Enumerate the six `DocChange` members in the subscriber.** Rejected in favour of `reconcile`: enumeration restates the filter's implications by hand — the same failure mode with more rows filled in — and goes stale the moment a seventh member is added.

**Replace `__getCacheHandlerCountAtPath` with a behavioural test.** Rejected: the invariant is that cache-invalidation handlers do not accrete, and the only symptom is memory and per-write work. A subscriber-fires-once test would pass whether or not they accreted — weaker, while looking stronger. Where the sole symptom is resource growth, inspecting the structure is the honest instrument; the fix is the label.

**Stop `fromExchange` calling `registerSchema`, to make attaching a `Source` read-only.** This is the only way to get "no deferred promotion on attach," and it is worth naming because that invariant sounds like the right one. Rejected: it removes the feature. A source that has not registered its schema is never offered the remote documents it exists to index, because `resolveSchema` has nothing to match a `present` against, so every one of them defers and stays deferred. The sweep is not a leak in the way of the goal; it is how a `Source` learns about documents that arrived before it did. The tier law in Problem 4 is the invariant that is both true and worth having.

**Fix `createDoc` by reordering its statements — set `entries` before calling `get()`, mirroring `delete`.** The minimal change, and it does stop the double-emit today. Rejected: it works only because emission is synchronous, so it encodes that timing as a silent precondition in a method that never mentions it. `delete` is already correct for exactly this accidental reason, which is what let the two siblings diverge without anyone noticing. Routing both through `reconcile` is correct under either ordering and leaves one rule writing to `entries` instead of three.

**Delete the mock-based tests and test only against a real Exchange.** Rejected: the two files cover genuinely different things. The mock tests assert the adapter's own ℤ-set algebra, key mapping, and entity extraction, driven deterministically. What was missing is contract coverage, which is additive.
