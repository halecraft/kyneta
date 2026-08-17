feat(exchange)!: get() promotes a replicate document when the caller supplies its schema

# Background

A document in an `Exchange` sits in one of three **phases**. `replicate` is the headless tier: the peer holds a bare `Replica` — enough to accumulate state, compute per-peer deltas and relay bytes — but no schema, no substrate, and no `Ref<S>`. Relays, audit logs and routing servers live here. `interpret` is the full tier: substrate, interpreter stack, a callable ref.

`exchange.get(docId, bound)` raises a document to `interpret`. It does that for a brand-new document and for a `deferred` one (a document a peer announced that we had no schema for). For a `replicate` document it throws.

That throw is a capability gap rather than a rule. The classifier says so in its own type — `packages/exchange/src/interpret.ts:39` distinguishes `refuse / "mismatch"` ("this can never work") from `refuse / "unsupported"` ("this is not built yet"), and replicate is the second.

**The machinery for the transition already exists, and exists for exactly this.** `SubstrateFactory.upgrade(replica, schema)` (`packages/schema/src/substrate.ts:1147`) turns a hydrated replica into a full substrate *wrapping the same backing document*, so accumulated state carries over rather than being rebuilt. Every backend defines ordinary construction in terms of it — `create(schema)` is `upgrade(createReplica(), schema)` in all four.

The Loro binding names the ordering directly. At `createReplica` (`packages/schema/backends/loro/src/bind-loro.ts:118`):

> Default random PeerID — safe for hydration (no local writes). Identity is set at upgrade() time, after hydration.

and at `upgrade` (`:127`):

> Claim identity now: this is the two-phase path, so any import has already happened and the op counter for our PeerID resumes past it rather than colliding with it.

That is a two-phase construction designed around a replica that accumulates first and gains a schema later. Promotion is that design being used.

## What makes this safe

The question the caller answers is the one the document is missing. A replicate document has no schema — that is the whole of what separates it from an interpreted one. `get(docId, bound)` supplies a schema. A peer that hands over a `BoundSchema` for a document it already holds is not asking for something it lacks the information to do; it is providing the information.

Two properties the surrounding code already guarantees make it safe to act on:

- **Compatibility is checkable.** `mismatchForInterpretation` (`@kyneta/schema`) is the law for this question and covers all three axes a document is identified by — `replicaType`, `syncMode`, `schemaHash`. Handing a `PlainReplica` to a Loro factory's `upgrade` is refused before it can fail obscurely.
- **`@kyneta/index` will not trigger promotion.** `Source.fromExchange` has its own membership predicate, `isTrackable`, whose `mode !== "interpret"` clause never lets a `Source` call `get()` on a replicate document. `packages/index/TECHNICAL.md` states the rule it enforces: a source may change a document's *readability*, never its *tier*. A conservation test asserts no document leaves `replicate` across a full mixed sequence.

What remains is that promotion is one-way: there is no `demote()`. That is a real cost and it is why this is opt-in per document, at a call site where the caller has spelled out a schema, and never a blanket sweep.

# Problem Statement

**1. `get()` refuses a transition it has everything it needs to make.** `#getImpl` (`packages/exchange/src/exchange.ts:759`) throws for a replicate document at `:811`; `Runtime.createInterpretDoc` (`packages/exchange/src/runtime.ts:863`) throws the same way at `:884`. Callers that legitimately want to start reading a document they have been relaying have no route short of destroying it and losing accumulated state.

**2. The sync layers cannot represent the transition.** Two places model mode changes, and both know only `deferred → X`:

- `Synchronizer.registerDoc` (`packages/exchange/src/synchronizer.ts:738`) emits `doc-promoted` when the previous mode was `deferred`, `doc-created` when the document is new, and **no event at all** otherwise. Since `#emitDocEvents` (`:1650`) returns early on an empty event list, a replicate → interpret change would never refresh `exchange.documents`, whose `DocInfo.mode` is rebuilt from `#docRuntimes` on each emit.
- `handleDocEnsure` (`packages/exchange/src/sync-program.ts:860`) returns the model **unchanged** when an entry exists and is not deferred. So the sync model would keep `mode: "replicate"`, never record the now-available `supportedHashes`, and never re-announce.

