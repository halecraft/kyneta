fix(exchange): keep transient documents out of durable storage

# Background

`SyncMode` decomposes sync semantics into three orthogonal axes, one of which is `Durability`: `"persistent"` or `"transient"` (`packages/schema/src/substrate.ts:703`, and `packages/schema/TECHNICAL.md` §Vocabulary). `SYNC_EPHEMERAL` is the only transient mode, and the `ephemeral` binding target is the only thing that carries it. Its documents are presence, cursors and live input — a statement about who is here _now_. A restarted server resurrecting yesterday's cursor positions would be worse than having none.

Storage is driven by a pure Mealy machine, the store-program (`src/store/store-program.ts`), described in `packages/exchange/TECHNICAL.md` §Storage. `Runtime` feeds it three lifecycle inputs — `register` (first boot, document not found in any store), `hydrated` (re-boot, loaded from a store), and `destroy` — plus `state-advanced` on every mutation. Effects fan out to every configured store.

Nothing in that pipeline consults `durability`. The store is never told which documents are transient.

# Problem Statement

**1. A transient document gets exactly one durable write, at creation, and then never updates.**

`Runtime.#hydrate` reads from the stores, and when nothing is found it dispatches `{type: "register", entirety: replica.exportEntirety()}` — persisting the document's creation-time state. Every later update is dropped, because `#persistIfAdvanced` gives up when `exportSince` returns `null`, which a snapshot-only substrate always returns.

Measured against a real `Exchange` with one in-memory store, creating an `ephemeral.bind(...)` document and writing to it:

```
record keys for presence-1: ["presence-1"]
```

The result is the worst of both policies: an empty snapshot sits on disk, never updates, and is faithfully hydrated on restart. Four defects, in descending order of consequence:

1. **The non-persistence is emergent, not declared.** It depends on `exportSince` happening to return `null`. A future transient substrate that implemented delta export would silently begin persisting presence, with nothing in the type system or the store to stop it.

2. **Every mutation does doomed work, on the hottest path there is.** `#persistIfAdvanced` runs on each state advance, and for a transient document it does not stop early — it runs almost to the end before discovering there is nothing to write:

   ```ts
   if (!phase) return                                    // passes: the doc DID register
   const confirmedVersion = phase.version
   if (!confirmedVersion) return                         // passes: the creation write succeeded,
                                                         //   and write-succeeded promoted the version
   const newVersion = replica.version().serialize()      // work
   if (this.#versionAlreadyTargeted(phase, newVersion)) return
   const sinceVersion = replicaFactory.parseVersion(confirmedVersion) // work
   const delta = replica.exportSince(sinceVersion)       // work — always null here
   if (!delta) return                                    // ← only now does it give up
   ```

   Three discarded operations per mutation. Presence documents mutate on every cursor move, which makes this the most frequently executed waste in the system. After the change the document never registers, so `if (!phase) return` fires and none of the rest runs.

3. **The read is pure waste.** Every `exchange.get()` on a transient document queries every configured store for data that cannot be there, and awaits that round-trip before the document is ready.

4. **`destroy` issues a delete for a document that was never stored.** Presence documents churn on every tab open and close, so this is a steady trickle of pointless store I/O.

**2. The store question is asked five times, and the answers must agree.**

`this.#stores.length > 0` is the expression that currently stands in for "does this document use stores?", and it appears at five decision points across two methods:

| Method | Line | What it decides |
| --- | --- | --- |
| `createInterpretDoc` | 819 | `willHydrate` — build the substrate via `beginHydration` or `create` |
| `createInterpretDoc` | 839 | the hydration latch's initial state, `"pending"` or `"loaded"` |
| `createInterpretDoc` | 876 | the divergent tail — dispatch `#hydrate`, or register immediately |
| `#createReplicateDoc` | 948 | the same latch decision |
| `#createReplicateDoc` | 959 | the same tail decision |

