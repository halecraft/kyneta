fix(schema,exchange): a peer keeps its identity and its stored data across a restart

# Background

Every peer in Kyneta has a `peerId`, and `packages/exchange/src/exchange.ts:176-178` states the invariant it must satisfy:

> **Stability:** The same participant must use the same peerId across restarts. Without stability, each boot fragments the CRDT version vector with phantom peer entries and breaks causal continuity.

Substrate backends translate that string into whatever their CRDT uses to attribute operations. Yjs uses a numeric `clientID`, derived deterministically by `hashPeerId(peerId)` (`packages/schema/backends/yjs/src/bind-yjs.ts:89`), so the same `peerId` should produce the same `clientID` on every boot.

## Why the *order* of claiming it matters

In Yjs an operation's address is the pair `(clientID, clock)`, where `clock` is a per-client counter. **That counter starts at zero on a fresh document.** It only means anything relative to the history the document has loaded.

So a peer that claims its stable id on an empty document, and writes before loading its own stored history, produces operations at addresses that history already occupies. Two genuinely different operations end up claiming `(42, 0)`. Yjs keeps one and discards the other — which is not a fault but the mechanism that makes CRDT merge idempotent: applying the same update twice must be a no-op, and `(clientID, clock)` is how "the same" is decided.

Yjs defends against this. When an update arrives carrying operations from the local `clientID` that the document did not author, it concludes two live clients share an id and **silently reassigns its own `clientID` to a fresh random value**. Loading your own persisted history looks exactly like that. The defence is real and it works — but only if it fires before any local write.

Measured, with a prior session that wrote three items under `clientID` 42:

| Sequence | Resulting `clientID` | Array contents |
| --- | --- | --- |
| claim id → import history | reassigned | `["p1","p2","p3"]` — intact |
| claim id → **write** → import history | reassigned | `["mine","p2","p3"]` — **`p1` lost** |
| import history → claim id → write | **42** | `["p1","p2","p3","mine"]` — complete |

The third row is the correct ordering, and it is what `SubstrateFactory`'s two-phase construction path already does.

## The three ways a substrate gets built

**`create(schema)`** — a fresh backing document, identity claimed immediately, containers ensured. Reached from `Runtime.createInterpretDoc` (`runtime.ts:806`) and from the standalone path (`create-doc.ts:139`).

**`createReplica()` then `upgrade(replica, schema)`** — a backing document with a *throwaway* identity, safe to hydrate into because it performs no local writes; `upgrade` claims the stable identity once imports are done. Used for replicate-mode documents and by `fromEntirety`.

The bindings say why in their own comments (`bind-yjs.ts:94-107`):

```ts
createReplica() {
  // Default random clientID — safe for hydration (no local writes).
  // Identity is set at upgrade() time, after hydration.
}
upgrade(replica, schema) {
  // Set stable identity AFTER hydration — avoids Yjs clientID
  // conflict detection that would reassign to a random value.
}
```

The two-phase path is row three of the table. `create()` is rows one and two — and it is the path every interpreted document takes.

## The two callers of `create()` are not alike, and the codebase already says so

`createDoc`'s own docstring (`create-doc.ts:98-99`):

> For standalone use — generates a random peerId. The exchange provides its own stable peerId and calls `createRef` directly.

A standalone document imports nothing at construction, so claiming identity immediately is correct there and always has been. The Runtime with stores is the one caller about to import its own history, and the only one that needs to wait.

That asymmetry is what the fix turns on. It also explains why the fix must be **additive**: changing `create()` would be correct for one caller and silently wrong for every other, including ones not written yet.

# Problem Statement

One cause, two symptoms. Both measured through `Runtime` with an in-memory store, under the same `peerId` across a shutdown and reopen.

**1. A Yjs peer silently discards its own stored data if it writes before hydration completes.** Session one stores two items; session two writes one item immediately after `get()` returns, without waiting:

```
writes immediately  → ["early-write", "stored-2"]        ← "stored-1" is gone
waits for hydration → ["stored-1", "stored-2", "late-write"]
```

No error, no warning, no diagnostic. The window is open from the moment `get()` returns until hydration resolves, and `get()` returns synchronously by design — so any application that writes on the same tick it opens a document is inside it.

