feat(exchange,react): layered document readiness — docStatus + initialize over changefeed settle terms

# Background

Two correct primitives each answer half of "is this document ready?". They live in different packages, and nothing composes them.

**Content** — `@kyneta/schema` exposes `isPopulated(ref)` / `populated(ref)` (`src/interpreters/with-changefeed.ts`). A monotonic per-path boolean that flips when any mutation touches that ref or a descendant. It fires for local writes, remote sync imports, **and** store-hydration replays — verified and pinned by the three tests in `packages/exchange/src/__tests__/store-hydration.test.ts` (describe block "isPopulated through storage hydration").

**Network** — `@kyneta/exchange` exposes `sync(doc).ready`, `.readyFor(pred)`, `.settled(opts)`, `.waitForSync(opts)`, `.connectivity`, `.peerStates` (`src/sync.ts`). See `packages/exchange/TECHNICAL.md` §"Ready state — two folds of one transition" and §"Connectivity & settling".

**Storage** — the `Runtime` (`src/runtime.ts`) owns per-document hydration (`#hydrate`, `#pendingHydrations`, `#trackHydration`, `onDocReady`). It exposes no per-document completion signal. The only application-facing gate is `exchange.flush()`, which is named for draining writes and happens to await hydration as an implementation detail.

## Why the split exists

Commit `jj:rpuqvkyy` ("refactor: remove seed from substrate API, add isPopulated reactive boolean to refs") removed a `seed` parameter from `SubstrateFactory.create` and `Exchange.get`. Three reasons, all still valid: seed values did not produce operations (so divergent seeds could never merge), symmetric discover caused mutual overwrite in hub-and-spoke, and the concept did not generalise across substrates.

That commit replaced `seed` with a deliberate **two-part** design:

1. _Authoritative initial content_ — apply via real operations after construction.
2. _UI defaults while loading_ — a predicate, `isPopulated`.

Part 2 shipped. **Part 1 shipped as unwritten convention** — no API, no example, no test, no documentation. Every problem below descends from that asymmetry.

A related commit, `jj:mltppspx` ("fix: remove namespace pollution from ref objects"), moved this metadata off string keys onto the `[POPULATED]` / `[DELETED]` symbols so a user schema with a field named `isPopulated` is not shadowed. Read it through the free functions; there is no `.isPopulated` property. The guard is `packages/schema/src/__tests__/pollution.test.ts`.

## The deployment layers

A document exists at one of four layers, and each adds exactly one truth source:

| Layer | Construction | Adds |
| --- | --- | --- |
| Ref | `doc.field` | — (inherits the document's) |
| Document | `createDoc(bound)` | — nothing to await |
| + Runtime | `runtime.get(...)` with stores | local store hydration |
| + Exchange | `exchange.get(...)` with transports | peer reconciliation |

`Runtime` was extracted as the local imperative shell (stores, clock, lease) and knows nothing about the network; `Exchange` wires `Runtime` hooks into the `Synchronizer`. The architecture is already layered. The readiness API never followed it.

# Problem Statement

`isPopulated(doc) === false` has two meanings that are indistinguishable at the call site: _settled and genuinely empty_ (safe to write defaults) and _not settled yet, so of course it looks empty_ (writing defaults destroys data). This single ambiguity produces every symptom below.

1. **Silent data loss.** A restarted authoritative peer that writes defaults when `isPopulated` is `false` overwrites its own store, because hydration is asynchronous. Reproduced in `store-hydration.test.ts` ("reads false while hydration is pending, though the store has data").

2. **No initialization API.** Applications must hand-compose a settle gate with an emptiness check. The order is load-bearing and the naive composition is racy: two empty clients that reconcile with _each other_ both latch ready, both observe empty, and both seed. This is the same mutual-overwrite hazard `jj:rpuqvkyy` removed `seed` for, resurfacing one layer up.

3. **Transportless exchanges never become ready.** `deriveConnectivity` classifies `transportCount === 0` as `offline`. Only `settled()` honours that (`src/sync.ts:154`). `ready`, `readyFor`, and `waitForSync` do not: `ready` is `false` forever and `waitForSync` hangs until it throws. `useDocReady` inherits this, so a local-only React application shows a permanent spinner.

4. **No per-document hydration gate.** `exchange.flush()` is process-wide and named for writes.

5. **Authority has no home.** Whether a peer is authoritative for a document is a property of the _deployment topology_, fixed at process start — yet there is nowhere to declare it. `useDocReady(doc, { peer })` accepts a predicate per call; the promise form `settled({ offlineAfter })` accepts none at all.

6. **Overlapping surface.** `waitForSync` and `settled` are two generations of one idea. `useDocReady` — the hook the codebase steers users toward — has zero real callers and zero tests, while both shipped examples use the `useSyncState` escape hatch its own source comment discourages.

# Success Criteria

1. `docStatus(node)` returns `"pending" | "empty" | "populated"` and works unchanged at every layer: standalone `createDoc`, Runtime-with-stores, and full Exchange. It never throws, regardless of layer.
2. A standalone document and a transportless, storeless Exchange both report `empty` immediately — never `pending`.
3. `"empty"` is only observable once **every** attached truth source has reported. Pending hydration or an unheard authority yields `"pending"`. A timeout never produces `"empty"`: giving up on a remote authority is reported as `waitOutcome: "offline"` and decided on separately, so `docStatus` never claims evidence it does not have.
4. A failed store read leaves the document `"pending"` and surfaces the error through `whenSettled`, rather than hanging silently or reporting `"empty"`. `offlineAfter` never applies to hydration.
5. Settle terms carry `[CHANGEFEED]`, so `hydratedFeed(doc)` has the same shape as `populatedFeed(ref)` and composes with `useChangefeed`, `@kyneta/reactive`, and `@kyneta/index` without new plumbing.
6. Every readiness accessor this plan adds ships as an `x` / `xFeed` pair at its final intended name, so nothing added here needs renaming in 3.0.
7. `initialize(doc, seedFn, opts?)` writes defaults exactly once, only when the document is genuinely empty, and returns `"created" | "loaded"`.
8. `initialize(doc, seedFn)` with **no options** is correct for a CRDT document in a hub-and-spoke topology, and for an authoritative document once the authoritative peer declares `authority: "self"` once at construction.
9. `initialize` refuses to seed a `writerModel: "serialized"` document from a non-authoritative peer, with an error naming the fix.
10. Concurrent `initialize` calls for one document produce exactly one seed write.
11. Two peers concurrently initialising the same CRDT document with an LWW-only seed converge to the same result as a single-peer seed.
12. `hydrated(doc)` reports per-document hydration completion; `exchange.flush()` is no longer needed as a hydration gate.
13. `sync(doc).ready` is `true` on a transportless exchange. `readyFor(pred)` stays strict and is never vacuously true.
14. `whenSettled(doc, { peer })` awaits the full conjunction — every attached term, not just the peer one.
15. `useDocStatus` / `useInitialize` expose the above to React without flicker, built on `useChangefeed` rather than a new store core.
16. The decision logic in `deriveDocStatus`, `derivePeerSettled`, and `planInitialization` is pure and table-testable with no Exchange, store, or transport.
17. `waitForSync` and `sync(doc).settled()` are deprecated with runtime warnings and superseded by `whenSettled`; no internal caller of either remains. `populatedFeed` / `deletedFeed` ship as aliases so the carrier side of the naming is uniform.
18. Full `pnpm verify` passes.

# Landing this change

Each phase below is **one jj revision**, meant to be read as a stack: every revision teaches one idea, compiles on its own, and leaves `pnpm verify` green. Do not batch phases into a single commit — the value here is that a reviewer can follow the argument one layer at a time, and that a bisect lands on a specific idea rather than on "the readiness change".

Three properties of the ordering are deliberate:

- **Phase 1 comes first because everything after it depends on the names.** It is pure groundwork with no behaviour change. Landing it late would mean writing `populated(...)` everywhere and rewriting it afterwards — and would leave Phase 6 unable to compile, since `docStatusFeed` is built from `populatedFeed`.
- **Phases 2, 3 and 5 build machinery that nothing consumes yet.** The first public API lands in Phase 6. That is intentional: no user-visible behaviour changes while the mechanism is half-built, so each of those revisions can be reviewed purely on its own terms.
- **Phase 4 is the only change to how existing code behaves**, so it stands alone. That makes it reviewable in isolation, bisectable, and quotable directly in the release notes. Before making the change, grep for tests asserting `ready === false` on a transportless exchange so the revision either updates them deliberately or confirms there are none.

Phase 11 is last because migrating the examples is the first time this API is used by something that is not a test — the real check on whether it is usable.

# ✅ Phase 1: Name the carriers (`@kyneta/schema`)

Groundwork. Additive, no behaviour change, no dependencies — and everything after it uses the names it introduces.

- ✅ Task 1.1: Add `populatedFeed(ref)` and `deletedFeed(ref)` as additive aliases of the current `populated(ref)` / `deleted(ref)` carriers, and mark the bare spellings `@deprecated` pointing at them. Migrate all internal usage, tests, and documentation to the `*Feed` names.

  This buys the thing that makes the new naming safe to ship now: the **carrier side becomes uniform immediately** — `populatedFeed`, `deletedFeed`, `settledFeed`, `hydratedFeed`, `docStatusFeed`. The remaining inconsistency is confined to the boolean side, where `isPopulated` / `isDeleted` sit beside `settled` / `hydrated` until 3.0 renames them (`next.md` §10).

  Do **not** change what `populated` / `deleted` return here. Their return type flips from carrier to boolean in 3.0; deprecating the spelling now means that flip is a removal plus a rename, not a silent semantic change to a live name.

# ✅ Phase 2: Settle terms and the storage term

The one idea: **settledness is a conjunction over the truth sources attached to a document.** Each deployment layer registers one term. Zero terms is the empty conjunction, which is `true` — so a standalone document is settled by construction, and the transportless case stops being a special case rather than needing one.

A settle term is **a `[CHANGEFEED]` carrier**, not a new interface. `packages/changefeed/TECHNICAL.md` states the constraint plainly: _"The universal reactive contract — a single symbol (`CHANGEFEED`) that any value can carry to expose its current state and a stream of future changes. Every reactive surface in Kyneta goes through this one symbol."_ `populatedFeed(ref)` is already `(() => boolean) & HasChangefeed<boolean>`; a settle term is the same shape, so it is learnable by analogy and composes with everything that already speaks the protocol.

Registration mirrors the existing `registerSync` / `syncRefMap` pattern in `src/sync.ts`: a module-scoped `WeakMap` keyed on the document ref. No change to `@kyneta/schema` is required beyond Phase 1, because both attaching layers (`Runtime`, `Exchange`) live in `@kyneta/exchange`.

- ✅ Task 2.1: Create `packages/exchange/src/settle.ts` — the registry plus one combinator.

  ```ts
  /** A settle term is any boolean changefeed: `.current` is "has my source reported?" */
  export type SettleTerm = (() => boolean) & HasChangefeed<boolean>;

  /** @internal Called by Runtime / Exchange as a document is created. */
  export function registerSettleTerm(ref: object, term: SettleTerm): void;

  /** Conjunction over attached terms. No terms ⇒ `true` (vacuously settled). */
  export function settled(ref: object): boolean;

  /** The same conjunction, as an observable carrier. */
  export function settledFeed(ref: object): SettleTerm;
  ```

  **Naming rule for everything this plan adds:** the short name is the plain value; `xFeed` is the `[CHANGEFEED]` carrier. Reading "has this settled?" is routine, so it gets the short name; subscribing to the transition is the specialist move, so it pays the suffix.

  This is the reverse of the shipped `isPopulated` / `populated` and `isDeleted` / `deleted` pairs, where the short name is the carrier. Those are named the wrong way round — a carrier is a callable, so `if (populated(ref))` is **always truthy**, silently reporting the opposite of the truth for an empty document, which is precisely the case this design turns on. Fixing them is a breaking change and is queued for 3.0 (`next.md` §10). New API is named at that target now rather than shipping names we have already decided to rename; Phase 1 shrinks the resulting inconsistency window.

  Build the carriers with `createCallable` / `createChangefeed` from `@kyneta/changefeed`; do not hand-roll the protocol.

  Export `SettleTerm`, `settled`, and `settledFeed` from the `@kyneta/exchange` barrel in this phase. Each phase exports what it creates, so every revision in the stack is complete on its own rather than leaving unreachable code for a later barrel-update task.

  Keep the `allOf(terms): SettleTerm` combinator **local to this file** for now. `@kyneta/changefeed` has no combinators today, and adding public API to a foundational package on speculation is a bigger commitment than this plan needs. Promote it later if a second consumer appears.

- ✅ Task 2.2: Add a per-document hydration latch to `Runtime` (`packages/exchange/src/runtime.ts`). `#createInterpretDoc` and `#createReplicateDoc` already branch on `this.#stores.length > 0`; the no-stores branch resolves the latch immediately, and the hydrating branch resolves it in the existing `#hydrate(...).then(...)` continuation alongside `#register(entry)`. Store the latch on `DocCacheEntry` so it follows entry lifetime through `compact()` / `reset()` / `shutdown()` automatically.

  **Give the latch three states, not two: pending, loaded, and failed.** (Corrected during implementation: the plan assumed `#hydrate` rejects on a store failure. It does not — its per-store `catch` `console.warn`s and continues, so a total read failure silently produced an *empty, announced* document. That is the very failure this layer exists to prevent, already live in the codebase. `#hydrate` now rethrows when no store answered and at least one threw; one store failing while another answers is still a legitimate first-hit fallback.) With that fixed, a rejected `#hydrate` skips the `.then(#register)` continuation, so `onDocReady` never fires and the document never joins the sync graph. Under this design its hydration term would simply never report, leaving the document at `"pending"` for ever with nothing said about why. That fails in the safe direction — it never writes defaults over data it could not read — but an invisible hang is a poor diagnostic. Record the failure on the entry and surface it: `whenSettled` (Phase 5) must reject with the underlying store error rather than hang.

  Note that `#trackHydration` (`runtime.ts:910`) attaches `.finally()`, which runs cleanup but does not handle the rejection. That is pre-existing, but this change makes it load-bearing, so handle it here.

- ✅ Task 2.3: Register the Runtime's term from `createInterpretDoc`. It must **not** regress across `suspend()` / `resume()` — the sync latch deliberately survives suspend (`packages/exchange/TECHNICAL.md` §"Ready state"), and a hydration term that regressed would let a naive initializer re-seed a resumed document.

- ✅ Task 2.4: Export `hydrated(doc): boolean` and `hydratedFeed(doc): SettleTerm` from `@kyneta/exchange`. Document that this — not `exchange.flush()` — is the storage gate.

- ✅ Task 2.5: Confirm registration also happens on the deferred→interpret promotion path (`Exchange.#getImpl` deletes the deferred entry and falls through to `#interpretDoc`), so a promoted document is not left termless and therefore wrongly reported settled. Confirm the `replicate()` promotion path too — replicate documents have no ref and so no `docStatus` surface, but verify rather than assume.

# ✅ Phase 3: Authority and the peer term

Completes the conjunction started in Phase 2 by adding its second term, and gives authority the home it currently lacks.

- ✅ Task 3.1: Add `authority` to `Policy` (`packages/exchange/src/governance.ts`), beside the existing peer predicate `canConnect`:

  ```ts
  export type Authority =
    | "self" // I am authoritative — never wait for peers
    | "any" // the first peer to reconcile is good enough
    | ((peer: PeerIdentityDetails) => boolean); // that peer is

  // Policy
  authority?: Authority;
  ```

  Export the `Authority` type from the `@kyneta/exchange` barrel in this phase.

  Authority is a fact about deployment topology, fixed at process start — so it belongs in the per-process, composable policy layer, not threaded through every call site. `Policy` is the registry that already holds exactly this kind of standing judgement about peers. Compose it in `composeGate` following `canConnect`'s precedent, where `undefined` defers to the next policy.

- ✅ Task 3.2: Extract the peer term's rule as a pure classifier, beside `deriveConnectivity` (`synchronizer.ts:357`):

  ```ts
  /** Pure. Has the authority reported, for this authority setting? */
  export function derivePeerSettled(input: {
    authority: Authority;
    hasReconciled: boolean; // any peer reached synced/vacant
    matchesAuthority: boolean; // a peer satisfying the predicate did
    isOffline: boolean; // no transports configured
  }): boolean;
  ```

  - `"self"` → `true` (the local peer is authoritative; do not wait for peers).
  - a predicate → `matchesAuthority`.
  - `"any"` → `hasReconciled`.
  - In every case also `true` when `isOffline` — there are no transports, so there is nothing to wait for.

  This is the third member of the codebase's `derive*` family (`deriveConnectivity`, `deriveTier`, `deriveIdentity`, …) and the reason it is worth extracting rather than inlining: it encodes the authority semantics, it has four inputs and four branches, and getting it wrong means writing defaults over live data. As a pure function it is a truth table testable with no Exchange, no store, and no transport — the same argument that put `deriveDocStatus` and `planInitialization` in their own functions.

- ✅ Task 3.3: Register the Exchange's peer term from `#interpretDoc`, next to the existing `registerSync` call. The term is the thin shell: gather `hasReconciled(docId)`, `reconciledMatching(docId, pred)`, and `connectivity() === "offline"` from the synchronizer, then call `derivePeerSettled`.

- ✅ Task 3.3: Establish the authority resolution order: **call-site option → `Policy.authority` → `"any"`**. The call-site override is what makes runtime leader election expressible (see Task 10.2); a policy-only design would foreclose it.

  Defaulting to `"any"` is correct in hub-and-spoke, the dominant topology, because clients link only to the server — so "any peer" _is_ the authority. The case where a wrong guess would corrupt data is already blocked by the serialized-writer guard in Task 7.2, which is enforced from the schema binding rather than from developer diligence. This is why no "authority is required" error is needed.

# ✅ Phase 4: `ready` on a transportless exchange

The only change in this plan to how existing code behaves. It stands alone so it can be reviewed, bisected, and release-noted on its own.

- ✅ Task 4.1: Fix `SyncRefImpl.ready` (`src/sync.ts`) to return `true` when `connectivity() === "offline"`, matching the carve-out `settled()` already has at `src/sync.ts:154`. **Leave `readyFor(pred)` strict** — it asserts that a _specific_ peer was consulted, so a vacuous `true` would be a lie. Record that asymmetry in a comment.

  Before changing it, grep for existing tests asserting `ready === false` on a transportless exchange, so this revision either updates them deliberately or confirms there are none.

- ✅ Task 4.2: `packages/exchange/TECHNICAL.md:528` documents three deliberately un-unified has-synced predicates. That count is a consequence of `waitForSync` existing: `#isReady` (`synchronizer.ts:1055`) has exactly one caller, `waitUntilReady`, which has exactly one caller, `waitForSync`. When `waitForSync` is removed in 3.0 the chain dies with it and the distinction collapses to two — `hasEverSynced` (compaction-reset detection) and `hasReconciled` (readiness). Do not collapse them in this change; do record the pending collapse where the three are documented.

# ✅ Phase 5: `whenSettled`

- ✅ Task 5.1: Add `whenSettled` — the promise form of the **full conjunction**, and the third member of the free-function family:

  ```ts
  export function whenSettled(
    ref: object,
    opts?: {
      peer?: (peer: PeerIdentityDetails) => boolean;
      offlineAfter?: number;
    },
  ): Promise<{ via: "peer" | "local" | "offline" }>;
  ```

  This must await **every attached term**, not just the peer one. `synchronizer.awaitReconciliation(docId, isReady, timeoutMs)` (`synchronizer.ts:987`) fires on `#peerSyncListeners` — peer-sync changes only, with no knowledge of hydration. Waiting on it alone would let a document with both stores and transports proceed while hydration is still in flight: the server answers, the wait resolves, the store has not loaded, and the document reads empty. That is the exact failure this whole design exists to prevent, so the wait primitive must not reintroduce it. Compose `awaitReconciliation` for the peer term with the Runtime's hydration latch for the store term.

  `via` is unchanged and still describes how the _network_ term resolved: `"local"` when there are no transports, `"peer"` on reconciliation, `"offline"` after `offlineAfter`. Hydration is a precondition, not a provenance.

  **`offlineAfter` applies to the peer term only — never to hydration.** The two look alike (both are waits that might not finish) but they fail for opposite reasons. A missing peer may genuinely never arrive, so giving up is the only option. A slow or failing disk read is a local fault we can observe: timing it out and proceeding would mean writing defaults over data we merely failed to load, which is the exact bug this design exists to prevent, re-entering through the escape hatch.

  **Make that rule structural rather than documented.** Both terms are boolean changefeeds, so express the wait as two sequential steps:

  ```
  await whenTrue(hydratedFeed(ref))                        // no timeout; rejects on store failure
  const via = await whenTrueOr(peerFeed(ref), offlineAfter) // the timeout exists only here
  ```

  Written this way there is nowhere to put a timeout on hydration — the shape prevents it, rather than a comment discouraging it — and the failure ordering is right for free: a store error rejects before the peer wait begins. Sequential rather than parallel costs nothing in practice (hydration is local and fast; the peer wait dominates) and the outcome is identical either way, since both terms are required. Keep the regression test in any case, but it now guards a shape rather than being the only thing standing between the codebase and the bug.

  Export `whenSettled` from the `@kyneta/exchange` barrel in this phase.

  This supersedes `sync(doc).settled(opts)`, which is network-only. Deprecating that method (Task 9.1) is what frees the short name `settled(ref)` for the boolean in Task 2.1 — the collision and the correctness gap have the same fix.

# ✅ Phase 6: `docStatus`

The first public API in the stack. The three-state makes the dangerous state unrepresentable: you cannot observe `empty` before settling, because the type does not offer it.

The gate guards only the **negative** verdict. Content is monotonic and arrives from any source, so `populated` needs no gate. `empty` is a claim about absence, and absence of evidence is not evidence of absence until every source has reported.

The decision gets a pure core and a gathering shell, following `deriveConnectivity` (`synchronizer.ts:357`) and the house `plan*` / `apply*` idiom (`planNotifications`/`deliverNotifications`, `planCacheUpdate`/`applyCacheOps`).

- ✅ Task 6.1: Create `packages/exchange/src/doc-status.ts` with a pure classifier and a shell:

  ```ts
  export type DocStatus = "pending" | "empty" | "populated";

  /** Pure. The whole rule, as a three-row truth table. */
  export function deriveDocStatus(input: {
    populated: boolean;
    settled: boolean;
  }): DocStatus;

  /** Shell: gathers `isPopulated` + `settled`, then classifies. */
  export function docStatus(
    node: object,
    opts?: { authority?: Authority },
  ): DocStatus;
  ```

  Export `DocStatus`, `deriveDocStatus`, and `docStatus` from the `@kyneta/exchange` barrel in this phase; `docStatusFeed` follows in Task 6.2.

  Named `docStatus`, not `status`, to avoid colliding with the existing `describeSyncStatus` / `SyncStatusSummary` in the same package — which also has a `"pending"` member meaning something else. Those describe _connection_ presentation; this describes _data_ readiness. Both keep their jobs.

- ✅ Task 6.2: Export the observable form `docStatusFeed(node, opts?): (() => DocStatus) & HasChangefeed<DocStatus>`, composed from `populatedFeed(node)` (Phase 1) and `settledFeed(node)` (Phase 2). This is what Phase 8 consumes; the plain `docStatus` is its `.current`. `DocStatus` is not a boolean, so a `is*` form never applied — but the `*Feed` half of the naming rule does, which is why the pair reads `docStatus` / `docStatusFeed`.

- ✅ Task 6.3: Support ref-level `docStatus(doc.title)`. Content comes from the ref's own `isPopulated`; settledness is the enclosing document's. This requires resolving a child ref to its document. Investigate `unwrap(ref)` / the `BACKING_DOC` symbol (`packages/schema/src/substrate.ts`) as the identity key — all refs in one document should resolve to the same backing object, which would let the registry key on it rather than on the root ref. If that does not hold, keep the registry keyed on the root ref and scope this release to document-level `docStatus`; ref-level then becomes a follow-up rather than a blocker.

# ✅ Phase 7: `initialize`

Acting on the status. All the policy lives here — the authority rules, the serialized-writer guard, idempotency — so it is reviewed on its own rather than alongside the observation API.

- ✅ Task 7.1: Create `packages/exchange/src/initialize.ts` with a pure decision core:

  ```ts
  export type InitAction =
    | { action: "seed" }
    | { action: "skip" }
    | { action: "reject"; reason: string };

  /** Pure. Every guard lives here, testable with no Exchange, store, or transport. */
  export function planInitialization(input: {
    status: DocStatus; // may still be "pending" — see waitOutcome
    waitOutcome: "peer" | "local" | "offline"; // why the wait ended
    authority: Authority; // already resolved by the shell
    writerModel: WriterModel;
  }): InitAction;
  ```

  `waitOutcome` exists because a timeout must never be laundered into a status. When `whenSettled` gives up after `offlineAfter`, the peer term is still `false` — we genuinely never heard from the authority — so `docStatus` correctly still reads `"pending"`. Without the extra input, this decision has only two bad options: never seed (offline-first stops working, breaking success criterion 8) or seed whenever the status is unknown (the original data-loss bug).

  So the rule is: `status: "pending"` with `waitOutcome: "offline"` may seed — that is an explicit choice to act under uncertainty. `status: "pending"` with any other outcome may not. `docStatus` never claims a document is empty on evidence it does not have; the decision to proceed anyway is carried separately and named honestly.

- ✅ Task 7.2: The serialized-writer guard lives in `planInitialization`. If `writerModel === "serialized"` and `authority` is not `"self"`, return `reject`. Concurrent seeds cannot merge on a serialized-writer document, so this is a topology inconsistency the system can detect rather than a race to lose. The message must name the fix: declare `authority: "self"` on the authoritative peer; do not seed from clients.

- ✅ Task 7.3: Create the shell `initialize(doc, seed, opts?): Promise<"created" | "loaded">`. GATHER (resolve authority; await settledness) → PLAN (`planInitialization`) → EXECUTE (`batch(doc, seed, { origin: "init" })` only on `seed`; throw on `reject`).

  Await settledness through `whenSettled(doc, opts)` (Phase 5) — **not** `awaitReconciliation` directly, which covers only the peer term and would let `initialize` run against an unhydrated store. This is the correctness constraint the whole design turns on, so it is worth stating at the call site as well as at the definition.

  Pass `whenSettled`'s `via` through to `planInitialization` as `waitOutcome`, and re-read `docStatus` after the wait rather than before. The two together are what let the shell distinguish "the authority said there is nothing here" from "the authority never answered and we chose to proceed" — outcomes that produce the same `docStatus` but must not produce the same decision.

  Seeding through `batch` is what makes this safe where the old `seed` parameter was not — the writes are real operations with version history, so concurrent seeds on a CRDT document merge normally.

- ✅ Task 7.4: Idempotency. Cache the in-flight promise per document in a `WeakMap` keyed on the ref, so concurrent or re-entrant calls collapse to one seed write and React strict-mode double-invocation is harmless.

- ✅ Task 7.5: Export `InitAction`, `planInitialization`, and `initialize` from the `@kyneta/exchange` barrel — this phase's own additions only. Everything else this plan adds is exported by the phase that creates it (Tasks 2.1, 2.4, 3.1, 5.1, 6.1, 6.2), so no revision ships code a consumer cannot reach.

# ✅ Phase 8: React bindings

Because settle terms and `docStatusFeed` are `[CHANGEFEED]` carriers, this phase is a thin adapter. `use-changefeed.ts` says it directly: _"The `[CHANGEFEED]` protocol is already the `useSyncExternalStore` contract... no intermediate store factory needed."_ No new store core, and no bespoke dual subscription — the composed feed already watches both settle terms and population.

- ✅ Task 8.1: `packages/react/src/use-doc-status.ts` — `useDocStatus(doc, opts?): DocStatus`, implemented over `useChangefeed(changefeed(docStatusFeed(doc, opts)))`. The snapshot is a scalar, so `Object.is` bail-out gives flicker-free rendering for free.

- ✅ Task 8.2: `packages/react/src/use-initialize.ts` — `useInitialize(doc, seedFn, opts?): DocStatus`. A one-shot effect over `initialize`, returning the live `useDocStatus`. Idempotency comes from Task 7.4, so strict-mode double-mount is safe.

- ✅ Task 8.3: Reimplement `useDocReady` as sugar over `useDocStatus` (`status !== "pending"`), preserving its signature. This gives it its first real test coverage and fixes its transportless permanent-spinner behaviour.

- ✅ Task 8.4: Export both hooks from the `@kyneta/react` barrel.

# ✅ Phase 9: Deprecations

- ✅ Task 9.1: Deprecate `sync(doc).waitForSync()` and `sync(doc).settled()` together, in one wave. Add `@deprecated` on each plus a one-time runtime `console.warn`, migrate every internal caller and test, and remove both in 3.0 — not in a 2.x line. `waitForSync` → `whenSettled(doc)`; `settled(opts)` → `whenSettled(doc, opts)`.

  Deprecating both at once is deliberate. `whenSettled` supersedes each of them, consumers absorb one migration instead of two, and retiring the method is what frees the short name `settled(ref)` for the boolean.

  The capability analysis for `waitForSync`, recorded so the removal is not re-litigated: it uniquely means "wait until a reconciled peer is _currently connected_" (`#isReady` requires a live channel; `hasReconciled` is monotonic and survives departure). That is connection liveness, not data readiness, and it is not worth keeping — the guarantee expires the instant the promise resolves, so nothing can be built on it; it does not confirm that local writes landed, which is what callers usually want and which needs an ack (`Line`); and its distinctive behaviours (hanging transportless, hanging after the reconciled peer departs) are the bugs this plan fixes. Point-in-time liveness remains available and honest via `peerStates.some(s => s.state === "synced")` plus `connectivity === "online"`. Do not add a `{ live: true }` option — that re-conflates the two concerns this change separates.

  `sync(doc).settled()` is superseded for a different reason: it awaits the peer term only, so it is the narrower question. `whenSettled` awaits the full conjunction (Phase 5).

- ✅ Task 9.2: Deprecate `hasSync(ref)`. It exists only to guard `sync()`'s throw; with `docStatus` total, the guard is dead weight.

- ✅ Task 9.3: De-conflate `exchange.flush()`. Leave its behaviour alone — it still drains hydration — but document that `hydrated(doc)` is the storage _gate_ and `flush()` is for draining pending _writes_. Migrate the three tests in `store-hydration.test.ts` to the explicit gate so the intended one is the one under test.

- ✅ Task 9.4: Note that Task 8.3 leaves `createDerivedSyncStore` (`packages/react/src/store.ts`) with no production consumer — `use-doc-ready.ts:46` is its only one, and `use-sync-state.ts` uses `createSyncStore` instead. It is a public barrel export (`react/src/index.ts:25`), so remove it in 3.0 alongside the rest rather than silently orphaning it.

- ✅ Task 9.5: Deprecate `describeSyncStatus` and `SyncStatusSummary` (`packages/exchange/src/describe-sync-status.ts`, 45 lines), with removal in 3.0.

  It has **no consumers**: nothing in `packages/` or `examples/` calls it outside its own definition and two barrel re-exports, and it has no test file. It is a presentational helper whose entire purpose is to be called by application UI, and in the lifetime of the repository nothing has called it. `docStatus` now covers the readiness half of what it summarised, and `peerStates` + `connectivity` remain for the connection half — so a consumer who does want a one-line label can compose it in three lines, which is what the helper was doing anyway.

  Removal touches: the module; `exchange/src/index.ts:13-14`; `react/src/index.ts:88,93`; `react/README.md:210`; `react/TECHNICAL.md:399,550`; `exchange/TECHNICAL.md:7,534,809,830`. Add it to the 3.0 removal list in `next.md` §10 alongside `waitForSync`, `sync(doc).settled()`, `waitUntilReady`, `#isReady`, `hasSync`, and `createDerivedSyncStore`.

  Note the interaction with Phase 4: that phase adds a test pinning `describeSyncStatus`'s behaviour as unchanged when `ready` flips on a transportless exchange. That test stays for the deprecation window — the helper is still shipped in 2.x, so it must not silently change meaning before it is removed — and is deleted with the module in 3.0.

- ✅ Task 9.6: Leave `sync()`, `peerStates`, `useSyncState`, `connectivity`, `Reject()` / `declareVacant`, and the `[POPULATED]` symbol design untouched. They answer genuinely different questions or are load-bearing. `vacant` in particular is what makes "the authority has nothing" _distinguishable_ from "the authority has not answered", which the whole design rests on.

# ✅ Phase 10: Documentation

- ✅ Task 10.1: `packages/exchange/README.md` — add a "Document initialization" section. Lead with `initialize(doc, seed)` in its zero-option form, show the four topologies (standalone, Runtime-only, client with authority, transportless daemon) resolving to the same verb, and show the single `policy: { authority: "self" }` declaration that configures a server. State the rule plainly: whoever is authoritative seeds when empty; everyone else waits and reads.

  **Identify the authority by peer ID, not by role.** The `PeerIdentityDetails.type` field has three values (`"user"`, `"bot"`, `"service"`), so the natural client-side check is `p => p.type === "service"`. That is too loose for anything gating a write: a server is a service, but so is any other service peer on the network — including the multi-peer devtools inspector that `packages/exchange/PRODUCT.md` describes as "itself an Exchange peer". A client using the role check could accept the inspector's reply as the server's verdict. Show `p => p.peerId === "my-server"` as the recommended form and explain why, rather than presenting the role check and leaving the reader to discover the trap.

- ✅ Task 10.2: `packages/exchange/README.md` — add a "Writing a concurrency-safe seed" subsection. Frame it as default guidance, not an edge case: it is good advice regardless of topology, and it makes the concurrent-seed question disappear for most readers rather than becoming a caveat they must reason about.

  Whether concurrent seeding duplicates depends only on which merge law the seed's writes touch, and every schema constructor already declares its law in its type parameter:

  | Constructor | Law | Concurrent identical seeds |
  | --- | --- | --- |
  | `product` / field `set` | `lww-per-key` | converge — safe |
  | `map` (deterministic key) | `lww-per-key` | converge — safe |
  | `set` | `add-wins-per-key` | converge (value-addressed) — safe |
  | `sum` | `lww-tag-replaced` | converge — safe |
  | `sequence` / `movableList` | `positional-ot` | **duplicate** |
  | `counter` | `additive` | **double-count** |
  | `text` | `positional-ot` | **duplicate** |

  A seed of scalars, struct fields, deterministically-keyed map entries, or set members is safe on any number of peers with no configuration. The unsafe shape is the reflex one — `d.items.push({ id: crypto.randomUUID(), … })` — and the fix is usually a one-line reshape to a map keyed by a stable id, which is often the better model anyway.

- ✅ Task 10.3: `packages/react/README.md` — document `useDocStatus` / `useInitialize` and point `useDocReady` at them.

- ✅ Task 10.4: `packages/schema/README.md` — the "Data readiness" section already carries the readiness-is-not-emptiness note. Add a forward pointer to `docStatus` / `initialize` for documents that belong to a Runtime or Exchange, and a short warning that `populated(ref)` is a _callable carrier_, so `if (populated(ref))` is always true — use `isPopulated(ref)` for a boolean, or the `populatedFeed` alias from Phase 1 when the carrier is what is wanted. This is a silent wrong answer in exactly the empty case readers are reaching for the API to detect, so it is worth the two lines.

- ✅ Task 10.5: `packages/exchange/TECHNICAL.md` — new section "Document readiness — a conjunction over layers", after §"Connectivity & settling". Cover:
  - the four layers and the term each contributes; why the empty conjunction is `true` and how that subsumes the transportless case;
  - why settle terms are `[CHANGEFEED]` carriers rather than a bespoke interface, citing `packages/changefeed/TECHNICAL.md`'s universality rule and `jj:mltppspx`'s "Universality of CHANGEFEED" learning;
  - the `x` / `xFeed` naming rule: the short name is the plain value, the `*Feed` suffix is the observable carrier. Explain that the shipped `isPopulated` / `populated` and `isDeleted` / `deleted` pairs are named the other way round, that this is a known error being corrected in 3.0 (`next.md` §10), and that new API is named at the target now so it never needs renaming. Note the concrete hazard the old order creates: a carrier is a callable, so `if (populated(ref))` is always truthy;
  - why the gate guards only the negative verdict;
  - **the limits of the claim, stated plainly.** "Every truth source has reported" is decidable only for sources on this machine: the storage load is a promise we hold, the transport count is a local number, and `authority: "self"` waits for nobody. Whether a remote authority will _ever_ reply is not decidable — a slow peer and an absent peer are indistinguishable, which is a standing result in distributed systems and not something an API can fix. The design stays sound because it only ever concludes `"empty"` from local evidence; giving up on a remote peer produces `waitOutcome: "offline"`, which is carried separately and never becomes a status. Spell out why the timeout applies to the peer term and not to hydration (Phase 5);
  - **why the cross-peer version of the hydration race does not occur**, since a reader will ask. Two independent reasons: a document with stores does not enter the sync graph until it has hydrated (`#register` runs inside the `#hydrate(...).then(...)` continuation), so a server never announces a half-loaded document; and the default discovery disposition for an unrecognised document is `defer`, not `vacant` (`exchange.ts:429-460`, whose comment reads "NOT terminal, so no `vacant` — the peer's interest stays live"). The residual hazard is an application returning `Reject()` from its own `resolve` callback for a document it does hold on disk — that peer will be told the document is empty. Say so, because `initialize` makes the consequence larger than it used to be;
  - **identify the authority by peer ID, not role** — same reasoning as Task 10.1, with the devtools-inspector case named;
  - the `ready` / `readyFor` asymmetry;
  - why authority lives on `Policy` and why the default is `"any"`;
  - the four remedies when a seed must be positional in a mesh topology: declare an intermittent authority with `offlineAfter`; elect one at the call site from `exchange.peers`; bind the document as serialized so the Task 7.2 guard refuses client seeds; or claim with an LWW register and let the winner do the positional part. The last is timing-sensitive and belongs here rather than in the README.

  Also: mark `describeSyncStatus` deprecated wherever it appears (§"Canonical symbols" line 7, §"Connectivity & settling" line 534, §"Key Types" line 809, §"File Map" line 830), recording that it had no consumers and what replaces each half of it — `docStatus` for readiness, `peerStates` + `connectivity` for connection. Correct §"Ready state" where it now understates `ready`, add the pending three-to-two predicate collapse at line 528 (Task 4.2), extend §"Storage" with the `hydrated` vs `flush` distinction, and note in §"Async-factory pattern" that the new per-document latch is a different mechanism from the rejected `Store.initialize` hook — so a future reader does not conclude it was re-litigated. Add entries to §"Questions this document answers", §"Key Types", §"File Map".

  Record one future affordance rather than losing it: `ExtractLaws<S>` is a type-level law accumulator, so "is this seed concurrency-safe?" is in principle a compile-time question. It is currently single-level and non-recursive, so a real check would need work.

- ✅ Task 10.6: `packages/react/TECHNICAL.md` — rewrite §"`useDocReady` and `useSyncState`" as §"Document status hooks". Drop the `describeSyncStatus` references at lines 399 and 550 and note the deprecation; the §"What these are NOT" bullet currently points readers at a helper that is on its way out. Note that these hooks need no store core because the composed feed carries `[CHANGEFEED]`, and that this is why §"The FC/IS split" applies differently here than to `useSyncState`. Update §"Key Types", §"File Map", §"Re-exports".

- ✅ Task 10.7: Comments. Every non-obvious mechanism gets a _why_, in plain language, aimed at a newcomer: the empty conjunction in `settled()`; why `readyFor` stays strict while `ready` does not; why the promise cache exists in `initialize`; why serialized-writer documents refuse non-`"self"` seeding; why authority defaults to `"any"` and what protects the dangerous case; and, on each `*Feed` export, why the carrier is not the thing to put in an `if`.

# ✅ Phase 11: Examples

Last, because this is the first time the API is used by something that is not a test.

- ✅ Task 11.1: Migrate `examples/todo-react` and `examples/prisma-counter` from `useSyncState` to the composed API. Give one a genuine `useInitialize` so the shipped examples demonstrate the pattern instead of side-stepping it with append-only operations.

# Tests

Reuse existing helpers: `createExchange`, `drain`, `InMemoryStore` / `createInMemoryStore` with `sharedData`, `makeMetaRecord` (`packages/exchange/src/testing/store-conformance.ts`), and `Bridge` / `createBridgeTransport` for two-peer cases.

Each phase lands with its own tests green; the groupings below match the revision boundaries.

**Phase 2 — settle terms** (`src/__tests__/settle.test.ts`)

- No terms attached ⇒ `settled(ref)` is `true` (the empty conjunction).
- Two terms ⇒ `true` only when both are; subscribing to `settledFeed(ref)` fires when either changes.
- `hydrated(doc)` is `false` before hydration and `true` after; with no stores it is `true` immediately.
- A store whose read throws leaves the document at `"pending"` and makes the hydration term report failure — it must not hang silently, and must not report `"empty"`. Use a store stub that throws from `loadAll`. (The `whenSettled` rejection this feeds is asserted in Phase 5.)
- `settled` / `hydrated` return actual booleans, not callables — a regression guard for the naming rule, since the whole point is that these are safe to put in an `if`.
- The hydration term does not regress across `suspend()` / `resume()`.

**Phase 3 — authority**

- Pure, no Exchange or transport: `derivePeerSettled` as a truth table over `{ authority × hasReconciled × matchesAuthority × isOffline }`. These are the authority semantics, and a wrong branch here writes defaults over live data, so they are covered without integration setup.
- Integration (extend `src/__tests__/integration.test.ts`): `Policy.authority` is picked up when no call-site option is given; a call-site option overrides it. The peer term resolves `true` immediately under `authority: "self"`, and waits under a predicate.

**Phase 4 — the `ready` change** (extend `src/__tests__/integration.test.ts`)

- Transportless exchange: `ready` is `true`; `readyFor(anyPred)` stays `false`.
- `describeSyncStatus` is unchanged on a transportless exchange (it short-circuits on `connectivity === "offline"` before reading `ready`). It is the one reader of `ready` whose behaviour must _not_ change, so pin it — and because Task 9.5 deprecates it for removal in 3.0, this test is a deprecation-window guard that goes with the module.
- Existing vacant / departure-survival / suspend-survival tests still pass unchanged.

**Phase 5 — `whenSettled`**

- `whenSettled({ peer })` resolves only for a matching peer, and **not** before hydration completes on a document that has both stores and transports. This is the wait-primitive regression guard.
- A failed store read makes `whenSettled` **reject** with the store error rather than hang.
- `offlineAfter` does not rescue a stuck hydration: with a store that never resolves, `whenSettled(doc, { offlineAfter: 20 })` still does not report settled. The timeout is for the peer term only, and this is the test that stops someone "simplifying" it into a single timeout later.

**Phase 6 — `docStatus`** (`src/__tests__/doc-status.test.ts`)

- Pure, no Exchange or store: `deriveDocStatus` as a three-row truth table — populated ⇒ `populated` regardless of settled; not populated + settled ⇒ `empty`; not populated + not settled ⇒ `pending`.
- The three-state at each layer: standalone ⇒ never `pending`; Runtime-with-stores ⇒ `pending` → `populated` across hydration; Exchange ⇒ `pending` until the authority answers.

**Phase 7 — `initialize`** (`src/__tests__/initialize.test.ts`)

- Pure, no Exchange or store: `planInitialization` as a table over `{ status × waitOutcome × authority × writerModel }`, including both reject branches. These are the guards whose failure means silent data divergence, so they are covered here rather than through integration setup. Two rows carry the whole timeout rule and deserve naming in the test titles: `{ status: "pending", waitOutcome: "offline" }` seeds; `{ status: "pending", waitOutcome: "peer" }` does not.
- **The regression that motivates the design:** an exchange whose store holds data is `pending` (never `empty`) before hydration, and `initialize` therefore does _not_ overwrite it. Assert the stored value survives.
- `initialize` returns `"created"` on an empty document and `"loaded"` on a populated one.
- Concurrent `initialize` calls ⇒ exactly one seed write (assert via a changefeed subscriber, not by inspecting internals).
- Two bridged peers concurrently `initialize` the same CRDT document with an LWW-only seed ⇒ converge to the same result as a single-peer seed. This pins the Task 10.2 claim rather than leaving it as prose.
- Transportless daemon: `initialize` resolves without hanging.
- Offline fallback: with a transport configured but no peer ever answering, `initialize(doc, seed, { authority: isServer, offlineAfter: 20 })` seeds after the timeout — while `docStatus(doc)` still reads `"pending"`, because the authority genuinely never replied. This is the pair of assertions that pins the timeout-is-not-a-status rule end to end.

**Phase 8 — React** (`packages/react/src/__tests__/use-doc-status.test.tsx`)

- `useDocStatus` transitions `pending` → `populated` on hydration and re-renders once.
- `useInitialize` seeds once under strict-mode double-mount.
- `useDocReady` is `true` on a transportless exchange (the permanent-spinner regression).

# Transitive Effect Analysis [scratch]

**`@kyneta/exchange` → `@kyneta/react` → examples.** `react` peer-depends on `exchange`, `schema`, `changefeed`, and `reactive`. Changing `ready`'s semantics changes `useDocReady` with no React-side edit. Intended (Task 8.3), but it reaches consumers transitively and must be release-noted, not just changelogged. This is also why Phase 4 is its own revision.

**`ready` → `describeSyncStatus` → `@kyneta/react` re-export → application UI.** `describeSyncStatus(peerStates, connectivity, ready)` short-circuits on `connectivity === "offline"` _before_ consulting `ready`, so a transportless exchange still summarises as `"offline"` and the change is inert. Non-obvious, hence the explicit test in Phase 4. The helper turns out to have no consumers at all, so Task 9.5 deprecates it — but it is still shipped through the 2.x line, so the inertness must be verified, not assumed.

**`ready` → `useDocReady` → spinner logic in consumer apps.** Applications gating render on `useDocReady` begin rendering in local-only mode where they previously spun forever. Desired, but observable.

**Settle terms as changefeeds → `@kyneta/reactive` / `@kyneta/index` / devtools.** Adopting `[CHANGEFEED]` means `reactive(() => docStatus(doc))` composes for non-React consumers, a `Collection` composes for free (it is a `HasChangefeed`), and devtools could observe settle state on the existing bus. None of these require work now; all are foreclosed by a bespoke protocol. This is the main argument for Task 2.1's shape.

**Phase 1 → Phase 6.** `docStatusFeed` is built from `populatedFeed`, which Phase 1 creates. This is the ordering dependency that forces the aliases to land first; with the original numbering, Phase 6 would not have compiled.

**Runtime latch → `Exchange` → deferred promotion.** A promoted document takes a different path through `#getImpl` than a fresh `get()`. Terms attached only to the fresh path leave promoted documents termless and therefore wrongly settled — a silent wrong `empty`. Hence Task 2.5.

**Runtime latch → `compact()` / `reset()` / `shutdown()`.** These manipulate `#docCache`. A latch on `DocCacheEntry` follows entry lifetime; a side table would leak or go stale.

**`suspend` / `resume` → settle terms.** The sync latch deliberately survives suspend. The hydration term must match, or a resumed document regresses to `pending` and a naive initializer could re-seed it.

**`Policy.authority` → `composeGate` → `Governance`.** Adding a field to `Policy` touches the composition function every other policy field flows through. `canConnect` is the precedent for a peer predicate; follow its `undefined`-defers semantics exactly so ordering behaviour stays uniform.

**`initialize` → `batch` → changefeed → synchronizer → stores.** A seed write is an ordinary local mutation: it flows through `onDocChangeset`, marks the document dirty, broadcasts, and persists. That is the point — seeds are real operations. It also means a large default payload produces a full changeset broadcast; a README note, not a code change.

**`initialize` → `Governance` / `Policy`.** Seed writes pass the same gate as any local write, so a restrictive policy could reject a seed. Out of scope to handle; the README should say the seed is a normal write subject to normal governance.

**`waitForSync` removal → `waitUntilReady` → `#isReady`.** Strictly linear chain, all three dying together in 3.0, collapsing a documented three-way distinction to two. Tracked in Task 4.2.

**`useDocReady` reimplementation → `createDerivedSyncStore`.** Loses its only production consumer. Public export, so removal is breaking. Tracked in Task 9.4.

**`@kyneta/devtools` → `ObsEvent` stream.** Seed writes appear as ordinary document changesets with `origin: "init"`. No devtools change needed, but the label makes them filterable — which is why Task 7.3 sets it.

**Schema is touched only by Phase 1.** The aliases are additive; both attaching layers live in `@kyneta/exchange`. That keeps the blast radius off the package every other package depends on, and is the main reason for the WeakMap registry over a schema-owned symbol protocol.

# Resources for Implementation [scratch]

**Read before starting**

- `packages/changefeed/TECHNICAL.md` — the universality rule that dictates Task 2.1's shape.
- `packages/exchange/TECHNICAL.md` §"Ready state — two folds of one transition", §"Connectivity & settling", §"Storage", §"`exchange.get` — the four-case classifier".
- `packages/react/TECHNICAL.md` §"The FC/IS split", §"`useDocReady` and `useSyncState`", §"Snapshot caching for referential stability".
- `packages/schema/README.md` §"Data readiness".

**Patterns to copy**

- `packages/exchange/src/sync.ts:113,196-206` — `syncRefMap` WeakMap + `registerSync`. The settle registry is the same shape.
- `packages/schema/src/interpreters/with-changefeed.ts` — `createPopulatedChangefeed` / `attachIsPopulated`; `populated(ref)` is the exact shape a settle term should have.
- `packages/changefeed/src/callable.ts:51` (`createCallable`), `src/changefeed.ts:264,298` (`changefeed`, `createChangefeed`) — build carriers with these, do not hand-roll.
- `packages/exchange/src/synchronizer.ts:357` (`deriveConnectivity`) — the pure-classifier precedent for `deriveDocStatus`.
- `packages/exchange/src/synchronizer.ts:987-1018` (`awaitReconciliation`) — already predicate-parameterised, and the peer half of `whenSettled`. Note it covers **only** the peer term; `whenSettled` must compose it with the hydration latch.
- `packages/exchange/src/governance.ts` — `Policy.canConnect` and `composeGate`, the precedent for `Policy.authority`.
- `packages/react/src/use-changefeed.ts` — the whole of Phase 8's mechanism.
- `packages/exchange/src/runtime.ts:753-763, 805-813` — the two hydration call sites where the latch resolves; `:897-904` (`#register`) is the existing fire-once precedent.

**Prior art in history (read the commit messages, they carry the reasoning)**

- `jj:rpuqvkyy` — why `seed` was removed and what was meant to replace it. This plan completes its part 1.
- `jj:mltppspx` — why metadata lives on symbols, and the "Universality of CHANGEFEED" learning.

**Verification already in place**

- `packages/exchange/src/__tests__/store-hydration.test.ts` — the three-state invariant across hydration.
- `packages/schema/src/__tests__/pollution.test.ts` — namespace isolation.

# Alternatives Considered

**A bespoke `SettleTerm` interface (`{ settled, subscribe, label }`).** The first draft of this plan. Rejected: it is `ChangefeedProtocol<boolean>` with `current` renamed. `packages/changefeed/TECHNICAL.md` states that every reactive surface goes through the one symbol, and `jj:mltppspx` recorded the same insight as a design learning. Adopting `[CHANGEFEED]` removed an interface, an entire React store core, and the bespoke dual-subscription logic, while making the result compose with `@kyneta/reactive` and `@kyneta/index` for free. The `authority` argument that motivated the custom signature is better modelled as _selecting which feed_ than as a parameter to one.

**A schema-owned `[SETTLE]` symbol protocol.** Would let `docStatus` ship from `@kyneta/schema`. Rejected: both attaching layers live in `@kyneta/exchange`, and `authority` is typed with `PeerIdentityDetails` from `@kyneta/transport`, which `@kyneta/schema` cannot depend on without a cycle. A Layer-1 document is always settled, so a schema-only user's correct check is `isPopulated` alone.

**Disjunctive readiness (`hasReconciled ∨ hydrated ∨ offline`).** Intuitive and wrong here. It is right for "is it safe to _read_?" — an offline-first client should render hydrated local data before the server replies. It is wrong for "is this _empty_?", where every source must have reported. Resolved by scoping the gate to the negative verdict only, which is why `docStatus` has three states rather than two booleans.

**A boolean `isReady` alongside `isPopulated`.** Smaller change, no new type. Rejected: it preserves exactly the ambiguity that causes the data loss — callers must check both, in the right order, with no compiler help. The three-state makes the dangerous state unrepresentable rather than merely discouraged.

**`authority` as a per-call option only.** The first draft. Rejected: authority is a property of deployment topology fixed at process start, so requiring it per call is the same mistake as threading `peerId` through every call. `Policy` already holds standing judgements about peers (`canConnect`), and moving it there deleted a required parameter and an entire error branch. The call-site override is retained because it is what makes runtime leader election expressible.

**Requiring `authority` explicitly whenever a peer term is attached.** The first draft's safety mechanism. Rejected once the serialized-writer guard was in place: that guard already blocks the case where a wrong guess corrupts data, and it is enforced from the schema binding rather than from developer diligence. Defaulting to `"any"` is correct in hub-and-spoke, and the residual mesh risk is bounded duplication rather than divergence — documented in Task 10.2 with four remedies in Task 10.5.

**Naming the new booleans `isSettled` / `isHydrated`, matching the shipped `isPopulated`.** An intermediate draft, chosen for local consistency with the two pairs already in the codebase. Reversed once `next.md` §10 settled the end state: the short name should be the plain value, so shipping `isSettled` would have meant renaming it in 3.0 for no gain. Naming new API at its target costs a temporary inconsistency on the boolean side — `isPopulated` beside `settled` — which Phase 1 bounds by making the carrier side uniform immediately. The `settled(ref)` / `sync(doc).settled()` collision that originally blocked the short name is resolved by `whenSettled` superseding the method (Phase 5 and Task 9.1).

**Keeping `waitForSync`, or preserving it as `settled({ live: true })`.** Rejected — see Task 9.1 for the full capability analysis. Its unique behaviour is connection liveness, which expires on delivery, does not confirm that writes landed, and manifests as the hangs this plan fixes. Point-in-time liveness stays available through `peerStates` + `connectivity`.

**Reviving a `seed` parameter on `Exchange.get`.** Rejected for the three reasons `jj:rpuqvkyy` documented, all still true. `initialize` differs where it matters: it writes through `batch` after construction, so seeds are real operations with version history and concurrent seeds merge under normal CRDT semantics.

**An in-memory `@kyneta/bridge-transport` pair to make transportless daemons "work".** Rejected as a workaround for a semantic bug. It manufactures a fake peer so "has a peer spoken?" returns `true`, when the honest answer is "there are no peers, and that is fine". It costs a second exchange and replica, wire encode/decode, and an async handshake, and flips `connectivity` from `offline` to `online`, perturbing anything keyed on it. Bridge remains the right tool for genuinely running two peers in one process.

**Flipping `populated` / `deleted` to booleans in this change.** Rejected: it breaks two shipped public exports, which under lockstep `@kyneta/*` versioning forces an unplanned consumer migration inside a minor. Phase 1 takes the additive half now (`populatedFeed` / `deletedFeed` aliases plus deprecation), leaving the type flip to 3.0 where `next.md` §10 sequences it with the other removals.

**Promoting `allOf` into `@kyneta/changefeed`.** Deferred, not rejected. The conjunction combinator may be generally useful, but `@kyneta/changefeed` has no combinators today and adding public API to a foundational package on a single consumer's evidence is premature. Keep it local to `settle.ts`; promote when a second consumer appears.

**Removing `waitForSync` outright in 2.x.** Rejected on release-management grounds. Under this repository's lockstep versioning across `@kyneta/*`, a hard break inside a minor forces consumers into an unplanned migration. Deprecate with a runtime warning now, remove in 3.0 together with `sync(doc).settled()`, `waitUntilReady`, `#isReady`, `hasSync`, and `createDerivedSyncStore`.

**Landing this as one revision, or as the original six phases.** Rejected. Six phases bundled four unrelated ideas into Phase 2 — including the only behaviour change to shipped API — and put the schema aliases last, after the code that needed them. Eleven revisions cost more commits but each one carries a single idea, compiles alone, and can be bisected to.