**Changing the tail alone produces a document that never becomes ready.** The latch at `:839` would still initialize to `"pending"`, while `resolveHydration` is called only inside the tail branch being skipped. Nothing would ever resolve it. That latch is not private bookkeeping: `registerHydrationTerm` (`:862`) registers it as a **settle term** whose predicate is `hydration.state === "loaded"`, joining the document's settle conjunction. So `whenSettled(presenceDoc)` would never return and `docStatus` would read `pending` forever — for exactly the documents a UI subscribes to in order to show who is present.

The comment at `:855-859` explains why the term is registered before hydration starts: it must be observable _while_ pending, so that nothing concludes "empty" from a document that is merely still loading. That design is what turns a missed site into a permanent hang rather than a harmless no-op.

The rule therefore has to be defined once and consulted everywhere, not written out at each site. Two of the five sites already read `this.#stores.length > 0` inline while a binding for exactly that fact sits four lines above them, unused past its first reference — which is how five copies of one question came to exist in the first place.

# Success Criteria

These describe the finished plan, not each commit. Criterion 1's `destroy` clause and criterion 5 belong to Phase 2; criteria 1–4 and 6 are satisfied by Phase 1. Every phase must leave `pnpm verify` green, but only the last satisfies all of these.

1. **A transient document never touches durable storage in any direction**: no hydrate read, no `register` dispatch, no `state-advanced` write, no `destroy` delete.
2. **A transient document settles.** `whenSettled` resolves and `docStatus` leaves `pending`, in an exchange with stores configured. This is the criterion that catches a half-applied fix.
3. **The rule has one definition.** Every decision point calls it; none restates it.
4. The rule reads the declared `durability` axis, rather than depending on a substrate's incidental behaviour.
5. `Exchange.destroy(docId)` still deletes from stores for a document that exists on disk but was **not** open in this session.
6. The ephemeral case in `packages/exchange/src/__tests__/store-integration.test.ts:162` passes **unchanged**. It asserts the contract ("writes do NOT survive a restart") rather than the mechanism, so an unchanged pass is the signal this change preserves behaviour rather than altering it.
7. `pnpm verify` green.

Each phase below is one commit. They land in order, each independently green, each making a single claim a reviewer can check without reading the others. The summary line to use is given with the phase.

# ✅ Phase 1 — The rule, and the creation paths

> `fix(exchange): creating a transient document no longer touches a store`

- ✅ Task 1.1: Add a private predicate to `Runtime` (`packages/exchange/src/runtime.ts`), placed near the other private helpers:

  ```ts
  /** Will this document's state ever reach a store, in either direction? */
  #usesStores(syncMode: SyncMode): boolean {
    return this.#stores.length > 0 && syncMode.durability === "persistent"
  }
  ```

  `SyncMode` is already imported in this file. The method owns the **whole** composite, which is the point: a predicate that named only the durability half would leave `this.#stores.length > 0 && isDurable(...)` to be written at each site, and the sites could still disagree. See Alternatives Considered.

  This is also where the reasoning lives. One comment, at the definition, explaining that transient documents are presence-shaped and that durable storage never sees them in either direction. The call sites reference the rule rather than restating it.

- ✅ Task 1.2: `createInterpretDoc` — replace all three reads.

  Correct the existing binding at `:819` and reuse it at `:839` and `:876`:

  ```ts
  const willHydrate = this.#usesStores(bound.syncMode);
  ```

  A transient document then takes the existing `else` branch: latch `"loaded"`, substrate built by `factory.create` with identity claimed immediately, registered with the synchronizer and ready in the same tick, with no hydration round-trip.

- ✅ Task 1.3: `#createReplicateDoc` — replace both reads (`:948`, `:959`) the same way, reading `syncMode` from its parameter. Headless relays hold transient documents too, and the latch hazard is identical here.

- ✅ Task 1.4: Comment `#persistIfAdvanced`. It needs no code change: a transient document never acquires a store-program phase once the rule is in place, so the existing `if (!phase) return` catches it before any version or export work.

  Two things worth recording there, because neither is visible from the code. First, this is no longer the mechanism keeping presence off disk — it is a second line of defence behind a declared rule, and if it ever stops catching them the rule upstream has already failed. Second, the early return is now doing real work: a registered transient document ran three discarded operations per mutation before giving up — `version().serialize()`, `parseVersion`, and an `exportSince` that always returned `null` — and presence documents mutate on every cursor move.