**2. A Yjs peer gets a new identity on every restart, unconditionally.** Even with no early write, the defence fires and the peer is renamed:

| Path | Backend | Session 1 | Session 2 |
| --- | --- | --- | --- |
| `get()` (one-phase) | **yjs** | `2267157479` | **`3120442030`** |
| `get()` (one-phase) | loro | `3143209096067335` | `3143209096067335` |
| `replicate()` → `upgrade()` (two-phase) | yjs | `2267157479` | `2267157479` |

Across three restarts the version vector accumulates `{42:7, 1998514805:3, 964710242:3, 3507791966:3}` — four entries for one peer. Worse than the count: the stable id holds only session one's work. From session two onward every write lands under a throwaway the next boot abandons, so `exportSince(peer=42)` never again sees anything this peer writes, and a peer loses causal continuity with itself.

**3. Both identity-bearing backends lose data; only Yjs also loses identity.** Measured with an early write against Loro:

```
s2 PeerID before write: 3143209096067335   ← claimed immediately, and stable
s2 items after flush:   ["early-write","stored-2"]   ← "stored-1" gone
s3 (no early write):    ["stored-1","stored-2"]      ← fine
```

Loro addresses operations the same way and collides identically. What differs is the response: Yjs detects the collision and defends by reassigning its `clientID`, which costs the identity but saves the data when nothing has been written yet; Loro does not defend at all, so its `PeerID` stays stable while the operation is simply dropped.

That makes Loro's stability misleading rather than reassuring — identity looks healthy across a restart *because nothing intervened*. An identity-only measurement therefore scopes this defect wrongly: both bindings need the fix, and only the symptom is Yjs-specific.

**4. Two further things scope it.**

- **It requires a store.** Without one there is no hydration, so there is no import of the peer's own history and nothing to collide with.
- **A correct implementation already exists in the tree.** The two-phase path is right, and is what interpreted documents do not use.

Plain and ephemeral carry no identity and are unaffected.

**5. Nothing tests it.** No test in the repository asserts that a peer's substrate-level identity survives a restart, or that stored data survives a write issued before hydration, for any backend.

**6. `createDoc` offers identity as an optional third parameter, and the call sites show why that is the wrong shape.** Across the repository: 446 calls pass one argument, 56 pass two, and **4 pass three** — all in one file, all written `createDoc(bound, undefined, "peer-a")`. Every caller that wants an identity must first stuff a placeholder past an argument it does not want.

The parameter is also absent from the `@param` list, two lines below prose saying the function "generates a random peerId", so a reader cannot tell whether supplying one is supported or vestigial. `payload`'s optionality is honest — its default is observably "no payload". `peerId`'s is not: the default is a *random identity*, which looks like no decision until the moment it matters, which is exactly how it became a trap.

# Success Criteria

1. A Yjs document written to immediately after `get()` returns — before hydration completes — **retains all previously stored data**.
2. A Yjs document opened with `get()`, written, persisted, and reopened under the same `peerId` has the **same `clientID`** in both sessions.
3. The same holds for Loro. Its data loss is the same defect; its identity was never at risk, so that half is a regression guard rather than a change.
4. `create()`'s behaviour is unchanged, so every caller that does not hydrate — `createDoc`, and any future one — keeps working without knowing this plan happened.
5. Supplying a peer identity to a standalone document is a distinct, named call whose `peerId` is **required**; the everyday surface does not offer it at all. No caller passes a placeholder to reach it.
6. Identity is claimed exactly once per document, and never while imports are outstanding.
7. The substrate contract states when a factory may claim identity, so a future backend does not have to rediscover this by measurement.
8. Full `pnpm verify` passes.

# ✅ Phase 1: Give the identity-taking path its own name

Independent of the rest of this plan, and landable on its own. It comes first because it makes the two-callers story concrete: after it, "a caller that supplies its own identity" is a function you can point at rather than a parameter you have to know about.

