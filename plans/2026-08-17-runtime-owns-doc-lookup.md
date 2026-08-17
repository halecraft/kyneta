refactor(exchange): the Runtime looks up its own documents

# Background

`packages/exchange/TECHNICAL.md` states the package's fourth architectural principle: the `Runtime` is the local imperative shell — document cache, stores, hydration, lease, tick clock — and the `Exchange` is the network shell. The Runtime works standalone; a local-first app uses one without ever constructing an Exchange.

The fifth principle says how the two are joined:

> **Runtime hooks bridge local→network:** The Runtime fires `onDocReady`, `onDocChangeset`, `onDocDestroyed`, `onDocSuspended`, `onDocResumed`. The Exchange wires these into the Synchronizer.

Every hook in that list points one way — the Runtime tells the Exchange something happened. There is one call in the other direction, and it is not in the list: `Runtime.onStateAdvanced` (`packages/exchange/src/runtime.ts:637`), which the Exchange invokes when the sync graph advances a document's version so the Runtime can persist the delta.

# Problem Statement

**The inbound call carries data the Runtime already owns, on a round trip through the Exchange.**

The Runtime builds a `DocReadyInfo` when a document becomes ready and keeps it in `#docCache`. It hands a copy outward through `onDocReady`, and the Exchange passes that same object to `synchronizer.registerDoc`. Later, when the version advances:

```
Runtime  builds readyInfo { replica, replicaFactory, syncMode, schemaHash }
   │                         and keeps it in #docCache, keyed by docId
   ├─ onDocReady(readyInfo) ─────────────► Exchange
   │                                          └─ synchronizer.registerDoc({ replica, replicaFactory, … })
   │
   │                                       Exchange  ◄──── synchronizer.onStateAdvanced(docId)
   │                                          └─ getDocRuntime(docId) → { replica, replicaFactory }
   ◄── onStateAdvanced(docId, replica, replicaFactory) ─┘
```

`docRuntime.replica` is not a copy — it is the same object the Runtime put in its own cache under the same `docId`. The Exchange looks it up in the synchronizer purely to hand it back.

**The second call site demonstrates the redundancy.** `#drainLocalChanges` (`:1115`) has no Exchange involved. It reads the cache entry itself and then unpacks it to pass the pieces:

```ts
const entry = this.#docCache.get(docId);
if (entry && entry.mode !== "deferred") {
  this.#persistIfAdvanced(
    docId,
    entry.readyInfo.replica,
    entry.readyInfo.replicaFactory,
  );
}
```

**It has already misled the documentation.** `packages/exchange/TECHNICAL.md:836`, step 4 of the storage dispatch chain, reads:

> The Exchange's listener computes `exportSince(confirmedVersion)` to get the delta, then dispatches `{ type: 'state-advanced', docId, delta, newVersion }` into the store-program.

The Exchange's listener does none of that. It forwards a `docId` and three arguments; the Runtime computes the delta and dispatches. The sentence is wrong in a way the current signature invites, because the parameters make it look as though the caller is supplying the material for the write.

**A third consumer would need a fourth copy of the same lookup.** Anything that wants to prompt a persist — a future manual flush of one document, a debug hook, a store that reconnects — has to find a `replica` and a `replicaFactory` first, from wherever it happens to be standing.

# Success Criteria

1. **The Runtime resolves a document from its `docId`.** `#persistIfAdvanced` and `Runtime.onStateAdvanced` take a `docId` and nothing else. Neither has a parameter that duplicates `#docCache`.
2. **The Exchange's listener forwards a `docId`.** No `getDocRuntime` call, no unpacking.
3. **Behaviour is unchanged for every document the Runtime tracks**, and the one divergence case is deliberate and tested — see Phase 1's second task.
4. `packages/exchange/TECHNICAL.md`'s dispatch chain says who actually computes the delta.
5. `pnpm verify` green after every phase.

Each phase below is one commit, landing in order, each independently green. The summary line to use is given with the phase. Phase 2 does not depend on Phase 1 and could equally land first; it is second because it is smaller.

# ✅ Phase 1 — Resolve the document from its id

> `refactor(exchange): the Runtime looks up its own documents`