Both must learn `replicate → interpret` for a promotion to be visible anywhere outside the Runtime's own cache.

**3. Promotion is only safe once hydration has finished, and the cost of getting it wrong is silent data loss.** A replicate document created with stores configured hydrates asynchronously (`runtime.ts:1012`), and `upgrade()` claims the peer's stable identity on the backing document.

In a CRDT that addresses operations by `(peer, counter)`, claiming an identity while imports for that same identity are still arriving means writing to addresses the incoming history already occupies. The merge then deduplicates, and one of the two operations is discarded with no error. `SubstrateFactory.createForHydration` (`packages/schema/src/substrate.ts`) states this as a contract, and both CRDT backends implement it: a document about to import its own history keeps a throwaway identity until the import lands.

Ephemeral gives an independent reason. Its `upgrade` extracts through `exportEntirety()` and rebuilds rather than sharing the backing document, so an in-flight hydration merging into the old replica would land nowhere the new substrate can see.

**4. A ref-less document's hydration cannot be awaited.** `whenHydrated(ref)` (`packages/exchange/src/settle.ts:208`) takes a ref, and a replicate document has none. The only lever is `exchange.flush()`, which is process-wide and named for draining writes. A caller told "this document is still loading" has no precise way to wait for it.

# Success Criteria

1. `exchange.get(docId, bound)` on a hydrated, compatible replicate document returns a `Ref<S>` over the **same accumulated state**, not a fresh empty one.
2. Promotion consults `mismatchForInterpretation` first and refuses an incompatible request, naming the axis.
3. Promotion refuses while the document is still hydrating, and the refusal names how to wait.
4. After promotion, `exchange.documents.get(docId)?.mode` is `"interpret"`, and a `doc-promoted` event fires.
5. The sync model records the document's new mode and its `supportedHashes`, and re-announces so peers learn the fuller schema range.
6. A standalone `Runtime` (no Exchange, no network) promotes on the same terms.
7. Suspension survives promotion: a suspended replicate document promotes and stays suspended.
8. `whenHydrated` can be asked about a document that has no ref.
9. `packages/exchange/TECHNICAL.md` describes promotion, including that it is one-way and why a blanket sweep must never trigger it.
10. Full `pnpm verify` passes after every phase.

Each phase below is one commit, landing in order, each independently green. The summary line to use is given with the phase.

# ✅ Phase 1: Await a ref-less document's hydration

> `feat(exchange): ask whether a document has finished loading, by docId`

Independent of the rest, and needed by Phase 3's refusal message so the error can name a real API.

- ✅ Task 1.1: Add a docId-keyed hydration accessor to `Runtime`, and delegate to it from `Exchange`:

  ```ts
  /** Has this document finished loading from storage? */
  hydrated(docId: DocId): boolean
  /** Resolve once it has; reject if the load failed. */
  whenHydrated(docId: DocId): Promise<void>
  ```

  On `Runtime` because that is where hydration lives — `#hydrate`, the pending-hydration tracking, and the `HydrationLatch` on every `DocCacheEntry` (`runtime.ts:150`) are all Runtime state, so this exposes what is already tracked rather than tracking something new. On `Exchange` by delegation, which is how every other document-keyed operation reaches the Runtime: `has`, `destroy`, `suspend`, `flush`.

  Both surfaces are needed, for different callers. A standalone-`Runtime` user is precisely who cannot fall back on the ref-keyed `whenHydrated(ref)` from `settle.ts:208`, since a replicate document has no ref to key on. An `Exchange` user should not have to reach through to a `Runtime` they may never have constructed.

  Sharing the names with `settle.ts`'s free functions is deliberate rather than a collision: one is a method taking a `DocId`, the other a module export taking a ref, and the parameter says which surface you are on. An unknown document reports hydrated — there is nothing to load, matching how `hydrated(ref)` treats a document with no store.

- ✅ Task 1.2: Tests — see §Tests.

# ✅ Phase 2: The decision

> `refactor(exchange): planInterpretation decides the replicate phase`

Pure. Nothing calls the new arm until Phase 3.

