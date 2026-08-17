fix(exchange): a document whose first store write fails is not abandoned

# Background

Persistence is driven by a pure Mealy machine, the store-program (`packages/exchange/src/store/store-program.ts`), documented in `packages/exchange/TECHNICAL.md` §Storage. It tracks each document in a `DocPhase`, and the field that matters here is the **confirmed version** — the version the store has actually acknowledged writing.

`Runtime.#persistIfAdvanced` (`packages/exchange/src/runtime.ts:682`) uses it as the base for an incremental write:

```ts
const confirmedVersion = phase.version;
if (!confirmedVersion) return; // Empty string = initial register, skip
// ...
const sinceVersion = replicaFactory.parseVersion(confirmedVersion);
const delta = replica.exportSince(sinceVersion);
```

A delta is only meaningful relative to something already on disk. Until the first write lands there is no such base, and `#persistIfAdvanced` has nothing to compute against.

`packages/exchange/TECHNICAL.md:852` describes the intended behaviour when a write fails:

> **Self-healing version tracking.** The store-program's confirmed version only advances on `write-succeeded`. If a write fails, the old version is preserved so the next `exportSince` recomputes the full delta from the last known-good point. This means transient store failures (disk full, `QuotaExceededError` on IndexedDB, network blip on a remote store) self-heal on the next successful write without data loss.

# Problem Statement

**1. `DocPhase` encodes "no confirmed version" as the empty string.**

`register` — the first write for a document not found in any store — constructs (`store-program.ts:194`):

```ts
const phase: DocPhase = {
  status: "writing",
  version: "",
  pendingVersion: msg.version,
};
```

The type says `version: string`, which claims a confirmed version always exists. At this moment none does. The empty string is absence wearing the costume of a value, and nothing at the definition marks it as special — the only explanation lives one module away, in `runtime.ts:692`.

The sentinel is currently safe from collision: every `Version.serialize()` in the tree is structurally non-empty (Yjs emits `svB64 + "." + digest`, Loro base64, the state substrate `String(timestamp)`, plain `` `${lineage}:${value}` ``). Safety from collision is why it has survived; it is not why it is wrong.

It is wrong because it is out of character for this codebase, which is otherwise strict about making absence structural. `DocCacheEntry`'s `{ mode: "deferred" }` omits `readyInfo` so that reading it does not compile. `SubstrateFactory.createForHydration` is optional rather than a defaulted no-op. `HydrationLatch` uses three named states rather than a nullable error. Each of those lets the compiler enforce a distinction. This one blinds it to a distinction that matters.

**2. That blindness has already produced a bug: a failed first write abandons the document for the rest of the process.**

`write-failed` reverts to idle at the previous version (`store-program.ts:361-363`):

```ts
// Revert to idle at the old version — next exportSince will
// recompute from the old version, so nothing is lost.
const idleVersion = existing.version;
```

Correct when there _is_ an old version. When the failure is the **initial register**, `existing.version` is `""`, so the phase becomes `{ status: "idle", version: "" }`. Every subsequent mutation then reaches `#persistIfAdvanced`, reads `""`, and returns. Nothing re-issues `register` — that input is dispatched only from `Runtime.#hydrate` (`:1216`) when a document is first opened and found absent.

So the document is silently excluded from persistence until the process restarts. A `store-error` effect _is_ emitted, so the failure is observable; its durable consequence is not. And the documentation quoted above promises the opposite — this is precisely the "disk full / quota exceeded / network blip" case it says self-heals, and it is the one case that does not.

**3. No test covers it, for the same reason the code missed it.**

`packages/exchange/src/store/__tests__/store-program.test.ts` has three `write-failed` cases (`:340`, `:381`, `:645`). The first seeds state via `hydrated` with `version: "v1"`, the second asserts `version: "v1" // old version`, the third covers an unknown document. None begins with `register`. The suite shares the production code's unstated assumption that a prior version always exists.