- ✅ Task 1.1: Split `createDoc` in `packages/schema/src/create-doc.ts` into two surfaces over one implementation.

  ```ts
  /** A standalone document under a specific peer identity. */
  export function createDocAs<S extends SchemaType, N extends NativeMap>(
    peerId: string,
    bound: BoundSchema<S, N>,
    payload?: SubstratePayload,
  ): DocRef<S, N>

  /** A standalone document. Identity is arbitrary — see `createDocAs`. */
  export function createDoc<S extends SchemaType, N extends NativeMap>(
    bound: BoundSchema<S, N>,
    payload?: SubstratePayload,
  ): DocRef<S, N>
  ```

  `createDocAs` holds the implementation; `createDoc` is `createDocAs(randomPeerId(), bound, payload)`. One code path, two entry points, and callers tap in at the level that matches what they know.

  **Required, not optional, is the whole point.** An optional `peerId` defaults to a random identity — a default that looks like "no decision" and behaves like one right up until operations are exported, attributed, or compared across runs. Making it required on its own function means a caller either does not care (and never sees it) or does care (and must say so). There is no third state where they got one by accident.

  Put `peerId` first so the distinguishing argument leads and no caller writes a placeholder. The four existing three-argument calls become `createDocAs("peer-a", bound)` — shorter than what they replace.

  While here: the `CreateDoc` type declares two overloads whose only difference is whether `payload` is optional, so the second accepts nothing the first does not. Verify that during implementation and collapse it — after the split, one signature covers each function.

- ✅ Task 1.2: Update the four call sites in `packages/schema/backends/yjs/src/__tests__/opaque-boundary.test.ts` (`:151`, `:152`, `:216`, `:217`).

  They are the only three-argument callers in the repository. Each currently reads `createDoc(bound, undefined, "peer-a")`; each becomes `createDocAs("peer-a", bound)`.

  What they want is two documents that are reproducibly distinguishable — random identities would also be distinct, but not the same across runs, so a failure would not reproduce. That is a legitimate need for a lower-level entry point, not a test-only affordance: any caller exporting a standalone document's operations for later attribution wants the same guarantee.

- ✅ Task 1.3: Export `createDocAs` from `packages/schema/src/index.ts` beside `createDoc`, and add it to the canonical-symbols line in `packages/schema/TECHNICAL.md:7`.

# ✅ Phase 2: A construction path for callers who are about to hydrate

The Runtime needs a substrate that has not yet claimed identity, because it is about to import that identity's history. No other caller does. The contract should express that as an extra path rather than as a change to the existing one.

- ✅ Task 2.1: Add an optional construction method to `SubstrateFactory` in `packages/schema/src/substrate.ts`, and a helper that supplies its default.

  ```ts
  /** A substrate plus the obligation that comes with it. */
  export type HydrationHandle<V extends Version = Version> = {
    readonly substrate: Substrate<V>
    /** Claim this peer's stable identity. Idempotent. */
    readonly adopt: () => void
  }

  // on SubstrateFactory — optional
  createForHydration?(schema: SchemaNode): HydrationHandle<V>

  /** Build a substrate for a caller that is about to import this peer's own
   *  history. Falls back to `create()` for backends that need no deferral. */
  export function beginHydration<V extends Version>(
    factory: SubstrateFactory<V>,
    schema: SchemaNode,
  ): HydrationHandle<V>
  ```

  **The obligation travels in the return value.** A caller cannot obtain the substrate without also being handed the function it owes. Compare a capability symbol on the substrate, which a caller can only discharge if they already knew to go looking for it — that is the failure mode this shape removes.

  **`create()` is untouched**, and that is the point. Its behaviour stays correct for every caller who is not about to hydrate, so a naive caller — including one written next year — gets the safe answer by default. Only the caller who knows it is special reaches for the other path, and the name says what makes it special.

  Optional, because most backends need no deferral: plain and ephemeral hold no identity, and Loro's reconciles against operations already present. `beginHydration` supplies the default — `create()` plus a no-op `adopt` — so backends opt in only when they must. `Substrate` already carries optional members (`runBatch?`, `tick?`), so opt-in-by-omission is the established shape.

  The default lives in `@kyneta/schema` rather than at the call site because it is a statement about the substrate contract — *claiming immediately is safe when nothing will be imported* — not a convenience for one consumer.