- ✅ Task 2.1: Extend `planInterpretation` (`packages/exchange/src/interpret.ts:58`) so the `replicate` phase is decided rather than rejected outright.

  ```ts
  export type InterpretAction =
    | { action: "return-cached" }
    | { action: "create" }
    | { action: "promote"; from: "deferred" | "replicate" }
    | { action: "refuse"; kind: "mismatch"; mismatch: MetadataMismatch }
    | { action: "refuse"; kind: "not-hydrated" }

  export function planInterpretation(input: {
    phase: DocPhase
    reader: ReadCapability
    doc: DocMetadata | undefined
    /** Whether the document's stored state has finished loading. */
    hydrated: boolean
  }): InterpretAction
  ```

  The `replicate` arm becomes: refuse `not-hydrated` if the document is still loading; otherwise apply `mismatchForInterpretation` exactly as the `deferred` arm does; otherwise `promote`.

  **Remove the `"unsupported"` refusal kind** (`:39` and `:79`). It exists to say "this transition is coherent but not built"; once it is built there is nothing for it to describe, and leaving it would invite a reader to think some replicate documents are still categorically refused. Every remaining refusal is either an irreconcilable request or a document that is not ready yet.

  `hydrated` is a new input and deserves the same scrutiny as the parameters this function deliberately lacks. It qualifies: it is a fact about the *document*, not about the caller — the same test that keeps `intent` and `sameBound` out. Document its presence alongside the notes on their absence, so the boundary stays legible.

  For a `deferred` document `hydrated` is irrelevant (there is nothing loaded to preserve) and for `absent` there is nothing to load; the arm ignores it in both cases. Say so, or the next reader will wonder whether those arms have a bug.

  **Both shells consult this, and they can see different amounts.** The `Runtime` owns the document cache, so for `absent`, `interpret` and `replicate` it can supply every input itself — a replicate entry's `readyInfo` carries `replicaFactory`, `syncMode` and `schemaHash` locally, and the hydration latch is on the entry. Only `deferred` needs metadata the Runtime does not hold, because a deferred document exists solely as a sync-graph fact and its description comes from `synchronizer.getDocMetadata`. That is the one phase the `Exchange` adds. Splitting it this way is what lets a local-first application promote without an `Exchange` in the picture at all.

- ✅ Task 2.2: Tests in `packages/exchange/src/__tests__/interpret.test.ts` — see §Tests.

# ✅ Phase 3: The Runtime upgrade

> `feat(exchange)!: get() promotes a replicate document when given its schema`

- ✅ Task 3.1: In `Runtime.createInterpretDoc` (`runtime.ts:863`), replace the replicate throw at `:884` with a promotion path.

  `createInterpretDoc` already selects a `{ substrate, adopt }` pair before doing anything else, and the two existing arms differ only in when the peer's identity is claimed. Promotion is a **third arm of that same selection**, not a parallel path:

  ```ts
  const { substrate, adopt } = promoting
    ? { substrate: factory.upgrade(existing.readyInfo.replica, bound.schema), adopt: NO_ADOPT }
    : willHydrate
      ? beginHydration(factory, bound.schema)
      : { substrate: factory.create(bound.schema), adopt: NO_ADOPT }
  ```

  Everything downstream — ref construction, `readyInfo`, settle-term registration, cache insertion, `#register` — stays shared, or it drifts from the ordinary path the first time either changes.

  **All three arms end with the identity claimed; they differ in when, and each is right for what it can guarantee.** `beginHydration` defers, because a document about to import its own history must not write to addresses that history occupies. `create` claims immediately, because nothing will be imported. `upgrade` claims immediately, because the import has already happened — that is the two-phase contract `bind-loro.ts:127` describes. Do not make `upgrade` defer to match `beginHydration`: that would break the only path in the tree that has always had this ordering right.

  Three further requirements for the promotion arm:

  - **`willHydrate` is false.** The replica has already loaded — that is the precondition — and the upgraded substrate wraps the same backing document. Construct the new entry's latch already `loaded`, and do not re-run `#hydrate`.
  - **No `adopt` call.** The hydration continuation is where the Runtime claims identity for a newly created document, and a promoted document never enters it. `upgrade()` has already claimed. Nothing further is needed and nothing further should be added.
  - **Carry `suspended` from the old entry onto the new one.** A suspended document that gets promoted is still suspended: promotion is about which tier holds the document, suspension is about sync-graph membership. Conflating them would let a `get()` silently re-enter the sync graph, which is precisely the property `get()` does not have.

  Note that a **transient** replicate document never registers with a store (`#usesStores`), so its latch is `loaded` from creation and the hydration precondition is satisfied immediately. The precondition is not unreachable for ephemeral relays; it is trivially met.