- ✅ Task 1.5: Tests for this phase, in `packages/exchange/src/__tests__/store-integration.test.ts`. See §Tests for what each one is for.

  - **A transient document leaves no trace.**
  - **A transient replicate document leaves no trace** — the only coverage of Task 1.3.
  - **A transient document settles.**
  - The existing ephemeral case (`:162`) passes **unchanged**.

  The two `destroy` cases belong to Phase 2 and must not be written here — `destroy` still dispatches unconditionally at this point, which is the status quo and harmless, since the store holds nothing to delete.

# ✅ Phase 2 — Teardown

> `fix(exchange): destroy skips the store for a document that was never stored`

Separate from Phase 1 because it is a separate claim with its own risk. Phase 1 stops documents entering the store; this stops the exchange asking the store to remove something it never held. The risk is the opposite one — deleting too little — and it has its own test.

- ✅ Task 2.1: `Runtime.destroy` — gather the facts, decide, then execute. The sync mode has to be read before `#docCache.delete(docId)` removes the entry, and sequencing the read as a separate step removes the ordering hazard rather than leaving a comment warning about it:

  ```ts
  const entry = this.#docCache.get(docId);
  const touchesStore =
    entry === undefined ||
    entry.mode === "deferred" ||
    this.#usesStores(entry.readyInfo.syncMode);

  this.#docCache.delete(docId);
  if (touchesStore) this.#storeHandle?.dispatch({ type: "destroy", docId });
  this.#hooks.onDocDestroyed?.(docId);
  ```

  Three branches, not an optional access: `DocCacheEntry`'s `deferred` variant is `{ mode: "deferred" }` with no `readyInfo` field, so `entry.readyInfo` does not typecheck without discriminating on `mode` first.

  **A document with no cache entry must still dispatch.** `Exchange.destroy` is documented as "the single public API for document removal … delete from stores", and is expected to work on a document that exists on disk but was never opened this session. No cache entry means "nothing is known about this document", and the safe answer there is to proceed with the delete.

- ✅ Task 2.2: Tests for this phase, same file.

  - **`destroy` on a transient document issues no store delete.**
  - **`destroy` on a durable document that was never opened this session still deletes.**

  The second is the guard on this phase's risk, and nothing covers it today.

# ✅ Phase 3 — Documentation

> `docs(exchange): record the transient-storage rule`

- ✅ Task 3.1: `packages/exchange/TECHNICAL.md` §Storage. The store-program's input table lists `register` / `hydrated` / `destroy` with their triggers, none of which mention durability. Add a short subsection stating the rule: transient documents are never registered, hydrated, or deleted. Note that `compact` needs no guard because the store-program already returns unchanged for a document it does not know, and that the store-program's `destroy` case deliberately does **not** have that guard — see Transitive Effect 2 for why the asymmetry is load-bearing.

- ✅ Task 3.2: `packages/exchange/README.md` — **two places**, not one. The claim "Documents auto-hydrate on restart, auto-persist on mutation" appears at `:170` as a comment inside a code example, and again at `:429` in the prose introducing stores. Both read as a promise the ephemeral target does not keep. Qualify both: durable documents persist and hydrate; ephemeral ones deliberately do neither.

- ✅ Task 3.3: `CHANGELOG.md`, under `## Fixed` in the unreleased section. Lead with the observable symptom — a transient document's creation-time state was written to every configured store and hydrated on restart, while no later update was — then the rule that replaces it.

# ✅ Phase 4 — What the schema package should say about transience

> `docs(schema): the durability axis, and the state substrate's absent identity`

A separate commit because it is a separate package and a separate audience. Nothing here depends on Phases 1–3, and none of it is about storage mechanics — it is what a reader of `@kyneta/schema` needs in order to understand what declaring a mode `transient` commits them to. Landing it inside the exchange fix would put a note about CRDT peer identity in a diff about stores.