**4. Six sites read the phase, not two.** The empty string is constructed in one place and read in one place, but the _shape_ of `DocPhase` is depended on much more widely, and any change to it has to account for all of them:

| Site | What it does with the phase |
| --- | --- |
| `:142`, `:158` (`processQueued`) | builds the next `writing` phase from a version threaded in as a parameter |
| `:229` (`state-advanced`) | branches on `status === "idle"`; the else branch reads `.version`, `.pendingVersion`, `.queued` |
| `:275` (`compact`) | the same branch and the same reads |
| `:330` (`write-succeeded`) | guards on `status !== "writing"` |
| `:352` (`write-failed`) | guards the same way, then reads `.version` |
| `:391` (`allDocsIdle`) | `status !== "idle"` → not quiescent |

The design below is chosen partly so that most of these do not have to change at all. See Alternatives Considered.

# Success Criteria

1. **`DocPhase` cannot claim a confirmed version it does not have.** "Nothing written yet" is a distinct variant with no `version` field, so reading one where none exists is a type error rather than an empty string.
2. **A document whose first write fails retries.** After a `write-failed` on the initial register, the next mutation re-attempts a full write and the document persists normally from then on — without waiting for a process restart.
3. **`flush()` and `shutdown()` still complete** for a document in the new state. Neither may hang.
4. The self-healing claim in `packages/exchange/TECHNICAL.md` is either true as written or corrected to describe what actually happens.
5. `pnpm verify` green after every phase.

Each phase below is one commit, landing in order, each independently green. The summary line to use is given with the phase.

# ✅ Phase 1 — Name the state

> `refactor(exchange): DocPhase says whether anything has been written yet`

**Behaviour-preserving.** The bug is still present when this lands; what changes is that the state it depends on has a name and a type instead of an empty string. Keeping the fix out of this commit means a reviewer can check the type change against "does anything behave differently?" and expect the answer to be no.

- ✅ Task 1.1: Restate `DocPhase` (`packages/exchange/src/store/store-program.ts:31`) so that a write remembers what to revert to, rather than leaving each failure branch to work it out:

  ```ts
  /** A phase with no write in flight — what `writing` falls back to. */
  type SettledPhase =
    | { status: "unwritten" } // nothing durable yet
    | { status: "idle"; version: string }; // last confirmed version

  export type DocPhase =
    | SettledPhase
    | {
        status: "writing";
        revertTo: SettledPhase;
        pendingVersion: string;
        queued?: QueuedInput[];
      };
  ```

  Three variants, and the `revertTo` field is what makes it three rather than four. The alternative — a separate `writing-initial` status — would fork every site that currently tests `status === "writing"`, including two guards whose behaviour must not change. Carrying the fallback _in_ the writing phase keeps `writing` a single status and turns `write-failed` into a return of a value rather than a reconstruction.

- ✅ Task 1.2: `register` (`:193`) constructs `{ status: "writing", revertTo: { status: "unwritten" }, pendingVersion: msg.version }`. The empty string disappears rather than moving somewhere else.

- ✅ Task 1.3: `state-advanced` (`:225`) and `compact` (`:269`) — the two inputs that start a write from a settled phase.

  Both currently branch on `status === "idle"`. Widen to "settled" (`status !== "writing"`) and pass `revertTo: existing`, which now typechecks directly because `existing` _is_ the settled phase.

  **The two inputs differ on `unwritten`, and the difference is the point.** `compact` carries a full entirety and its own `meta`, so it can write from nothing — treat `unwritten` exactly like `idle`. `state-advanced` carries a _delta_, which is meaningless without a base version, so it must return the model unchanged for an `unwritten` document. Comment that asymmetry where it lives; it is not obvious, and the natural instinct is to make the two cases symmetrical.