- ✅ Task 3.2: Have `Runtime.get` (`runtime.ts:451`) consult `planInterpretation` for the phases the Runtime can see, and act on the result before delegating to `createInterpretDoc`.

  This is what makes Success Criterion 6 true rather than aspirational. `createInterpretDoc` is the shared path both shells reach, so putting the *decision* only in the Exchange would leave a standalone `Runtime` performing an upgrade it never checked — no compatibility comparison, no hydration precondition. The Runtime supplies `phase`, `reader`, `doc` and `hydrated` from its own cache entry; it never sees a `deferred` document, so it passes what it has and that arm is unreachable from here.

- ✅ Task 3.3: Route `#getImpl` (`exchange.ts:759`) through the same classifier, adding the one input the Runtime cannot supply: a `deferred` document's metadata, from `synchronizer.getDocMetadata`.

  On `promote` from `"replicate"` it calls the same `#interpretDoc` path as every other promotion; on `refuse / "not-hydrated"` it throws an error naming `whenHydrated(docId)` from Phase 1. The Runtime's own check still runs underneath — harmless, because the classifier is pure and both shells pass the same facts for the phases they share.

  **Scope the local-schema-authoritative override (`exchange.ts:837`) to `deferred` documents.** Guard it on the phase, not just the axis.

  The reason is what is at stake, not where the document came from — both phases can be reached from a peer's announcement, since `onEnsureDoc` creates a replicate document whenever an application's `resolve` callback returns `Replicate()` (`exchange.ts:510`). The difference is that a deferred document holds *nothing*: overriding a schema-hash disagreement there materialises an empty document under the local schema, and refusing instead would let any peer break a local `get()` by announcing a colliding `docId`. A replicate document holds **accumulated state**. Overriding there means reinterpreting real bytes, written under a shape this schema does not claim to read, and a wrong answer is silent. Refuse it like any other axis.

- ✅ Task 3.4: Tests — see §Tests.

# ✅ Phase 4: Making the transition visible

> `fix(exchange): a mode change refreshes exchange.documents and re-announces`

Without this, promotion works inside the Runtime and is invisible to everything watching the Exchange.

- ✅ Task 4.1: `Synchronizer.registerDoc` (`synchronizer.ts:738`) — emit `doc-promoted` when a document already known to `#docRuntimes` re-registers under a different mode.

  Widen the existing check rather than adding a parallel one. Today it asks "was the previous model entry deferred?"; it should ask "did the mode change?", which covers deferred → interpret identically and replicate → interpret newly. Comment that `#emitDocEvents` (`:1650`) rebuilds every `DocInfo` from `#docRuntimes` but returns early on an empty event list — that is why an unemitted event is not a cosmetic loss but the difference between `exchange.documents` reflecting reality and not.

- ✅ Task 4.2: `handleDocEnsure` (`sync-program.ts:860`) — accept a mode change on an existing non-deferred entry instead of returning the model unchanged.

  The early return exists to make `doc-ensure` idempotent, which it must stay: the same document ensured twice at the same mode should not re-announce. Narrow the condition to "exists **and** the mode is unchanged" rather than "exists and is not deferred". A genuine mode change then falls through to the normal path, which rewrites the entry, records `supportedHashes`, and sends `present` + `interest`.

  Re-announcing is correct and worth a comment. The document's triple does not change — compatibility was a precondition — but an interpreted document advertises `supportedHashes`, and a replicate one has none. Peers that could not previously match this document against a migrated schema of their own can do so after the announcement.

- ✅ Task 4.3: Tests — see §Tests.