- ✅ Task 2.2: Document the ordering rule on `create`, `createReplica` and `createForHydration`.

  State it in terms of operation addressing, which is what makes it predictable rather than a Yjs quirk: **a CRDT that addresses operations by `(peer, counter)` cannot safely claim its identity on an empty document that is about to import that peer's own history — the counter restarts at zero and the addresses are already taken.** A backend in that position implements `createForHydration`. A backend whose identity assignment reconciles against existing operations, as Loro's does, needs nothing.

  Cross-reference the two-phase path (`createReplica` → `upgrade`), which has always had this ordering right, so a reader sees `create()` as the path with a precondition rather than the default that everything else deviates from.

# ✅ Phase 3: Yjs implements the deferred path

- ✅ Task 3.1: In `packages/schema/backends/yjs/src/bind-yjs.ts`, implement `createForHydration` — the same construction as `create()`, minus the `clientID` assignment, returning an `adopt` that performs it.

  This closes the data-loss window outright rather than narrowing it. A write issued before hydration lands at `(R, 0…)` under the document's own random id, which cannot collide with `(42, 0…N)` however late the import arrives. The stored history imports cleanly, `adopt()` then continues the counter from `N+1`, and every subsequent write is correctly attributed.

  What remains is a bounded cost with no data attached: that session's early operations stay under `R`, so the version vector carries one extra entry that will never grow. It does not compound — the next restart adds nothing if the caller waits.

  Note for the implementer, because it is directly adjacent and surprising: `ensureContainers` temporarily sets `doc.clientID` to `STRUCTURAL_YJS_CLIENT_ID` (0) and restores the caller's id afterwards (`populate.ts:46-49`), so structural ops are byte-identical across peers and dedupe on merge. That is why a freshly built document has *no* operations under the peer's own id, and therefore why the reassignment fires even with no local write. It also means the restore lands on whatever id is current, so it composes with deferral without change.

- ✅ Task 3.2: Factor the shared body out of `create` and `upgrade` in the same file.

  The two are near-identical today — same `ensureContainers`, same substrate wrap — and after Task 3.1 there are three constructions differing only in where the document comes from and whether identity is claimed. `plain` and `ephemeral` avoid this by defining `create` as one line (`this.upgrade(this.createReplica(), schema)`); the identity-bearing bindings cannot, precisely because that one line would claim identity.

  Extract a local builder taking `(doc, schema, claimIdentity)` and express all three in terms of it. The one difference that matters then appears as an argument rather than being inferred by diffing two function bodies — and the asymmetry that `PLAN-2026-08-13-replicate-promotion` depends on becomes legible in one place.

- ✅ Task 3.3: Implement `createForHydration` on the Loro binding too, with the same shared-builder treatment.

  Loro needs it for the data half even though it never loses identity. `setPeerId` reconciles the *identity* against operations already present — which is why a Loro peer keeps its `PeerID` across a restart — but it does nothing about the `(PeerID, counter)` collision that an early write creates, and Loro has no equivalent of Yjs's reassignment defence. The operation is simply dropped.

  Record that asymmetry at the `setPeerId` call, because the healthy-looking identity is what makes this easy to miss: the reason Loro passed an identity-only measurement is that nothing intervened, not that nothing was wrong.

# ✅ Phase 4: The Runtime takes the deferred path when it will hydrate

- ✅ Task 4.1: In `Runtime.createInterpretDoc` (`packages/exchange/src/runtime.ts:774`), choose the construction path by whether hydration is coming.

  With stores, call `beginHydration(factory, bound.schema)` and keep the returned `adopt`. Without stores, `create()` as today — there is nothing to import, so there is no collision to avoid and deferring would only widen the transient window for no benefit.

  Call `adopt()` in the continuation that already runs `resolveHydration(hydration, { ok: true })`, and call it **before** `#register(entry)` and `#wireDocSubscription`. Registration announces the document to the sync graph and the subscription starts forwarding local changes; both should see the peer's final identity rather than a transient one.

  Do **not** adopt on the hydration-failure branch. A failed load leaves the document deliberately unregistered and un-settled because its state is unknown; claiming a stable identity on a document we may yet reload would defeat the point.

- ✅ Task 4.2: Leave `#createReplicateDoc` untouched. A replicate document has no substrate and claims no identity; the transition happens in `upgrade()`, which is already correct.

- ✅ Task 4.3: Leave both standalone entry points untouched in behaviour. `createDoc` and `createDocAs` reach `create()`, which still claims identity — correct for a document that imports nothing at construction.