- ✅ Task 4.1: Extend the `Durability` doc comment in `packages/schema/src/substrate.ts:703` to say what `transient` commits to in practice: the state is presence-shaped, it may expire on a timer via `.decay()`, and durable storage never sees it in either direction.

- ✅ Task 4.2: Record the identity guard at `packages/schema/src/substrates/ephemeral.ts`, on `ephemeralSubstrateFactory` (`:540`) or `StateVersion` (`:70`) — wherever someone adding a tie-breaker would land first.

  Two facts and one instruction. The state substrate has **no peer identity**: `bind.ts:568` hands back a singleton and never reads `ctx.peerId`, and `StateVersion` is a scalar timestamp rather than a per-peer vector. It gets away with that because it is concurrent-by-default and merges field-by-field, so it never has to order two writes by their author.

  The instruction is for whoever changes that. **If the state substrate ever needs a per-peer identity, derive it from the exchange's stable `peerId` — the one `bind.ts:568` currently discards — rather than minting one per session.** Non-persistence protects across restarts on its own; it does not protect a long-lived peer, such as a relay or a tab left open for a day, which holds a transient document in memory across everyone else's reconnects. A per-session identity would add an entry there on every reconnect, for the life of that session. Same shape as the Yjs defect, reached by a different road, and cheap to foreclose while the substrate still has no identity to argue about.

- ✅ Task 4.3: `packages/schema/TECHNICAL.md` §Vocabulary. The `SyncMode` row names the three axes. Add that `durability: "transient"` means the exchange keeps the document out of stores entirely, so the consequence is discoverable from the type's own documentation.

  Add the identity fact alongside it, since the two are related and neither is currently written down: the state substrate carries no peer identity, which is why nothing about a transient document's continuity depends on storage. Cross-reference Task 4.2's guard rather than restating it.

# Tests

All in `packages/exchange/src/__tests__/store-integration.test.ts`, which already provides `createInMemoryStore({ sharedData })` for cross-instance persistence and an inspectable `sharedData` map, so these assert against the store directly rather than through a spy. `PresenceDoc` (`:84`) is the existing ephemeral binding.

Each test ships in the phase that makes it pass, so no commit lands with a failing or absent test for the behaviour it claims.

**Phase 1**

- ✅ The existing ephemeral write → shutdown → restart case (`:162`) passes **unchanged**. Do not edit it. If it needs editing, the change altered behaviour rather than declaring it, and that is worth stopping over.

- ✅ **A transient document leaves no trace.** Create one, write to it, and assert `sharedData.records` holds nothing for its docId. Today it holds a creation-time entirety, so this fails before the change and is the test that would have caught the original defect.

- ✅ **A transient replicate document leaves no trace.** `exchange.replicate(docId, ephemeralReplicaFactory, SYNC_EPHEMERAL, hash)` — both are exported from `@kyneta/schema` — then assert `sharedData.records` is empty for that docId. Fails before the change, since the replicate path registers exactly as the interpret path does.

  This is the **only** coverage of Task 1.3, and without it that task ships unverified. The latch half of the hazard cannot be tested here: a replicate document has no `docStatus` surface, so a latch stuck at `"pending"` has no observable consequence in that mode. The store assertion is what remains observable, and it is enough to catch the tail being changed without the rest.

- ✅ **A transient document settles.** With stores configured, `await whenSettled(doc)` resolves and `docStatus(doc)` is not `pending`. This is the one that catches a fix applied to the tail but not the latch — a failure mode the other tests cannot see, because the existing ephemeral case awaits only `flush()` and `shutdown()`, both of which complete for an unsettled document.

**Phase 2**

- ✅ **`destroy` on a transient document issues no store delete.** Assert the store is untouched across the call.

- ✅ **`destroy` on a durable document that was never opened this session still deletes.** Write a document through one exchange, shut it down, open a second exchange over the same `sharedData`, call `destroy` on the docId **without** first calling `get`, and assert the records are gone. Nothing covers this today, which is what makes the rejected guard in Alternatives Considered look safe.

**Throughout**