# ✅ Phase 5: Documentation

> `docs(exchange,schema): promotion, and why only a named call triggers it`

- ✅ Task 5.1: `packages/exchange/TECHNICAL.md` §"`exchange.get` — phase in, action out" — update the phase table: `replicate` now promotes rather than being refused, and the paragraph naming it "the one phase still refused" goes.

  State the three preconditions together, since they are the whole contract: the caller supplies a schema, the schema is compatible on all three axes, and the document has finished loading. Then state the cost plainly — promotion is one-way, there is no `demote()`, and a peer that promotes a document it was only relaying keeps the full substrate for the rest of the process.

- ✅ Task 5.2: `packages/exchange/TECHNICAL.md` — in the same section, record why no *blanket* path promotes.

  `registerSchema`'s deferred sweep (`exchange.ts:1106`) and the `onEnsureDoc` network route both raise documents to interpret without a caller naming one. Neither may promote a replicate document: registering one schema would otherwise convert every matching replicate document at once, and a relay that registered a schema to read *one* document would silently acquire full substrates for all of them. Promotion is a named act — the caller supplied both a `docId` and a `BoundSchema` — and that distinction is the safety property.

  The sweep's own comment already refuses to widen to replicate for this reason; cross-reference it rather than restating the argument.

- ✅ Task 5.3: `packages/exchange/TECHNICAL.md` §Vocabulary — the **Phase** row currently implies the tiers are a fixed classification. Note that `interpret` is reachable from both other phases, and that the reverse is not.

- ✅ Task 5.4: `packages/schema/TECHNICAL.md` — `SubstrateFactory.upgrade` is documented as an internal two-phase construction step. Record that it is now also the mechanism behind a public transition, and that the identity-after-hydration ordering its backends observe is what makes the hydration precondition in `@kyneta/exchange` necessary rather than cautious.

- ✅ Task 5.5: No README changes. `get()`'s signature is unchanged, and every previously-working call behaves identically.

# Tests

**Phase 1 — the hydration accessor** (`packages/exchange/src/__tests__/runtime.test.ts`)

- ✅ An unknown document reports hydrated; `whenHydrated(docId)` resolves immediately. This is the "nothing to load" case and it is what stops callers writing defensive existence checks.
- ✅ A replicate document created with a store reports not-hydrated, then hydrated, and `whenHydrated(docId)` resolves. Use `createInMemoryStore` — already imported in this file.

**Phase 2 — the decision table** (`packages/exchange/src/__tests__/interpret.test.ts`)

Extend the existing table rather than starting a new file; these are rows in the same truth table.

- ✅ `replicate` + hydrated + compatible → `promote` from `"replicate"`.
- ✅ `replicate` + not hydrated → `refuse / "not-hydrated"`, *even when compatible*. Ordering matters: a caller should be told to wait rather than told their schema is wrong.
- ✅ `replicate` + hydrated + each axis mismatched → `refuse / "mismatch"` naming that axis.

**Phase 3 — state actually survives** (`runtime.test.ts`, `exchange.test.ts`, `integration.test.ts`)

- ✅ **The load-bearing test.** Register a document in replicate mode, merge a payload carrying known content into its replica, then `get()` it and read a field through the returned ref. The assertion is on the *content*, not on the entry's mode — a promotion that produced a fresh empty substrate would still report `mode: "interpret"` and pass any structural check. This is the test that distinguishes promotion from the data loss it replaces.
- ✅ **The same thing over a transport**, by rewriting `integration.test.ts:1306`. That test already builds the topology this feature exists for: Alice interprets `app-doc` and relays `relay-doc`, Bob receives both, and the assertion is that Bob cannot read the relayed one. Invert it — Bob supplies `LoroDoc` and reads the content Alice wrote. Nothing else in the suite exercises promotion end to end across a real transport, and the state that must survive arrived over the wire rather than being merged in by the test.
- ✅ A suspended replicate document promotes and remains suspended.
- ✅ `get()` on a still-hydrating replicate document throws, and the message names `whenHydrated`.
- ✅ Promotion on a standalone `Runtime`, with no Exchange and no transports.