# ✅ Phase 5: Tests

- ✅ Task 5.1: Add `packages/exchange/src/__tests__/identity-stability.test.ts`.

  **The load-bearing test — stored data survives an early write.** Build a `Runtime` with an in-memory store, `get()` a document, write two list items, `flush`, `shutdown`. Build a second `Runtime` with the same `peerId` and the same store, `get()` the document, and **write immediately without awaiting hydration**. Assert all three items are present.

  This is the one that fails today, returning `["early-write", "stored-2"]` with the first stored item silently gone. It is first in the file because it is the symptom a user would actually report.

- ✅ Task 5.2: **Restart identity, per backend.** Same two-session shape, but the second session waits for hydration before reading. Assert the substrate identity is unchanged across sessions.

  Run it for Yjs and Loro from one shared helper. Yjs is the regression this plan fixes; Loro's identity was already stable, so its row guards behaviour that is correct today and could silently break if someone changes `create()`.

  Sample the identity in **both** sessions only after flushing. A store-backed document wears a transient identity until its stored state arrives — that is the mechanism — so reading before then compares two throwaways and the test says nothing.

  Assert content alongside identity. A fix that stabilised identity by discarding stored state would otherwise pass, and that failure mode is worse than the defect.

- ✅ Task 5.3: Add a no-store case: two sessions, no store, identity stable and available immediately after `get()` returns.

- ✅ Task 5.4: **`create()` still claims identity** — the property Success Criterion 4 rests on. `createDocAs("alice", bound)` twice produces the same substrate identity, for Yjs and Loro. This is what would fail if someone later "simplified" the two construction paths back into one, and it is the guard on every caller that never learns this plan existed.

  It is also the test that makes `createDocAs` worth having: without a required identity there would be no way to state this property at all.

- ✅ Task 5.5: Add a unit test for `beginHydration`'s default: a factory that does not implement `createForHydration` still yields a usable substrate and an `adopt` that is safe to call. Graceful absence is the whole reason for the optional method, and it is two assertions.

# ✅ Phase 6: Documentation

- ✅ Task 6.1: `packages/schema/src/create-doc.ts` — write the docstrings the split earns.

  On `createDocAs`, say what a supplied identity buys: operations attributable to a named peer, and reproducibility across runs. On `createDoc`, say plainly that identity is arbitrary and point at `createDocAs` for when it is not — replacing the current sentence, which states the random default as a fact without saying it is a choice a caller can make differently.

- ✅ Task 6.2: `packages/schema/TECHNICAL.md` §"The six-layer stack" — document `createForHydration` and `beginHydration` beside the optional-capability bag at `:518-520`, and state the ordering rule from Task 2.2 as the reason they exist.

  Frame it as a property of operation addressing rather than a Yjs footnote. A backend author reading only this file should learn that claiming identity in `create()` has a precondition, and be able to tell whether their backend meets it.

- ✅ Task 6.3: `packages/schema/backends/yjs/TECHNICAL.md` — record the mechanism concretely, since "my own peerId can drop my own data" is counter-intuitive enough that a reader needs the reason, not the rule.

  Give the three-row measurement from the Background: claim-then-import reassigns and keeps data; claim-then-write-then-import reassigns *and* loses an operation; import-then-claim preserves both. Explain that `clock` restarts at zero on a fresh document, so claiming an id before loading that id's history means writing to addresses already in use, and that Yjs's dedup is doing exactly what idempotent merge requires.

- ✅ Task 6.4: `packages/exchange/TECHNICAL.md` §"Peer-ID continuity" — note that substrates carry their own translation of the `peerId` stability invariant, and that a store-backed document claims its substrate identity after hydration rather than at construction.

- ✅ Task 6.5: No README changes. Nothing in the public API changes shape; a documented invariant starts holding, and one existing parameter gains its documentation.

# Tests

Covered by Phase 5 in full. The strategy in one line: **one early-write test for the data loss, one restart test across two backends for the identity, and one test that `create()` still claims identity** — the last being the guard on the design's safe default, and expressible only because `createDocAs` requires a peer to name.

Deliberately not tested: that phantom entries no longer accumulate in the version vector. That is a *consequence* of the identity defect rather than the defect, reaching it needs a multi-session multi-peer setup, and it cannot fail while the identity assertion passes. Testing the cause is cheaper and stricter.