- ✅ A durable document still hydrates — already covered by existing cases in this file. Confirm they stay green after each phase rather than adding another.

No new tests for `#persistIfAdvanced` or `compact`: neither changes, and both are covered transitively. Phases 3 and 4 add no tests; they change documentation and comments only.

# Transitive Effect Analysis [scratch]

1. **The hydration latch → the settle conjunction.** The constraint that shapes Phase 1. `createHydrationLatch` is fed to `registerHydrationTerm`, which registers a settle term over `hydration.state === "loaded"`. A latch initialized `"pending"` and never resolved leaves the document permanently un-settled. This is why the five sites are a single rule rather than five independent edits.

2. **`Runtime.destroy` → `Exchange.destroy`'s contract.** The store-program's `destroy` case emits `persist-delete` unconditionally, while its `compact` case guards on `!existing`. Making them symmetric would break removal of a document that is on disk but not open, which is what `Runtime.destroy` dispatching without consulting the cache exists to support. The asymmetry is deliberate and must survive this change.

3. **`#persistIfAdvanced` → store-program phase map.** The write path is guarded by `if (!phase) return`, where `phase` comes from the store-program's `docs` map. Skipping `register` means a transient document never enters that map, so writes stop without touching the write path. The guard exists for a different reason — documents still hydrating — and happens to cover this too.

4. **`flush()` / `shutdown()` → `allDocsIdle`.** Both await the store-program reaching a state where every tracked document is idle. A transient document that never registers is not tracked, so it cannot delay shutdown. Note that this is also why `flush()` and `shutdown()` cannot detect an unsettled document, and why Success Criterion 2 needs its own test.

5. **Document readiness timing.** Transient documents move from the asynchronous hydrate-then-register path to the synchronous `else` branch, so they become ready in the same tick rather than after a store round-trip, and `#trackHydration` is not called for them. Any existing test that awaited hydration for an ephemeral document may now race differently.

6. **Peer identity on the no-store path — nothing is lost, because nothing is there.** `createInterpretDoc`'s `else` branch builds the substrate with `factory.create`, which claims this peer's identity immediately, rather than through `beginHydration`, which defers it. Correct for a transient document: there is no stored history to import, and importing your own history after claiming your identity is the only situation where claiming early loses data.

   It is moot in practice today, and worth recording why, because "we stopped persisting it" is exactly the kind of change that could break identity continuity if there were any identity to break.

   There is none. The ephemeral binding's factory _builder_ discards the peer context entirely — `factory: () => ephemeralSubstrateFactory` (`packages/schema/src/bind.ts:568`) returns a module-level singleton, where the CRDT targets do `factory: (ctx) => createMyFactory(ctx.peerId)`. So the exchange's `peerId` never reaches a transient substrate, and the entirety currently written to disk carries no identity to be continuous with.

   Nor is there a version vector that could accumulate. `StateVersion` (`substrates/ephemeral.ts:70`) wraps one wall-clock `number`; `meet` is `Math.min`, `serialize` is `String(timestamp)`, and `lineage` is a constant. The Yjs identity defect needed two ingredients — a fresh identity per restart, and a persisted history that retained every past identity's operations. A transient document has neither, so even a randomly-minted identity would leave no residue.

   The substrate gets away with having no identity because it is concurrent-by-default: `StateVersion.compare` returns `"concurrent"` even for identical timestamps, deliberately, so that two peers writing _different fields_ in the same millisecond do not discard each other's payloads. It merges field-by-field rather than ordering writes by author, so peer identity is the tie-breaker it chose not to need. `.decay()` bounds residency further — stale presence expires on a timer rather than accumulating.

7. **`deferred` cache entries carry no `readyInfo`.** A deferred document has no replica and never registers with the store, so `destroy` on one falls through to "dispatch anyway" — correct by the same reasoning as an unknown document, and the reason the `destroy` check discriminates three ways.

8. **Multi-store fan-out.** Writes go to every configured store and reads use first-hit across them. The skip is upstream of both, so it applies uniformly. The five production backends and the conformance suite are untouched.