**Phase 4 — the transition is visible** (`exchange.test.ts`)

- ✅ After promotion, `exchange.documents.get(docId)?.mode` is `"interpret"` and a `doc-promoted` event was delivered to a `documents` subscriber. Assert both: the map is rebuilt only when an event fires, so a missing event and a stale map are the same defect seen from two sides.
- ✅ Two peers over a `Bridge`: the promoting peer re-announces, and the remote peer's view of the document reflects the newly advertised `supportedHashes`. Reuse the migrated-schema fixtures (`Migration.rename`) already in this file.
- ✅ Ensuring the same document twice at an unchanged mode does not re-announce — the idempotence the narrowed condition in Task 4.2 must preserve.

**Regression watch.** Three existing tests assert the behaviour this plan reverses. All three are rewritten to assert promotion rather than deleted:

| Test | Drives |
| --- | --- |
| `exchange.test.ts:925` | `exchange.get()` on a replicate document |
| `runtime.test.ts:360` | `runtime.get()` on one, with no Exchange |
| `integration.test.ts:1306` | a relayed document over a transport — rewritten as the Phase 3 case above |

Those are the only existing tests that should need editing. Anything else needing changes is a signal the change reached further than intended.

# Transitive Effect Analysis [scratch]

**`onEnsureDoc` and `registerSchema`'s sweep must keep refusing.** Both raise documents to interpret without a caller naming one. Phase 2 widens the shared classifier, so both would inherit promotion unless their call sites keep it out. The classifier is the right place for the *decision* and the wrong place for this restriction — it has no caller-identity parameter, deliberately. Both routes therefore continue to pass only the phases they handle, and Task 5.2 records why.

**`@kyneta/index` is already guarded.** `Source.fromExchange` calls `get()` on every document whose schema matches, on its construction scan, its subscription, and its handle. All three route through one predicate, `isTrackable`, whose `mode !== "interpret"` clause keeps `get()` away from a replicate document entirely. A conservation test asserts no document leaves `replicate` across a full mixed sequence, written to survive this change. Nothing in `@kyneta/index` needs to change, and that is a property to re-check rather than assume if this plan's tests ever fail there.

**Suspension.** `#getImpl` does not inspect suspension, so a suspended replicate document reaches the classifier like any other. Task 3.1 carries the flag onto the new entry. Without that, promotion would silently re-enter the sync graph — the exact property `get()` does not have.

**Storage.** The promoted substrate wraps the same backing document, so the store's view of the document is unchanged and no re-persist is needed. `StoreMeta` is `replicaType` + `syncMode` + `schemaHash`, none of which change across a promotion — compatibility on all three is the precondition. Nothing in `store-program.ts` needs to know a promotion happened.

**A transient replicate document is never registered with the store-program.** `#usesStores` keeps it out in both directions, so it has no store-program phase and its hydration latch is `loaded` from creation. Promotion's hydration precondition is therefore satisfied immediately for ephemeral relays rather than being unreachable.

**Peers.** `present` carries `replicaType`, `syncMode`, `schemaHash` and optionally `supportedHashes` — **not** the sender's tier. A remote peer therefore cannot observe another peer's mode at all, and promotion changes nothing it can see except the appearance of `supportedHashes`. That is why re-announcing (Task 4.2) is additive rather than a protocol event, and why no wire change is needed.

**`@kyneta/devtools`.** Consumes `DocInfo` through the observation bus and renders `mode`. It gains a transition it has not seen before, but `doc-promoted` is an existing `DocChange` member and `classify.ts` handles the open set by treating everything except `doc-removed` as a set. No change needed.

**`@kyneta/react`.** `useDocument` calls `get()` in a `useMemo`. A promotion triggered from a component is possible and behaves like any other `get()`: it returns a ref. Nothing to change, though it is worth knowing that a React component *can* now trigger a one-way tier change.

# Resources for Implementation [scratch]

**Read before starting**