# Transitive Effect Analysis [scratch]

**`createDoc`, `createDocAs`, and every other `create()` caller.** Unaffected by construction — the method they call does not change. This is the whole reason the fix is additive rather than a change to `create()`: the alternative would have been correct for the Runtime and silently wrong for the standalone path, whose documents would have kept a random identity forever with nothing to adopt on their behalf. `createDocAs` makes that failure mode visible rather than theoretical — a caller who has explicitly named a peer would have silently got a different one.

**Yjs documents written before hydration completes.** Today this window silently discards stored operations. After the fix it is safe: early writes land under the document's transient id, which cannot collide with the stored history's addresses. The residual cost is one version-vector entry for that session, holding real operations that merge normally and never grow. It does not compound across restarts.

The readiness layer already exists to keep callers out of this window for an independent reason — writing before you have seen a document's stored contents is how defaults get written over real data, which is why `docStatus` reports `"pending"` rather than `"empty"` and why `initialize()` waits for settle before seeding. After this fix, a caller who ignores that guidance pays a bounded cost instead of losing data.

**`@kyneta/exchange`'s sync layer.** `registerDoc` reads `replica.version().serialize()` when announcing. Adopting identity before `#register` (Task 4.1) means the announced version reflects the final identity. Announcing first would advertise a version keyed to an id the peer is about to stop using, and peers would compute deltas against it.

**Loro.** Gains `createForHydration` alongside Yjs. Its `PeerID` is unchanged in value and in when it becomes stable — `create()` still claims immediately, and `adopt()` claims the same value the old path did. What changes is that a document loading from a store no longer holds that identity while the load is in flight, which is what stops an early write colliding with the incoming history.

**Plain and ephemeral.** No behaviour change. Neither implements `createForHydration`, so both take `beginHydration`'s default, which is `create()` — exactly what they do today.

**`persistentPeerId` (browser tabs).** Unaffected. It solves stability of the `peerId` *string* across reloads; this plan fixes the translation of that string into a substrate-level id. They compose: a stable string was already necessary, and is now also sufficient.

**Stores.** No format change. `StoreMeta` is `replicaType` + `syncMode` + `schemaHash`, none of which involve identity, and stored payloads are unchanged. Documents already persisted under fragmented identities keep working — the phantom peers in their version vectors are historical and simply stop accumulating. Operations already lost to a past early write are not recoverable; the fix stops further loss.

**`PLAN-2026-08-13-replicate-promotion`.** Independent, and this one should land first. That plan promotes a replicate document by calling `upgrade()`, which claims identity — so it depends on the ordering rule being written down (Task 2.2) rather than folklore, and on the `create`/`upgrade` asymmetry existing before it is described. Neither blocks the other technically.

# Resources for Implementation [scratch]

**Read before starting**

- `packages/schema/TECHNICAL.md:518-520` — the optional-capability bag (`TREE_NODE_ALLOCATE`, `DEVTOOLS_HISTORY`); `createForHydration` follows its opt-in-by-omission shape without needing a symbol.
- `packages/exchange/TECHNICAL.md` §"Peer-ID continuity" — the invariant this plan makes true at the substrate level.
- `packages/exchange/TECHNICAL.md` §"Document readiness — a conjunction over layers" — the existing guidance about not writing before a document has settled, which is the window this defect lives in.

**The specific code**