- ✅ Task 1.4: `processQueued` (`:127`) takes the settled phase rather than a version string — `(docId: DocId, settled: SettledPhase, queued: QueuedInput[])` — and threads it into the `writing` phase it builds as `revertTo`.

  A queued `state-advanced` cannot coexist with `revertTo: { status: "unwritten" }`: `state-advanced` only queues while a write is in flight, and per Task 1.3 it is dropped rather than queued for an unwritten document. Assert or comment this rather than writing a branch for it.

- ✅ Task 1.5: `write-failed` (`:350`) becomes `[withDoc(model, msg.docId, existing.revertTo), errorEffect]`, plus the existing queued-replay path. No branch on which kind of write failed — that decision was made when the `writing` phase was constructed.

  `write-succeeded` (`:328`) needs no change at all: there is still exactly one `writing` status, so its guard still matches, and it still transitions to `{ status: "idle", version: msg.version }`.

- ✅ Task 1.6: `allDocsIdle` (`:389`) becomes `status !== "writing"`. Its real meaning is **"no I/O is in flight"**, not "every document has status `idle`" — `unwritten` is quiescent and must satisfy it. Correct the doc comment to say so, because the name will otherwise keep suggesting a status comparison.

  This is the constraint that makes the task non-optional: `flush()` and `shutdown()` both `await this.#storeHandle.waitForState(allDocsIdle)` (`runtime.ts:769`, `:780`). A settled status the predicate rejects hangs every teardown.

- ✅ Task 1.7: `Runtime.#persistIfAdvanced` (`:682`) branches on the phase variant instead of on the emptiness of a string. For `unwritten`, **return** — matching today's behaviour exactly. For `idle`, the existing delta path. For `writing`, return as today; the program queues.

  Keep the existing note about transient documents never getting past the `!phase` guard: it is still true, and it explains a rule that lives in another method. Fold it into the new branch rather than replacing it.

- ✅ Task 1.8: Tests for this phase — see §Tests. All in `store-program.test.ts`; this commit adds no integration test because it changes no behaviour.

# ✅ Phase 2 — Retry the first write

> `fix(exchange): a document whose first store write fails retries on the next mutation`

- ✅ Task 2.1: `Runtime.#persistIfAdvanced`'s `unwritten` branch dispatches a fresh `register` carrying `replica.exportEntirety()` instead of returning. There is no base version, so a full write is the only correct attempt.

  The method needs the document's `StoreMeta` — `{ replicaType, syncMode, schemaHash }` (`store/store.ts:42`) — which the callers already hold on `DocReadyInfo` (`runtime.ts:85`); `#hydrate` builds the same value at `:1153`. Pass it in rather than reconstructing it.

- ✅ Task 2.2: `register` (`:193`) must now be correct when a phase already exists. Previously it arrived once per document per session, from `#hydrate` alone. This is the one place the change widens an input's contract, and it deserves a comment saying so.

- ✅ Task 2.3: Comment the retry. The non-obvious part is _why a full write rather than a delta_: a delta is defined relative to a version the store acknowledged, and after a failed first write there is none. One sentence, at the branch.

- ✅ Task 2.4: Tests for this phase — see §Tests. Both the recovery transition and the integration case belong here, because both fail before this commit and pass after.

# ✅ Phase 3 — Documentation

> `docs(exchange): what happens when a store write fails`

- ✅ Task 3.1: `packages/exchange/TECHNICAL.md` §Storage, "Self-healing version tracking" (`:852`). Extend it to cover both failures: an _incremental_ write replays from the last confirmed version, and an _initial_ write leaves the document `unwritten` so the next mutation re-attempts the full write. Say the two differ because a delta needs a base version and the initial write has none.

  While editing, disambiguate the word "transient". This paragraph uses it to mean a _temporary_ store failure, and the subsection directly above it now uses `transient` as a `Durability` value meaning _never persisted_. Two unrelated senses of the same word, adjacent in one section — "temporary store failures" resolves it.