- `packages/exchange/TECHNICAL.md` §"`exchange.get` — phase in, action out", §Vocabulary (the **Phase** row), §"Document classification on `present`".
- `packages/schema/TECHNICAL.md` §"The two laws over `supportedHashes`" — why compatibility is a membership test, and why `mismatchForInterpretation` is the right law for this question rather than the sync one.
- `packages/index/TECHNICAL.md` §"subscription discipline" — the tier law that keeps `@kyneta/index` from triggering promotion, and the reason this plan needs no change there.
- `packages/exchange/PRODUCT.md` — the relay-plus-inspector topology is the deployment where a peer both replicates and reads, and therefore the one this transition is for.

**The specific code**

- `packages/exchange/src/interpret.ts:31` (`DocPhase`), `:39` (`InterpretAction`, including the `"unsupported"` kind to remove), `:58` (`planInterpretation`), `:79` (the replicate arm).
- `packages/exchange/src/runtime.ts:451` (`get`), `:863` (`createInterpretDoc`, with the replicate throw at `:884` and the `{ substrate, adopt }` selection just below), `:1012` (`#createReplicateDoc` — what a replicate entry holds), `:1140` (`#register`), `:150` (`DocCacheEntry` and its hydration latch).
- `packages/exchange/src/exchange.ts:759` (`#getImpl`), `:811` (the replicate throw), `:837` (the local-authoritative override to scope), `:510` (`onEnsureDoc`'s `Replicate()` route), `:1106` (`registerSchema`'s deferred sweep and its comment on not widening to replicate).
- `packages/exchange/src/synchronizer.ts:738` (`registerDoc` and its event logic), `:1650` (`#emitDocEvents`).
- `packages/exchange/src/sync-program.ts:860` (`handleDocEnsure` and its early return).
- `packages/exchange/src/settle.ts:208` (`whenHydrated` — the ref-keyed pair the Phase 1 accessors sit beside).
- `packages/schema/src/substrate.ts:1147` (`SubstrateFactory.upgrade` and its contract), and `createForHydration` in the same file — the identity-claiming rule that makes the hydration precondition necessary.
- `packages/schema/backends/loro/src/bind-loro.ts:118` and `:127` — the identity-after-hydration ordering, stated at both ends of the two-phase construction.

# Alternatives Considered

**Promote without waiting for hydration.** Simpler, and removes both the fourth refusal kind and all of Phase 1. Rejected: `upgrade()` sets the peer's stable identity on the backing document, and the backends hydrate under a throwaway identity precisely so that switch can happen once, at the end. Upgrading mid-load interleaves the switch with the remaining imports. The two-phase design's own contract says to do it the other way, and a corruption that only appears under a store plus a race is the worst kind to trade away a refusal for.

**Let the promotion await hydration internally and return a promise.** Would remove the refusal entirely. Rejected: `get()` is synchronous by design across every other phase, and every caller — `useDocument`'s `useMemo` among them — depends on that. Making one phase async would change the signature for all of them.

**Promote from the blanket paths too, so all three doors behave alike.** Rejected. `registerSchema`'s sweep would convert every matching replicate document the moment one schema is registered; a relay registering a schema to read one document would acquire full substrates for all of them, one-way. The asymmetry is the safety property: a named `docId` plus a `BoundSchema` is a deliberate act, and a sweep is not.

**Keep `refuse / "unsupported"` alongside the new arm.** Rejected. It describes a transition that is coherent but unimplemented; once implemented, nothing is left in that category, and a reader finding it would reasonably infer that some replicate documents remain categorically refused. Removing it keeps the refusal kinds exhaustive and meaningful.

**Make `upgrade()` defer identity like `beginHydration` does, so all construction paths match.** Rejected. The two do different jobs: `beginHydration` serves a substrate that is *about to* import its own history and must not write into it, while `upgrade` serves one whose import has already finished. Deferring in `upgrade` would leave the identity unclaimed with nothing left to trigger the claim, and would break the two-phase construction every backend defines `create` in terms of.

**Add `demote()` so promotion stops being one-way.** Out of scope, and probably not wanted. Demotion would have to discard the interpreter stack while keeping the replica, invalidating any `Ref<S>` already handed out — a use-after-free in a language with no way to enforce it. The one-way property is a real cost, but it is a cost paid at a call site the caller chose, and the safer answer to "I did not want a substrate here" is not to have called `get()`.