- `packages/schema/src/substrate.ts:1055` (`SubstrateFactory`, and `createReplica`'s "safe for hydration — no local writes" note), `:610` / `:658` (`runBatch?` / `tick?`, the optional-member precedent).
- `packages/schema/src/create-doc.ts:115-141` — the standalone path, the `CreateDoc` overload pair Phase 1 collapses, and the docstring it rewrites.
- `packages/schema/backends/yjs/src/__tests__/opaque-boundary.test.ts:151-152`, `:216-217` — the only three-argument callers in the repository, and the reason the lower level is worth naming.
- `packages/schema/backends/yjs/src/bind-yjs.ts:89` (`hashPeerId`), `:94-118` (`createReplica`, `upgrade`, `create` — the three together are the whole story).
- `packages/schema/backends/yjs/src/populate.ts:46-49` — `ensureContainers` and its temporary `clientID` override.
- `packages/schema/backends/loro/src/bind-loro.ts:97-116` — the same three, for the backend that needs no deferral.
- `packages/exchange/src/runtime.ts:774` (`createInterpretDoc`), `:806` (the `create()` call), and the store/no-store split at `:859`.
- `packages/exchange/src/exchange.ts:176-178` — the stability invariant, stated.

# Alternatives Considered

**Remove identity from `create()` and add an `ADOPT_IDENTITY` capability symbol on the substrate.** The first shape of this plan, following `TREE_NODE_ALLOCATE` and `DEVTOOLS_HISTORY`. Rejected on the property that matters most here: it makes the unsafe behaviour the *default*. `create()` would become correct for the one caller that hydrates and silently wrong for every other, and the obligation would live behind a probe — `hasIdentityAdoption(substrate)` — which a caller can only discharge if they already knew to look for it. `createDoc` would have shipped a regression on exactly that basis. Adding a path leaves every existing and future caller correct by doing nothing.

**A phantom type — `Substrate<V, Claimed extends boolean>`, with `createRef` requiring `Claimed = true`.** Genuinely correct by construction, and it cannot be used here. The Runtime's sequence is fixed by the synchronous return: `create` (`runtime.ts:806`), then `createRef` (`:808`), then hydrate. The ref must exist before hydration because `get()` hands it back on the same tick, so a ref must be constructible over an unclaimed substrate. A type whose purpose is to forbid that would reject the only sequence the system permits, and the only way to admit it is to weaken the constraint into meaninglessness.

**A distinct `UnclaimedSubstrate` type that structurally lacks identity.** Better shaped than the phantom parameter — `Substrate<V>` would stay untouched, so no file that merely names it changes, and only the two paths that care would see the distinction. It fails at the same wall: the enforcement point is still `createRef`, which still has to run before the claim. Any type that makes an unclaimed substrate unusable makes the Runtime's required sequence unusable too. The general shape of the obstruction is worth recording — correct-by-construction needs the obligation discharged before the value escapes, and the synchronous `get()` contract requires it escape first.

**Claim the stable identity at first write rather than after hydration.** Appealing because it removes the deferral entirely. Rejected: it is the measured data-loss case. A write under the stable id followed by an import of that id's own history produced `["mine","p2","p3"]`, with the first stored operation silently dropped. Deferring to first write does not avoid the collision, it guarantees it.

**Set `clientID` after hydration by assigning it directly from the Runtime.** Fewest moving parts: no new method, one line in the hydration continuation. Rejected because it puts a Yjs-specific fact in `@kyneta/exchange`, which is substrate-agnostic by design and reaches backends only through `SubstrateFactory`. The exchange would have to know which backends need it, which is the coupling the substrate interface exists to prevent.

**Rebuild the substrate through `upgrade()` after hydration.** The most faithful fix — it makes the interpret path literally use the two-phase construction that already works. Rejected on the signature, for the same reason as the phantom type: a substrate that does not exist until hydration resolves cannot back a ref that must exist now.

**Have Yjs re-assert its `clientID` after every merge.** Local to the binding, no contract change. Rejected: it fights the conflict detection instead of respecting it, on every merge for the life of the document, and a remote update legitimately carrying our own operations would flip it back and forth. The detection is a correctness feature — it is what saves the data in the no-early-write case — and the fix is to stop tripping it.

**Keep `createDoc`'s optional `peerId` and simply document it.** The smaller change, and it was this plan's first answer. Rejected once the call sites were counted: all four callers that use it write `createDoc(bound, undefined, "peer-a")`, stuffing a placeholder past an argument they do not want, which is a signature problem documentation cannot fix. Optionality is also the wrong shape for this particular default — a random identity reads as "no decision" and behaves like one until operations are exported or compared across runs. A required parameter on its own function removes the state where a caller got an identity without meaning to.

**Delete the parameter outright and let standalone documents always be anonymous.** Tempting: no production code passes it, and `createDoc`'s prose already claims identity is random. Rejected because the need is real and its one caller demonstrates it — two documents that must be distinguishable *reproducibly*, so a failure reproduces. Any caller exporting a standalone document's operations for later attribution wants the same thing. The need was never in question; only its shape.