- ✅ Task 3.2: `packages/exchange/TECHNICAL.md` §Storage, "Per-doc phase tracking" (`:850`). It states each document "is in one of two phases: `idle` or `writing`". Update to the three, and say what `revertTo` carries and why — a write has to know what to fall back to, and only the code that started the write knows whether that is a version or nothing at all.

- ✅ Task 3.3: No README change. `Store`, `onStoreError` and the public exchange surface are untouched; this is a correctness fix behind the existing interface.

# Tests

`packages/exchange/src/store/__tests__/store-program.test.ts` drives the program directly with input sequences and asserts on `[model, ...effects]`. That is the right level for the state-machine cases, and the existing `write-failed` cases (`:340` onward) are already written this way.

Each test ships in the phase that makes it pass.

**Phase 1** — all behaviour-preserving, so these pin transitions rather than fixes.

- ✅ **`register` → `write-failed` leaves the document `unwritten`.** The transition that is currently untested and the one that strands the document. Assert the phase, and that `store-error` is still emitted.
- ✅ **`register` → `write-succeeded` reaches `idle` with the version.** The happy path through the new `writing` phase. Cheap, and it is the case that would hang every `flush()` if `write-succeeded`'s guard ever stopped matching.
- ✅ **`allDocsIdle` is true for `unwritten`, false while `writing`.** Two lines, pinning the distinction the predicate now has to make. Without it, a future contributor restoring the status comparison hangs `shutdown()` with no failing test to say why.
- ✅ **`compact` on an `unwritten` document writes; `state-advanced` on one does not.** The asymmetry from Task 1.3, which is otherwise only a comment.
- ✅ **The existing three `write-failed` cases pass unchanged.** They cover `writing` → `idle`, which this phase must not alter.

**Phase 2** — both of these fail before the commit and pass after.

- ✅ **`unwritten` → `state-advanced` → `register` → `write-succeeded` reaches `idle`.** The recovery path works and is not a dead end.
- ✅ **Integration: a document whose first write fails still persists after the next mutation.** In `packages/exchange/src/__tests__/store-integration.test.ts`, with a store whose first `append` rejects and whose later ones succeed. Assert the records land. This is the only test exercising the runtime and the program together, and it is what would have caught the defect from the outside.

# Transitive Effect Analysis [scratch]

1. **`allDocsIdle` → `flush()` / `shutdown()`.** The sharpest constraint. Both callers block on `waitForState(allDocsIdle)`, so a settled status the predicate rejects turns a correctness fix into a hang on every teardown. This is also why the three-variant design is preferable: a separate `writing-initial` status would additionally have had to be added to `write-succeeded`'s guard, and missing that would leave every successfully-written document stuck mid-write.

2. **`processQueued` → the `compact` path.** Queued inputs are replayed against the settled phase. `state-advanced` cannot queue for an `unwritten` document (Task 1.3 drops it), so `revertTo: { status: "unwritten" }` can only ever be paired with a queued `compact`, which carries its own entirety and is therefore safe.

3. **`#persistIfAdvanced` → dispatch volume.** After Phase 2 a document in `unwritten` dispatches a full `register` on its next mutation rather than returning. For a persistently failing store that is one full-entirety attempt per mutation instead of none. The `store-error` path already exists to surface it, and the alternative — staying silent — is the defect. Bounded retry belongs to the application via `onStoreError`, not to a pure program.

4. **`register` dispatched twice for one document.** Previously once per document per session, from `#hydrate`. Phase 2 adds a second source. The `register` case must be correct when a phase already exists, not only when the document is unknown.

5. **Transient documents cannot reach any of this.** Since `PLAN-2026-08-02-transient-docs-skip-stores`, a document declared `durability: "transient"` is never registered with the store-program, so it never acquires a phase and never reaches `unwritten`. The retry path applies to durable documents only, which narrows the blast radius without weakening the case.