- ✅ Task 1.1: `#persistIfAdvanced` (`packages/exchange/src/runtime.ts:682`) becomes `#persistIfAdvanced(docId: DocId): void` and resolves the entry itself:

  ```ts
  const entry = this.#docCache.get(docId)
  if (!entry || entry.mode === "deferred") return
  const { replica, replicaFactory } = entry.readyInfo
  ```

  The rest of the method is unchanged. Note it already reaches into `#docCache` for `readyInfo.syncMode` and `readyInfo.schemaHash` on the retry path, so this removes a second way of getting at the same entry rather than introducing a first.

- ✅ Task 1.2: **Accept and pin the one behaviour difference.** The guard above skips a document with no cache entry, or a `deferred` one. Today `onStateAdvanced` would proceed for such a document, using the replica the Exchange handed it.

  This is the behaviour `#drainLocalChanges` has always had, so the change makes the two call sites agree rather than inventing a rule. It is also the safer of the two: persisting a document the Runtime no longer tracks writes state whose lifecycle nothing owns.

  Reaching it requires the synchronizer to hold a `DocRuntime` the Runtime's cache does not — the two are populated together through `onDocReady` and torn down together through `onDocDestroyed`, so it should not occur. Add a Runtime-level test that a `state-advanced` notification for an unknown document is a no-op rather than a throw, so the guard is exercised and the intent is recorded.

- ✅ Task 1.3: `Runtime.onStateAdvanced` (`:637`) narrows to `onStateAdvanced(docId: DocId): void`.

  Comment what the signature now says: the Exchange reports *which* document advanced, and the Runtime resolves everything else from its own cache. That is the direction the rest of the seam already runs in — see `RuntimeHooks`, where every callback carries information outward.

- ✅ Task 1.4: The Exchange's listener (`packages/exchange/src/exchange.ts:588`) drops the `getDocRuntime` lookup and the null check, becoming a forward of the `docId`.

- ✅ Task 1.5: `#drainLocalChanges` (`:1115`) drops its unpacking. The `entry && entry.mode !== "deferred"` test moves into `#persistIfAdvanced`, so the loop body is a call.

- ✅ Task 1.6: `packages/exchange/TECHNICAL.md` §Storage, step 4 of the dispatch chain (`:836`). Correct it to say the Exchange's listener forwards the `docId` and the Runtime computes `exportSince(confirmedVersion)` and dispatches. Say plainly that the Runtime resolves the replica from its own cache, since the previous wording implied the Exchange supplies it.

  While there, add `onStateAdvanced` to the seam description near principle 5 (`:13`). It is the one inbound call in a list of outbound ones, and its absence is part of why the chain was described wrongly.

# ✅ Phase 2 — One way to wrap a store in tests

> `test(exchange): one helper for wrapping a store`

Independent of Phase 1. Included because it is the same shape of problem — a contract restated by hand at each site — and because one of the three copies is quietly wrong.

- ✅ Task 2.1: Add a `wrapStore(inner: Store, overrides: Partial<Store>): Store` helper to `packages/exchange/src/__tests__/store-integration.test.ts`, beside the existing helpers.

  It must forward **every** `Store` method explicitly rather than spreading `inner`. `createInMemoryStore` returns a class instance, so `{ ...inner, append }` copies the own properties and none of the prototype methods: the wrapper looks complete, and fails at the first call to `currentMeta` or `loadAll`, some distance from the line that caused it. Say so in the helper's comment — it is the whole reason the helper exists rather than each site spreading.

- ✅ Task 2.2: Rewrite the three existing wrappers in terms of it: `slowAppend` (`:217`), `failingFirstAppend` (`:290`), and the inline `counting` store (`:409`).

  `counting` is the one with the latent bug. It spreads, so it has no `currentMeta` — it works only because the transient document it is used with never hydrates. A durable document would fail there.

# Tests

`packages/exchange/src/__tests__/store-integration.test.ts` already exercises the persist path end to end through a real `Exchange`, which is what this change runs through. `packages/exchange/src/__tests__/` also holds Runtime-level suites for the standalone case.

**Phase 1** — the refactor is behaviour-preserving, so the existing suites are the primary evidence. Two additions:

- ✅ **A `state-advanced` for an unknown document is a no-op.** Drive `Runtime.onStateAdvanced` with a `docId` that has no cache entry and assert it neither throws nor dispatches. This pins Task 1.2's guard, which is the one place behaviour could differ.
- ✅ **The existing persist, hydrate, retry and in-flight-queue cases pass unchanged.** In particular the in-flight-write case added with `PLAN-2026-08-17-store-initial-write-failure`: it exercises `#persistIfAdvanced` for a document mid-write, which is the path where the resolved replica has to be the same object the Exchange used to pass.

**Phase 2** — no new cases. The three rewritten wrappers are exercised by the tests that already use them, and the `counting` rewrite gains `currentMeta` coverage for free by no longer omitting it.

# Transitive Effect Analysis [scratch]

1. **`onDocReady` → `registerDoc` → `getDocRuntime` → `onStateAdvanced`.** The chain this collapses. Removing the last two hops does not change what the synchronizer holds; it stops the Exchange reading its own copy in order to return it. `getDocRuntime` keeps its other callers.

2. **The Runtime standalone.** `Runtime.onStateAdvanced` is public and part of the standalone surface, but the only in-repo caller is the Exchange (`exchange.ts:591`). Narrowing it is a breaking change to that method's signature for any external caller — acceptable inside this package, and worth noting because the Runtime is documented as usable without an Exchange.

3. **`#docCache` and the synchronizer's `#docRuntimes` can in principle diverge.** They are populated together (`onDocReady` → `registerDoc`) and torn down together (`onDocDestroyed`). The new guard makes divergence a silent skip rather than a persist against an untracked replica. Task 1.2 pins it.

4. **Deferred documents.** `{ mode: "deferred" }` carries no `readyInfo`, so the guard has to discriminate on `mode` before reaching one — the same three-way shape `Runtime.destroy` uses. A deferred document has no replica in the synchronizer either, so it cannot generate a `state-advanced` in the first place.

5. **The retry path added by `PLAN-2026-08-17-store-initial-write-failure`.** It already resolves `entry.readyInfo` for `syncMode` and `schemaHash`. After this change it shares one lookup with the rest of the method instead of holding a second.

6. **`#versionAlreadyTargeted` is unaffected.** It takes a `DocPhase` and a version string, neither of which changes.

# Resources for Implementation [scratch]

- `packages/exchange/TECHNICAL.md` — principles 4 and 5 (`:12-13`) for the FC/IS seam and the direction its hooks run in; §Storage's dispatch chain (`:831-837`) for the description Task 1.6 corrects.
- `packages/exchange/src/runtime.ts` — `onStateAdvanced` (`:637`), `#persistIfAdvanced` (`:682`), `#drainLocalChanges` (`:1115`), `DocReadyInfo` (`:85`), `DocCacheEntry` (`:150`).
- `packages/exchange/src/exchange.ts:588` — the listener, and `:551` where `onDocReady` hands `readyInfo` to `registerDoc`, which is what makes the two references the same object.
- `packages/exchange/src/__tests__/store-integration.test.ts` — the end-to-end persist path, and the three store wrappers Phase 2 consolidates.

# Alternatives Considered

**Leave the parameters and accept the round trip.** The status quo. Rejected on the evidence that it has already caused a documentation error: `TECHNICAL.md` credits the Exchange's listener with computing the delta, which is what the signature implies and not what happens. A signature that invites a wrong mental model is worth changing even when the code is correct.

**Pass the whole `DocReadyInfo` instead of two of its fields.** Fewer parameters, and it would have made the retry path's extra lookup unnecessary. Rejected because it is the same round trip with a bigger payload: the Runtime would still be receiving an object it created and still holds. The question is not how much to pass but whether to pass anything.

**Have the Runtime subscribe to the synchronizer directly.** Removes the Exchange from the path entirely. Rejected: it inverts the dependency the package is built on. The Runtime must work with no network layer at all, so it cannot know about a synchronizer, and the Exchange exists precisely to be the thing that does.

**Also remove `Runtime.onStateAdvanced` and have the Exchange call `#persistIfAdvanced` through some internal accessor.** Rejected: `onStateAdvanced` is the Runtime's notification surface, and having one is right. What is wrong is only what it asks the caller to know.