9. **`compact` on a transient document.** `Exchange.compact` is application-called and meaningless for a substrate with no history to trim. The store-program already returns unchanged for a document it does not know, so no guard is needed — but the safety is the store-program's, not the runtime's.

10. **The other two `#stores` reads are not decision points.** `shutdown()` and `#trackHydration` iterate the backends (`for (const backend of this.#stores)`) to close them and to fan out hydration tracking. Neither asks about durability, and neither needs the predicate.

# Resources for Implementation [scratch]

- `packages/exchange/TECHNICAL.md` §Storage — the store-program's input and effect vocabulary, per-doc phase tracking, and the dispatch chain from quiescence drain to durable write. Read before touching the runtime.
- `packages/exchange/src/runtime.ts` — `createInterpretDoc` (public, `:777`), `#createReplicateDoc` (`:922`), `destroy` (`:533`), `#persistIfAdvanced` (`:645`), `#hydrate`.
- `packages/exchange/src/settle.ts:180` — `registerHydrationTerm`, and the docstring explaining why a document that never resolves its latch is "permanently un-settled with nothing said about why".
- `packages/exchange/src/store/store-program.ts` — the `destroy` and `compact` cases, whose asymmetry is Transitive Effect 2.
- `packages/schema/src/substrate.ts:703` — `Durability`; `:731` — `SYNC_EPHEMERAL`, the only transient mode.
- `packages/exchange/src/__tests__/store-integration.test.ts` — the harness, `PresenceDoc` at `:84`, and the ephemeral case at `:162` that must pass unchanged.

# Alternatives Considered

**Write `syncMode.durability === "persistent"` inline at each site.** Rejected. It is a single field equality, which makes it look like the kind of expression that reads better inline than behind a name — but the question each site actually asks is the composite "does this document use stores?", and there are five of them across two methods. Inline means five copies of one rule, and the settle-term hang described in the Problem Statement is what happens when they disagree. The current code is already a demonstration: a binding for exactly this fact exists at `:819` and is used once, while two sites four and fifty-seven lines below re-derive it.

**A named `isDurable(mode: SyncMode)` predicate in `packages/schema/src/substrate.ts`.** Rejected, and the evidence is stronger than it first appears. There are four reads of `.durability` in the monorepo: `synchronizer.ts:1489` passes the value through to `classifyResetTrigger` (which takes a bare `Durability` and would have to widen its parameter), `store/store.ts:189` and `substrate.ts:899` compare two modes to each other rather than testing for persistence, and `bind.ts:617` writes `const isEphemeral = syncMode.durability === "transient"` — the opposite polarity, and already solved there by a local alias at the point of use. So a shared predicate would have one adopter, inverted.

It also names only one conjunct. Sites would still write `this.#stores.length > 0 && isDurable(bound.syncMode)` five times, and could still drift. `#usesStores` is preferred because it owns the composite, and because `this.#stores` is the Runtime's own field — a schema-level helper cannot see it.

**Guard the store-program's `destroy` case on `!existing`, mirroring `compact`.** Rejected. It needs no sync-mode plumbing and makes the two destructive inputs symmetric, but it would silently break deleting a document that exists on disk and was not opened this session — precisely the contract `Exchange.destroy` advertises.

**Skip only the `register` dispatch, keeping the hydrate read.** Rejected. It fixes the stale row with the smallest possible change, but leaves the invariant true in one direction only: transient documents would still query every store on every open for data that cannot be there. A half-stated rule is harder to describe, harder to test, and easy to erode.

**Give transient documents an empty store list — `const stores = usesStores ? this.#stores : []` — so that `stores.length > 0` is simply correct everywhere.** Rejected, though it is the most structural version of the idea: it would make the invariant hold by construction rather than by five agreeing call sites. `#stores` is read elsewhere in the class, so threading a per-document view of it through those paths trades one multi-site problem for another. The predicate is enough.

**Leave it, relying on `exportSince` returning `null`.** Rejected. This is the status quo. It does keep updates off disk, but by inference from a snapshot-only substrate's incidental behaviour rather than by rule, and it does not prevent the creation-time write that is the actual defect.