6. **`store-integration.test.ts` needs a failing store.** The in-memory store has no failure injection. The integration case needs a small wrapper rejecting the first `append`, which belongs beside the existing helpers in that file rather than in the shared store package. Note that file already wraps a store to count `delete` calls, so the shape exists to copy.

7. **`DocPhase` is exported.** Part of the store-program's within-package surface, and it appears in `packages/exchange/TECHNICAL.md`'s file map. Nothing outside `@kyneta/exchange` consumes it, so restating the union is not a breaking change for consumers.

8. **The empty-string sentinel has no third site.** `version: ""` is constructed only at `store-program.ts:196` and read only at `runtime.ts:692`. Nothing else to find later.

# Resources for Implementation [scratch]

- `packages/exchange/TECHNICAL.md` §Storage — the input and effect vocabulary, the per-doc phase description, and the self-healing paragraph Phase 3 corrects. Read first; it is the specification this change brings the code back into line with.
- `packages/exchange/src/store/store-program.ts` — `DocPhase` (`:31`), `processQueued` (`:127`), the seven input cases (`:193` onward), `allDocsIdle` (`:389`). The six phase-reading sites are tabulated in Problem Statement 4.
- `packages/exchange/src/runtime.ts` — `#persistIfAdvanced` (`:682`), its two call sites (`:642`, `:1077`), the `register` dispatch in `#hydrate` (`:1216`), the `StoreMeta` construction (`:1153`), and `DocReadyInfo` (`:85`).
- `packages/exchange/src/store/store.ts:42` — `StoreMeta`, and the append-only record contract requiring a document's first record to be `meta`.
- `packages/exchange/src/store/__tests__/store-program.test.ts:340` — the existing `write-failed` cases and the seeding style the new ones should follow.

# Alternatives Considered

**A separate `writing-initial` status, giving four variants.** The obvious split: one status for "writing with a version to fall back to", another for "writing with none". Rejected, and the reason is concrete rather than aesthetic. Two guards test `status === "writing"` — `write-succeeded` (`:330`) and `write-failed` (`:352`) — and a new writing status silently falls out of both. Missing the first is the worse failure: a _successful_ first write would leave the document stuck mid-write forever, `allDocsIdle` would never be true, and `flush()` would hang for every store-backed document. Carrying `revertTo` inside the one `writing` phase keeps both guards correct untouched, and reduces `write-failed` to returning a value it was handed.

**Leave the sentinel, fix only `write-failed`.** The smaller change: branch on `existing.version === ""` and revert to a re-register state. Rejected because it keeps the condition that caused the bug. The revert branch would still be inferring a state from a string's emptiness, and the next person adding a phase transition has the same trap available. The type change is what makes the mistake unavailable rather than merely absent.

**`version: string | null` instead of separate variants.** Smaller diff, and it does make the absence visible. Rejected because it leaves `null` to be handled at each site by whatever means the author chooses, and `?? ""` is one keystroke from restoring today's behaviour with no type error.

**Retry inside the store-program by re-emitting the failed effect.** Keeps the runtime untouched, and the program still holds the records it tried to write. Rejected: a pure Mealy machine re-emitting its own failed effect is an unbounded retry loop against a persistently failing store, with no natural place for a bound. Driving the retry from the next mutation gives it one — the application's own write rate — and keeps the program a function of its inputs.

**Drop the document from `model.docs` on a failed initial write.** The phase disappears, so `#persistIfAdvanced`'s existing `if (!phase) return` covers it with no new status. Rejected: it reproduces today's behaviour exactly, because nothing re-issues `register` within a session. It also loses the distinction between "never seen" and "tried and failed", which is precisely what the runtime needs in order to retry.

**Accept restart-only recovery and document it.** The failure is already surfaced via `onStoreError`, and the next session re-registers. Rejected: `#persistIfAdvanced` stays silent for the remainder of a process that may run for weeks, and a server's documents are exactly the ones that do not restart promptly. The documented promise is self-healing, and the initial write is not a special enough case to carve out.
