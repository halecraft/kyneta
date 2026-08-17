refactor(exchange,schema)!: name the two compatibility laws; get() is total over document phase

# Background

`exchange.get(docId, bound)` is the front door of `@kyneta/exchange`. Its job is _ensure_, not _lookup_: "give me an interpreted handle to this document, whatever state it is in."

A document sits in one of three **phases**, plus an orthogonal suspension flag:

| Phase | Means | Holds |
| --- | --- | --- |
| `deferred` | a peer announced it; we have not committed to it | nothing |
| `replicate` | registered headless for relaying | a bare `Replica`, no schema, no ref |
| `interpret` | fully materialised | substrate + `Ref<S>` |
| _(suspended)_ | left the sync graph, kept locally | unchanged ref and substrate |

`packages/exchange/TECHNICAL.md` §"`exchange.get` — the four-case classifier" states the intent plainly at line 313: **"The return is always a `Ref<S>`."** The code does not do that. It throws for `suspended` and for `replicate`.

But the throws are the symptom. Underneath them are two separate scatterings.

## Scattering 1: four sites compare document metadata, and they are not all asking the same question

Every one of these compares the same three axes — `replicaType`, `schemaHash`, `syncMode`. But they are not one question. There are two, and the difference lives entirely in the hash axis.

`packages/schema/TECHNICAL.md:1109-1124` defines `supportedHashes` as every hash at which a peer can op-stream sync, computed by walking migration chains **backwards**. A V2 schema that renamed `zip → postalCode` supports `{H2, H1}`; a V1 schema supports `{H1}` alone. `:1130` is explicit that this is **"Not bidirectional"** — newer reads older, never the reverse. That asymmetry splits the question in two:

| Question | Law | Symmetry | Documented at |
| --- | --- | --- | --- |
| **Interpretation** — "can *my schema* read a document written at `h`?" | `h ∈ S_local` | directional | `packages/schema/TECHNICAL.md:449` |
| **Sync** — "is there a version we *both* speak?" | `S_local ∩ S_remote ≠ ∅` | symmetric | `packages/schema/TECHNICAL.md:1124` |

Membership implies intersection; the converse fails. Two peers on divergent branches from a common ancestor — local `{H2a, H1}`, remote `{H2b, H1}` — intersect at `H1`, so sync can proceed, while local cannot interpret an `H2b` document at all. Both answers are correct for their own question.

**And the two questions are heading for two different sets.** Today they differ only in *shape* — membership versus intersection over the same `supportedHashes`. But that set is deliberately the narrower of two the theory names: `packages/schema/TECHNICAL.md:1117` says the T2 halt exists to "align the single-set `supportedHashes` with the theory's `nativeSupports` semantics", and `:1122` records that the richer `readSupports` / `nativeSupports` split is deferred until degraded-sync infrastructure exists. When it arrives, interpretation reads `readSupports` and sync reads `nativeSupports` — different inputs, not just different shapes. That is the strongest reason not to merge the two laws into one function with a flag: the flag would eventually have to switch the data source, not just the operator.

**And the two questions take different arguments**, which the current types do not say. A document has one hash — the shape its data is written at. A peer has a *set* — the shapes its schema can read. So `supportedHashes` describes a **reader**, never a document. The codebase found this once already and worked around it (`store/store.ts:30-39`):

> `supportedHashes` is excluded because it is derived from the runtime `BoundSchema.supportedHashes` set, not from the document's persisted data.

That is the whole argument, written before this plan and resolved with an `Omit` rather than a type. The consequence is visible in the tree. Within `@kyneta/schema` and `@kyneta/exchange`, **`DocMetadata.supportedHashes` is dead**: its only producer, `getDocMetadata` (`synchronizer.ts:794-801`), does not populate it; its four consumers (`exchange.ts:761`, `:849`, `:982`, `:1050`) never read it; `StoreMeta` `Omit`s it. Every live read there is off something else — `entry.` (`DocEntry`, whose own comment says "All schema hashes **this peer** supports"), `bound.` (`BoundSchema`), `info.` (`DocReadyInfo`) — none of which are `DocMetadata`.

It has exactly one live consumer, and it proves the point rather than weakening it: `@kyneta/transport`'s `PresentMsg` is `Array<{ docId } & DocMetadata>` (`messages.ts:94`), and the wire codec reads `.supportedHashes` off it (`alias-table.ts:266-267`). A `present` is the one place a document's identity and *the sender's declared range* travel together — so the field was never document metadata there either; it was a peer's declaration riding inside a type that claimed otherwise. `PresentMsg` should declare it itself, optional, exactly as `DocEntry` and `DocReadyInfo` already do, because on the wire it is omitted whenever it would say nothing beyond `schemaHash`.

With that distinction in hand, the four sites sort cleanly:

| Site | Question it asks | Law it uses | |
| --- | --- | --- | --- |
| `capabilities.ts:263-278` — `resolveSchema` | interpretation | `supportedHashes.has(h)` | ✅ correct |
| `sync-program.ts:1154-1221` — `present`, known doc | sync | set intersection | ✅ correct |
| `exchange.ts:1049-1060` — `registerSchema`'s sweep | interpretation | **exact equality** | ❌ |
| `exchange.ts:759-772` — `#getImpl`, deferred | interpretation | **exact equality**, warn only | ❌ |

**Three sites ask the interpretation question; one asks the sync question. Both existing correct implementations are already correct.** The defect is that the two remaining sites use exact equality — a law that answers neither question — and that nothing anywhere names the two laws, so the distinction has to be rediscovered at every call site.

The other two axes have no such split. `replicaType` and `syncMode` mean the same thing to both questions, and there the scatter is plain duplication: `replicaTypesCompatible` (`substrate.ts:685`) is re-inlined at `exchange.ts:1055-1056`, and the three-field `SyncMode` comparison is hand-written twice (`exchange.ts:1057-1059`, `sync-program.ts:1205-1207`).

Two bugs follow.

**Bug A — promotion depends on when the schema was registered.** Reproduced. Alice binds `V1 = struct({ zip })`; Bob binds the migrated successor `V2 = struct({ postalCode }).migrated(Migration.rename("zip", "postalCode"))`, whose `supportedHashes` contains V1's hash while its own primary hash differs. Two peers over a `Bridge`, identical in every way except when Bob calls `registerSchema(V2)`:

```
bob.registerSchema(V2) before alice.get("doc-1", V1)  →  bob.deferred = []
bob.registerSchema(V2) after  alice.get("doc-1", V1)  →  bob.deferred = ['doc-1']
```

The second stays deferred permanently — `registerSchema` is the only thing that ever re-examines deferred documents, and it has already run. The `before` path goes through `resolveSchema` and its membership test; the `after` path goes through the sweep and its exact comparison. Same schema, same document, opposite outcome from ordering alone.

**Bug B — `resolveSchema` matches a collapsed `SyncMode`.** `replicaKey` (`capabilities.ts:65`) routes `SyncMode` through `syncModeName` (`:50-54`), which returns `"authoritative"` for any `writerModel === "serialized"` regardless of `delivery` or `durability`. Two genuinely different modes share a bucket, so a successful `resolveSchema` does **not** imply the modes agree.

**Corrected during implementation: this is not reachable, and the fix is hardening rather than a bug fix.** The wire collapses `SyncMode` exactly the same three ways — `syncModeToWire` (`wire/src/wire-types.ts:161-165`) — and the decode side maps that enum back to one of the three stock constants (`alias-table.ts:405`). `resolveSchema`'s only caller is `onEnsureDoc` (`exchange.ts:440`), so its `syncMode` argument has always been wire-decoded and can only ever be one of three values. A custom mode from `createBindingTarget` can be built locally but can never *arrive*. `replicaKey`'s granularity is therefore not a lossy shortcut; it matches the wire's own data model exactly.

Verifying after lookup is still worth doing — it moves the guarantee into the function instead of leaving it to an invariant enforced three layers away in a codec — but the claim to make is "`resolveSchema` no longer depends on its caller having come through the wire", not "this fixes a live defect". The finding itself is worth more than the fix: **only the three stock modes are network-expressible**, which is a real constraint on `createBindingTarget` users and was written down nowhere.

## Scattering 2: three doors reach interpretation, three different rule sets

| Entry point | Source | Rules applied |
| --- | --- | --- |
| `#getImpl` — a caller named this document | `exchange.ts:741` | rejects suspended; rejects replicate; for deferred, warns on `schemaHash` divergence and promotes anyway; ignores `replicaType` and `syncMode`; checks `BoundSchema` object identity |
| `onEnsureDoc` step 1 — a peer's `present` resolved to a local schema | `exchange.ts:431-448` | none. Calls `#interpretDoc` directly, bypassing every guard above |
| `registerSchema`'s sweep — a new schema matched a deferred document | `exchange.ts:1043-1065` | the triple, exactly, and silently skips otherwise |

Three differences fall out. Two are defensible; one is a gap.

- **Defensible — the named path promotes a deferred document despite a `schemaHash` divergence.** The existing warning states the policy ("Local schema is authoritative, but this indicates protocol disagreement"). It is worth keeping, though not for the reason the warning gives — see "One policy, at one call site".
- **Defensible — `onEnsureDoc` checking nothing.** It looks like the worst offender and is nearly excused: `resolveSchema` has already matched — though, per Bug B, not on all three axes. What it genuinely misses is the document's own *phase*.
- **The gap — `replicaType` and `syncMode` on the named path.** These are not interpretation choices. They decide whether two peers can exchange bytes at all, not how those bytes are read. No amount of caller intent makes an incompatible replica format decodable — yet the named path never asks, while the sweep refuses on either.

The line that separates the first bullet from the third: **`schemaHash` is about interpretation, and a caller who named a document is entitled to its own view of it; `replicaType` and `syncMode` are about interoperability, and nobody is entitled to a view that cannot sync.**

## One policy, at one call site

That asymmetry is real, but it is a *policy* held by one caller — not a rule about document phases. It belongs in the shell, not in the classifier.

The obvious design threads an `intent: "named" | "blanket"` parameter through the predicate so it can answer differently per caller. Resist it. Checking what that parameter actually buys:

- **No test covers the behaviour it preserves.** Nothing asserts on `"Promoting deferred"` or `"Local schema is authoritative"`; the only two `console.warn` spies in `exchange.test.ts` (`:1316`, `:1427`) are lineage-boundary regression coverage.
- **The behaviour produces a document that cannot sync.** After promotion the document enters the sync model with the local hash set; when the peer's `present` arrives, `sync-program.ts:1188-1201` emits `schema-hash-mismatch` and skips. `sync-invariants.test.ts:462` already asserts exactly that outcome.

So the behaviour looks deletable — but it is not, for a reason neither bullet shows: **a deferred document arrived from a peer, so refusing would let a remote peer break a local `get()` by announcing a colliding `docId` with a different schema.** Keeping the promotion is defensive, not permissive.

Keep it, then, but keep it where it is true: in `#getImpl`, the one caller that holds it. The pure function reports *facts* — the phase, and which axis disagrees. The shell applies *policy*. This is the same split `planInitialization` already uses for `authority`, and it costs four lines at one call site instead of a parameter, five extra truth-table rows, and two extra union arms threaded through three consumers.

## The rule

> **`get()` refuses only when the request cannot be reconciled with what the document already is — never merely because of what phase the document is in.**

Mismatch (`replicaType`, `syncMode`, `schemaHash`, `BoundSchema` identity) → refuse. Phase (`deferred`, `replicate`, `interpret`) → raise or return. Suspension → not `get()`'s business at all.

## Why this is smaller than it looks

Five facts found in the code, each of which removes an objection:

1. **Both laws already exist, each correct at one site.** `resolveSchema` implements interpretation; `sync-program.ts` implements sync. Nothing here is new design — it is naming two laws that are already written, and giving the two remaining sites the one they are asking for.
2. **`DocMetadata` is already the canonical shape** (`packages/schema/src/substrate.ts:753-764`: `replicaType`, `syncMode`, `schemaHash`, `supportedHashes`). Every phase can produce one — a `replicate` entry holds them in its `readyInfo` (`runtime.ts:869-876`) _locally_, where the deferred path must ask the synchronizer for a remote, advisory fact.
3. **`replicaTypesCompatible` already exists** (`substrate.ts:685`, exported at `index.ts:505`, used at `sync-program.ts:1159`). Two sites re-inline it.
4. **`Diagnostic`'s `Comparison` shape is already what a mismatch produces** (`types.ts:82-86`: `{ local: string, remote: string }`), and `DiagnosticCode` already names the three axes. The vocabulary is written; only the producer is duplicated.
5. **Promotion is the ordinary construction path.** All four substrate backends implement `SubstrateFactory.upgrade`, and all four define `create(schema)` as `upgrade(createReplica(), schema)` — `plain.ts:1150`, `ephemeral.ts:571`, `backends/loro/src/substrate.ts:872`, `backends/yjs/src/substrate.ts:721`. (Those four backends are also why the `replicaType` gap is a live hazard rather than theoretical: `plain`, `ephemeral`, `loro`, and `yjs` are four distinct formats, and the named path checks none of them.)

Discovered while investigating a crash in `Source.fromExchange` (`PLAN-2026-08-03-index-exchange-source`), which called `get()` on a replicate document. That plan is unblocked by this one and should land after it — see Transitive Effect Analysis.

# Problem Statement

**1. `Runtime.get()` silently destroys a replicate document's state.** `createInterpretDoc` (`runtime.ts:758`) returns early only for `mode === "interpret"`. A `replicate` entry falls past that check into the construction path, which ends in an unconditional `this.#docCache.set(docId, entry)` (`runtime.ts:800`) — replacing the replicate entry, and the accumulated `Replica` with it, with a fresh empty substrate. Reproduced:

```
runtime.replicate("doc-b", plainReplicaFactory, SYNC_AUTHORITATIVE, hash)
runtime.get("doc-b", Doc)     // entry mode replicate → interpret, accumulated state gone
```

Silent data loss with no signal, for exactly the participants `replicate` exists to serve: relays and audit-log peers. The `Exchange` is protected only because it throws first; a standalone `Runtime` is not.

**2. `Runtime.get`'s docstring promises a check the code does not perform.** `runtime.ts:433-434`: "Calling with a different `BoundSchema` for the same `docId` throws." `createInterpretDoc` returns `cached.ref` for any interpret entry without looking at `bound`. Only the `Exchange` enforces this (`exchange.ts:775`).

**3. Two compatibility laws, unnamed, and two sites using neither** — Scattering 1. Bug A makes promotion depend on schema-registration order; Bug B lets `resolveSchema` match a `SyncMode` bucket rather than a `SyncMode`.

**4. Three doors, three rule sets** — Scattering 2. `onEnsureDoc` reaching `#interpretDoc` directly means a network event can enter interpretation without passing any of the guards a direct caller must pass, and `#getImpl` never checks the two interoperability axes at all.

**5. `get()` throws for suspended documents, contradicting the documentation three times.** `TECHNICAL.md:313` ("always a `Ref<S>`"), §"Suspend vs destroy" (`:319` — "`exchange.get(docId)` re-hydrates"), §"What `suspend` is NOT" (`:328` — "`resume` **or `get`** restores it"). Meanwhile `Runtime.createInterpretDoc` has no `suspended` check at all, so a standalone `Runtime` already returns the ref _and preserves the suspension_. Suspend and resume are Runtime concepts (`runtime.ts:526`, `:544`) that the Exchange only delegates to via hooks. The Exchange's throw is a guard layered on a shell that had already answered the question. Removing it is a subtraction.

# Success Criteria

1. The two compatibility laws are named and documented, the derived one is visibly derived from the primitive, and the types say which question each answers: a **reader** carries `supportedHashes`, a **document** does not.
2. Swapping the arguments of the directional law is a compile error, not a silent inversion.
3. `DocMetadata` no longer carries a field nothing populates or reads, and `StoreMeta`'s `Omit` workaround is gone.
4. `BoundSchema` can state its own replica format, so no code anywhere constructs a substrate factory to read one — and `get()` on an already-interpreted document still allocates nothing.
5. Every comparison site uses the law matching the question it asks. No hand-inlined `SyncMode` comparison and no re-inlined `replicaTypesCompatible` survives, and exactly one `?? [schemaHash]` remains — at the wire boundary, not inside a law.
6. Whether a deferred document is promoted no longer depends on when its schema was registered — verified by a single test asserting both orderings agree.
7. A successful `resolveSchema` genuinely implies all three axes agree, and its hash behaviour is **unchanged** (it was already right).
8. One pure function decides what `get()` does about a document's phase, and all three interpretation doors consult it. It takes **no** caller-identity parameter: every branch is a fact about the document, and the one policy that varies by caller lives at that caller.
9. `get()` refuses only an irreconcilable request — never because a document is `deferred`, `interpret`, or suspended. `replicate` is the one phase still refused, deliberately and named as `"unsupported"` rather than as a mismatch, so the exception is legible in the type. Refusals carry which axis failed, as structured data rather than prose.
10. `Runtime.get()` cannot destroy a replicate document's accumulated state.
11. `exchange.get()` on a suspended document returns the ref **and leaves the document suspended**.
12. Every rule is a row in a truth table with a test, not a branch reachable only from a live multi-peer scenario.
13. **The suite is green at every revision in the stack**, and the three no-op revisions (Phases 3, 4, 7) require *no edits to existing tests* — that is how their claim of "changes nothing" is checked.
14. No TECHNICAL.md names a symbol that no longer exists, and each documentation change lands in the revision that makes it true.

# How this lands: ten revisions

One claim per revision, and the kind alternates deliberately so a reviewer knows what they are getting before opening the diff.

| Phase | Revision summary | Behaviour | Review criterion |
| --- | --- | --- | --- |
| 1 | `fix(exchange): Runtime.get refuses to clobber a replicate document` | changes | the entry survives the throw |
| 2 | `fix(exchange): Runtime.get enforces the BoundSchema check its docs promise` | changes | guard is on `get`, not the shared path |
| 3 | `feat(schema): name the two schema-compatibility laws` | **none** — no consumers yet | is the law right? |
| 4 | `refactor(exchange): sync-program uses mismatchForSync` | **none** | existing diagnostic tests pass unedited |
| 5 | `fix(exchange): resolveSchema verifies the full triple after bucket lookup` | changes | the document becomes deferred, not merely unresolved |
| 6 | `fix(exchange): promotion no longer depends on schema-registration order` | changes | the order-invariance test |
| 7 | `refactor(exchange): one predicate for interpretation` | **none** | suspended throw still present; no test edits |
| 8 | `fix(exchange): get() checks replica type and sync mode before promoting` | changes | the named path asks the same question as everyone else |
| 9 | `refactor(exchange)!: get() returns suspended documents without resuming` | changes | suspension survives the `get()` |
| 10 | `docs: retire symbols removed in 3.0` | none | independent of everything above |

Phases 4, 5 and 6 all depend on Phase 3 and not on each other, so they can be **reordered** freely among themselves. Only Phase 4 can be *dropped* — nothing downstream reads `mismatchForSync`. Phase 7's no-op claim rests on both 5 and 6 having landed (Task 7.2 relies on `resolveSchema` matching completely; Task 7.3 on the sweep already using the right law), so dropping either turns Phase 7 into a behaviour change. Phase 10 can land anywhere. Everything else is a chain.

Documentation is **not** a phase. Each doc edit rides in the revision that makes it true, so no intermediate revision has docs contradicting its code.

# ✅ Phase 1: `Runtime.get` refuses to clobber a replicate document

Smallest change here and independent of everything below. Land it first so it can be reasoned about — and reverted — on its own.

- ✅ Task 1.1: In `Runtime.createInterpretDoc` (`runtime.ts:758`), extend the early-return check so a `replicate` entry throws instead of falling through to construction.

  Use the same message the Exchange already uses (`exchange.ts:753-756`), so the two layers say the same thing about the same situation. Whether `get()` should eventually _promote_ a replicate document is a separate question (Alternatives Considered); refusing is correct under either answer, and clobbering is correct under neither.

- ✅ Task 1.2: Comment the `#docCache.set` at `runtime.ts:800` with why the early return above it is load-bearing: it is the only thing standing between a replicate entry and an unconditional overwrite. The comment is the guard rail for whoever next adds a mode.

- ✅ Task 1.3: Test in `packages/exchange/src/__tests__/runtime.test.ts`: `runtime.replicate(id, …)` then `runtime.get(id, bound)` throws, **and the entry is still in replicate mode afterwards with its replica intact.**

  Asserting the entry survives is the point. Asserting only the throw would pass against a version that throws *after* clobbering.

# ✅ Phase 2: `Runtime.get` enforces the `BoundSchema` check its docs promise

- ✅ Task 2.1: Add the check to `Runtime.get` (`runtime.ts:440`) — **not** to `createInterpretDoc`.

  The placement is the whole point. `createInterpretDoc` is shared: the Exchange reaches it from `#interpretDoc`, called both by a named `get()` and by the `onEnsureDoc` network path. A caller-ergonomics guard belongs on the door a caller knocks on, not on the shared corridor behind it. This mirrors where the Exchange puts the same check (`exchange.ts:775`).

- ✅ Task 2.2: `runtime.ts` — the `get` docstring (`:433-434`) now describes implemented behaviour. Verify the wording matches, and add one line noting that `createInterpretDoc` is the shared path used by the Exchange's network route and deliberately does not apply the same guard.

- ✅ Task 2.3: Tests in `runtime.test.ts`: `get(id, boundA)` then `get(id, boundB)` throws; `get(id, boundA)` twice returns the identical ref. The second guards against this task over-reaching into the shared path.

# ✅ Phase 3: Name the two schema-compatibility laws

Pure addition to `@kyneta/schema`. No consumers yet, nothing changes behaviour — so review is entirely "is the law right?", which is the question worth isolating.

- ✅ Task 3.1: Split `DocMetadata` by role, in `packages/schema/src/substrate.ts` (`:749-765`).

  ```ts
  /**
   * What a document IS — the three facts every peer must agree on before any
   * bytes can be exchanged: how it is encoded, how it syncs, what shape it holds.
   *
   * Comes off the wire, out of a store, or out of the synchronizer model.
   */
  export type DocMetadata = {
    readonly replicaType: ReplicaType
    readonly syncMode: SyncMode
    readonly schemaHash: string
  }

  /**
   * What a peer CAN READ — a document's own facts, plus every ancestor shape
   * its schema reaches by walking migration chains backwards.
   *
   * `supportedHashes` is required, not optional, and that is load-bearing: a
   * read capability is always derived locally from a `BoundSchema`, whose
   * `supportedHashes` is a required `ReadonlySet` (`bind.ts:150`). It never
   * comes off the wire, so it is never absent. Requiring it is what lets the
   * compiler tell a reader from a document — see `mismatchForInterpretation`.
   */
  export type ReadCapability = DocMetadata & {
    readonly supportedHashes: readonly string[]
  }
  ```

  **The `supportedHashes` field is removed from `DocMetadata`, not moved.** It is dead there — never populated by `getDocMetadata`, never read by any of its four consumers, `Omit`ted by the one type derived from it. Deleting it costs nothing at runtime and repays immediately: `StoreMeta` (`store/store.ts:39`) becomes `DocMetadata` exactly, so its `Omit` and the paragraph explaining the `Omit` both go.

  Nothing else inherits the field. `DocReadyInfo` (`runtime.ts:89`), `DocEntry` (`sync-program.ts:62`), and the wire message types each declare their own `supportedHashes`, so the blast radius stops at `DocMetadata`'s ~13 annotation sites.

  Fix the declaration comment while there: it currently claims uses in "StorageBackend, PresentMsg, DocEntry, cmd/ensure-doc, and onDocDiscovered", and those types re-declare the shape rather than importing it.

- ✅ Task 3.2: Add the two hash laws, beside `replicaTypesCompatible` (`:685`).

  ```ts
  /**
   * Can a peer with this read capability take on data written at `hash`?
   *
   * Directional: `supportedHashes` is computed by walking migration chains
   * backwards, so a newer schema reaches its ancestors' shapes and never the
   * reverse. This is the question `exchange.get()` asks.
   *
   * The set is currently the theory's `nativeSupports` — "can op-stream sync
   * at" — which is *narrower* than "can read". `computeSupportedHashes` halts
   * the walk at a T2 step precisely to keep it that way. So this predicate is
   * conservative: it can refuse a shape that entirety-only reading would in
   * fact recover. That is the safe direction, and it is what `resolveSchema`
   * has always done. When the deferred `readSupports` / `nativeSupports` split
   * lands, **this** law moves to `readSupports` and `hashesIntersect` stays on
   * `nativeSupports`.
   */
  export function supportsHash(reader: ReadCapability, hash: string): boolean {
    return reader.supportedHashes.includes(hash)
  }

  /**
   * Is there a shape both peers can take on?
   *
   * Symmetric, and *derived*: sync compatibility is interpretation
   * compatibility at some shape they share. This is the question the sync
   * program asks when a `present` arrives for a document it already holds.
   */
  const hashesIntersect = (a: ReadCapability, b: ReadCapability): boolean => {
    // Set for the membership side, matching what sync-program.ts:1177-1180
    // already did. The sets are bounded — `computeSupportedHashes` is a
    // cartesian product over chains, "dozens" per the
    // computeSupportedHashes docstring (migration.ts:1217) — but the
    // incumbent chose O(1) lookup deliberately
    // and this derivation should not quietly make it O(n·m).
    const reachable = new Set(a.supportedHashes)
    return b.supportedHashes.some(h => reachable.has(h))
  }
  ```

  Writing `hashesIntersect` in terms of `supportsHash`'s *relation* rather than as an independent set operation is the point of the pair: it puts the connection between the two laws in the code instead of in a comment. One primitive, one derivation. (`hashesIntersect` inlines the membership test only to keep the `Set`; the law it applies is `supportsHash`'s, and a comment should say so.)

  Note what is **not** here: no `?? [schemaHash]` fallback. With `ReadCapability` requiring the set, there is nothing to default. That fallback was load-bearing only because the types were wrong; the one place a sparse wire value still needs normalising is Task 4.1, at the boundary where it arrives.

  Also not needed: a guard for "does a schema support its own hash?" `reachableShapes` seeds its walk with `[schema]` before stepping backwards (`migration.ts:1241`), so a reader's own hash is always in its set and a migration-free schema degrades exactly to equality.

  `hashesIntersect` stays module-private: it has one consumer, `mismatchForSync`, which is its public face and carries its whole meaning. `supportsHash` is exported — it is the primitive the design rests on, the one `packages/schema/TECHNICAL.md` names, and directly answerable on its own ("can I read this?"). Export primitives and public faces, not intermediate derivations.

- ✅ Task 3.3: Add the two comparisons, same file.

  ```ts
  /** Which axis of a document's metadata failed to line up. */
  export type MetadataAxis = "replicaType" | "schemaHash" | "syncMode"

  export type MetadataMismatch = {
    readonly axis: MetadataAxis
    /** The two values that disagreed, rendered. */
    readonly local: string
    readonly remote: string
  }

  /** Can `reader` interpret `doc`? Returns the first axis that says no. */
  export function mismatchForInterpretation(
    reader: ReadCapability,
    doc: DocMetadata,
  ): MetadataMismatch | undefined

  /** Can these two peers sync? Returns the first axis that says no. */
  export function mismatchForSync(
    a: ReadCapability,
    b: ReadCapability,
  ): MetadataMismatch | undefined
  ```

  **The signatures do the work three comments used to.**

  *The direction is compiler-enforced.* `mismatchForInterpretation`'s parameters are different types, and a bare `DocMetadata` is missing `ReadCapability`'s required `supportedHashes` — so swapping the arguments fails to compile rather than silently inverting a directional law. That was the single most dangerous thing available to get wrong.

  *The unread field is unrepresentable.* `doc` is a `DocMetadata`, so `doc.supportedHashes` does not exist to be misused. Nobody can later "fix" the interpretation law into an intersection, because the type gives them nothing to intersect with.

  *`mismatchForSync` takes two readers*, which is what its only call site actually holds — a `DocEntry` and a decoded message, both carrying live sets.

  Two exported names rather than one function with a `law: "interpret" | "sync"` flag — the same reasoning that keeps `intent` out of `planInterpretation`. A flag makes one function answer two questions and lets the call site stop saying which one it is asking.

  They share everything except the hash axis:

  | Axis | Law | Same for both? | Lifted from |
  | --- | --- | --- | --- |
  | `replicaType` | name and major equal; minor tolerated | yes | `replicaTypesCompatible` (`substrate.ts:685`) |
  | `schemaHash` | `supportsHash(reader, doc.schemaHash)` / `hashesIntersect(a, b)` | **no** | `capabilities.ts:276` / `sync-program.ts:1177-1187` |
  | `syncMode` | `writerModel`, `delivery`, `durability` all equal | yes | hand-inlined at `exchange.ts:1057-1059`, `sync-program.ts:1205-1207` |

  Factor the two shared axes into one private helper so the pair cannot drift; keep the hash axis inline in each so the difference is visible where a reader looks for it.

  Check `replicaType` first, matching the sync program's existing order. If the bytes cannot be decoded at all, reporting a hash disagreement misleads the reader about what actually went wrong. Return the **first** mismatch — every existing call site stops at the first failure.

  **Both laws check all three axes, for two different reasons, and each docstring should say its own.** Left unsaid, the `syncMode` axis reads as an intruder in a function named for interpretation, and the next contributor drops it — reopening the gap Phase 8 exists to close.

  *For interpretation, the three axes are the admission preconditions of a tier.* "Interpret" here is `mode: "interpret"`, not the act of decoding bytes — the tier the codebase names alongside replicate ("the conduit tier", `packages/exchange/TECHNICAL.md:835`) and deferred. What a document must supply to enter it is not a matter of opinion: it is `DocReadyInfo` (`runtime.ts:82-90`), whose three compatibility-bearing fields are `replicaFactory` (→ `replicaType`), `syncMode`, and `schemaHash`. One axis per precondition — construct a substrate, register for sync, bind a schema. The law is the struct's admission requirements, restated as a predicate.

  *For sync, the three axes are the triple two peers must share to exchange ops at all.* Different justification, same fields, and it is the one `sync-program.ts` has always applied.

  One more thing worth a line, because it looks like a vocabulary slip and is not: `MetadataMismatch`'s `local` / `remote` is peer vocabulary, yet the interpretation law compares a reader to a *document*. It fits because the document operand is remote-sourced at every call site — `resolveSchema`'s comes off a `present`, the sweep's comes from `getDocMetadata` → the sync model → a `present`, and `planInterpretation` only ever sees a deferred document, which exists *because* a peer announced it. There is no local-only path that produces a `MetadataMismatch`.

- ✅ Task 3.4: Give `BoundSchema` the `replicaType` it has always been missing, then add `metadataOf` as a one-argument projection.

  ```ts
  // bind.ts — BoundSchema gains one field
  readonly replicaType: ReplicaType

  // and the projection becomes total and pure
  export function metadataOf(bound: BoundSchema): ReadCapability
  ```

  **The field is not new information — it is information already in hand and discarded.** `createBindingTarget`'s config carries `replicaFactory: ReplicaFactory` (`bind.ts:450`), which has `.replicaType`, and then drops it when calling `bind()` three lines below (`:454-459`). Every binding target funnels through there — `json` (`:481`), `ephemeral` (`:512`), `loro` (`bind-loro.ts:166`), `yjs` (`bind-yjs.ts:165`) — and `bind({...})` has exactly one production caller. So `bind()` gains a required `replicaType` and `createBindingTarget` supplies `config.replicaFactory.replicaType`. Nothing has to be derived.

  The absence was an asymmetry, and naming it is the justification: **`BoundReplica` is `{ factory, syncMode }` and can tell you its replica format; `BoundSchema` describes the same binding and could not.** `replicaType` is a property of *the binding* — this schema, this substrate family, this sync mode — not of a built instance. It does not vary by `peerId`, which is exactly why reaching it through a `peerId`-taking factory builder was the wrong shape.

  What the field deletes, beyond making this task's own signature honest:

  - `registerSchema` (`exchange.ts:1044-1048`) constructs an entire substrate factory to read one static tuple. Phase 6 removes it.
  - It removes the need for the Exchange to memoise anything. `createInterpretDoc` returns a cached ref *before* it builds a factory (`runtime.ts:762-766`), so `get()` on an already-interpreted document constructs nothing today; a shell that had to build a `ReadCapability` to call `planInterpretation` would have started building a factory on that hottest path, to answer a question it never asks. With `bound.replicaType` there is nothing to build, so nothing to accidentally build in the wrong place.

  A `WeakMap<BoundSchema, ReadCapability>` memo would also have solved the second point, and it was the plan's previous answer. It was the wrong tool: a side table is the right shape for per-object state on an object you *cannot change* — which is why `settleTerms` (`settle.ts:105`) and `syncRefMap` exist, annotating refs the schema layer creates. Here the object is ours. When you own the type, a side table is a workaround for a missing field.

  `metadataOf` returns a `ReadCapability`, not a `DocMetadata`, and that is the whole reason the compiler can enforce direction downstream: a `BoundSchema` is exactly a reader, and `bound.supportedHashes` is a required `ReadonlySet<string>` (`bind.ts:150`), so the projection is total. (It also handles the container difference — `ReadonlySet<string>` in, `readonly string[]` out.) It lives in `bind.ts` rather than `substrate.ts` because it is a projection *of* `BoundSchema`, and `bind.ts` already depends on `substrate.ts` and not the reverse.

  Update the direct `bind({...})` call sites in tests — `exchange.test.ts`, `migration.test.ts`, `bind.test.ts`, `ephemeral-decay.test.ts`, ~18 in total. Mechanical: one field, and the value is whichever `replicaFactory.replicaType` that test's factory already implies.

- ✅ Task 3.5: Update `packages/exchange/src/store/store.ts` — `StoreMeta` is now `DocMetadata` exactly. Alias it (`export type StoreMeta = DocMetadata`) and delete the `Omit` along with the paragraph explaining why the field was excluded, since the type no longer has a field to exclude. This is the plan's one straight deletion of a workaround.

  **Alias, do not retire the name.** `StoreMeta` is a public export (`exchange/src/index.ts:240`) and `@kyneta/postgres-store` imports it (`stores/postgres/src/index.ts:20`, used at `:247-248`). Removing it would break a sibling package for no gain; the alias keeps the storage layer's own vocabulary while the shape becomes shared.

- ✅ Task 3.6: Export from `packages/schema/src/index.ts` — `ReadCapability`, `supportsHash`, `mismatchForInterpretation`, `mismatchForSync`, `metadataOf`, `MetadataAxis`, `MetadataMismatch`. (`DocMetadata` is already exported at `:479`; `hashesIntersect` deliberately is not.) Without this every later phase fails to compile.

  Add the three type names and `supportsHash` to the canonical-symbols line at `packages/schema/TECHNICAL.md:7`. That line is selective — `replicaTypesCompatible` and `DocMetadata` are absent from it today — but a plan whose thesis is "name the two laws" should put the names in the document whose job is naming.

- ✅ Task 3.7: `packages/schema/TECHNICAL.md` — document the two laws under the existing §`supportedHashes` (`:1109`), which already describes the set but not the two questions asked of it.

  State the directional/symmetric split; that `hashesIntersect` is derived from `supportsHash`; and which caller asks which. Then state the type-level claim, because it is the part a reader cannot infer from the prose: **`DocMetadata` is what a document is; `ReadCapability` is what a peer can read; `supportedHashes` belongs to the second and never the first.** Note that the required-ness of `ReadCapability.supportedHashes` is deliberate and is what makes the interpretation law's direction a compile error rather than a comment.

  Two further things belong here because they are the answers to questions this section currently provokes and does not settle:

  - **Which set is this?** Today, `nativeSupports` — the section's own T2-halt paragraph (`:1117`) says so, and its deferred-split paragraph (`:1122`) says the other one is coming. Write down that `supportsHash` is therefore conservative for a read question, that this is the safe direction, and that the split's arrival moves `supportsHash` to `readSupports` while leaving `hashesIntersect` where it is. A reader who finds these two paragraphs adjacent should not have to infer the consequence.
  - **Why do both laws check three axes?** Because "interpret" is a tier, not an act: the three axes are exactly `DocReadyInfo`'s three compatibility-bearing fields (`packages/exchange/src/runtime.ts:82-90`), one per admission precondition. For sync, the same three are the triple two peers must share. Same fields, two justifications — and stating both is what stops the `syncMode` axis reading as an intruder in a function named for interpretation.

  Say that `MetadataAxis` is deliberately *not* `DiagnosticCode`: schema names the axes, exchange names the diagnostics, and the mapping between them is the layer boundary.

- ✅ Task 3.8: Tests in `packages/schema/src/__tests__/doc-metadata.test.ts` (new). Pure — plain objects in, one result out. The cheapest and highest-value tests in the plan, because four call sites will depend on them.

  - Each axis mismatches independently, and the returned `axis` names it.
  - Order: when `replicaType` and `schemaHash` both disagree, the result is `replicaType`.
  - Minor-version drift in `replicaType` is compatible; major is not.
  - All three `SyncMode` fields are compared: two modes differing only in `durability` mismatch. This is the case `replicaKey` bucketing collapses, and the reason Phase 5 exists.
  - **The two laws diverge where they should.** A reader with `{H2a, H1}` against a document at `H2b`, and a peer whose capability is `{H2b, H1}`: `mismatchForSync` finds no mismatch (they share `H1`), `mismatchForInterpretation` reports `schemaHash` (the reader has never heard of `H2b`). One test, both calls, opposite results — this is the whole reason there are two functions, and it should fail loudly if anyone merges them.
  - Membership is directional: a newer reader interprets an older document; an older reader does not interpret a newer one.
  - A reader whose `supportedHashes` is the singleton `[schemaHash]` — the shape a migration-free schema produces — interprets exactly documents at that hash.

  No test for absent `supportedHashes`: the type makes it unrepresentable on the reader side, and the document side has no such field. That deleted test case is the clearest measure of what the split bought.

# ✅ Phase 4: `sync-program` uses `mismatchForSync`

Behaviour-preserving. The claim is "this deletes code and changes nothing", and the check is that no existing test needs editing.

- ✅ Task 4.1: Rewire `sync-program.ts:1154-1221`. Three near-identical ~20-line blocks become one `mismatchForSync` call and one emit.

  Both operands are `ReadCapability`, and the remote one has to be built: a `present` omits `supportedHashes` when it carries nothing beyond the primary hash (`sync-program.ts:505-507`), so normalise at the boundary —

  ```ts
  const remote: ReadCapability = {
    replicaType, syncMode, schemaHash,
    supportedHashes: remoteSupportedHashes ?? [schemaHash],
  }
  ```

  This is the plan's only surviving `??`, and it is in the right place: sparseness is a transport concern, so it is resolved where transport meets the domain rather than inside the law. Same treatment `establish`'s `protocolVersion` already gets — "sparse on the wire… defaulted at the inbound transform" (`packages/exchange/TECHNICAL.md:207`). The local operand needs no such handling; `docEntry.supportedHashes` is stored from the same normalisation and `?? [docEntry.schemaHash]` applies identically.

  Be precise about what is deleted: **the three comparisons merge; the three messages do not.** `sync-program.test.ts` asserts three distinct phrasings (`"replica type mismatch"` at `:641`, `"schema hash mismatch"` at `:668`, `"syncMode mismatch"` at `:790`), so `describeMismatch` is a three-branch switch. That is relocation, not simplification — fine, the templates belong together, but do not expect the line count to fall on their account.

- ✅ Task 4.2: Add the axis → diagnostic-code mapping in `@kyneta/exchange`. `@kyneta/schema` must not learn about `DiagnosticCode`:

  ```ts
  const MISMATCH_CODE = {
    replicaType: "replica-type-mismatch",
    schemaHash: "schema-hash-mismatch",
    syncMode: "sync-mode-mismatch",
  } as const satisfies Record<MetadataAxis, DiagnosticCode>
  ```

  Three entries, and `satisfies` turns "added an axis, forgot the code" into a compile error. `MetadataMismatch`'s `local` and `remote` are already exactly `Comparison`'s shape (`types.ts:82-86`), so the diagnostic effect is assembled directly from the mismatch.

- ✅ Task 4.3: No new tests. The existing per-axis diagnostic assertions must pass **byte-for-byte and unedited** — same `code`, same `local`/`remote`, same `severity`, same message text. This refactor is the one place in the stack where a silent behaviour change would be easy and invisible, and "the tests did not need touching" is the evidence. If a message must change, that is a finding to raise, not a diff to absorb.

# ✅ Phase 5: `resolveSchema` verifies the full triple after bucket lookup

- ✅ Task 5.1: Fix `resolveSchema` (`capabilities.ts:263-278`) by verifying after lookup, not by unifying it away.

  `resolveSchema` is an indexed lookup, not a comparison, and its coarse `replicaKey` bucket is what makes it O(1). Do not throw that away. Keep the key as an index and confirm the hit against the exact law:

  ```ts
  const candidate = entry.schemas.get(schemaHash) ?? /* supportedHashes fallback */
  if (!candidate) return undefined
  return mismatchForInterpretation(
    metadataOf(candidate),                  // reader
    { replicaType, syncMode, schemaHash },  // doc, from the three params
  )
    ? undefined
    : candidate
  ```

  Note the document operand is built inline from `resolveSchema`'s three parameters. That is not a shortcut — it is the whole of what a document is, and `resolveSchema` was never given a fourth. The remote's `supportedHashes` reaches `onEnsureDoc` and is discarded there (`exchange.ts:437`, `_supportedHashes`); after Task 3.1 that is visibly correct rather than merely unexplained, because the interpretation law has no parameter to put it in.

  Index for speed, law for correctness — two jobs that had been conflated into one string key. No factory construction is needed: `entry.replica` is a `BoundReplica` and its `factory.replicaType` is directly available.

  **Its hash behaviour does not change.** `resolveSchema` was already asking the interpretation question with the right law; `mismatchForInterpretation` is that law by another name. What changes is that `replicaType` and `syncMode` are now compared exactly rather than through the collapsed bucket key. That is Bug B, and it is the whole of this revision.

  It also earns something Phase 7 depends on: after this, "a successful `resolveSchema` implies all three axes agree" is *true*, so `onEnsureDoc` can rely on it honestly rather than by assumption.

- ✅ Task 5.2: Test in the capabilities/classification suite: `resolveSchema` declines a candidate whose `SyncMode` shares a `replicaKey` bucket but differs on `durability`.

  Assert the **consequence**, not just the return value. When `resolveSchema` declines, `onEnsureDoc` falls through to step 2 and then step 4, which **defers** the document (`exchange.ts:466-470`). So the document silently changes category from interpreted to deferred. Asserting only `undefined` would miss that.

# ✅ Phase 6: Promotion no longer depends on schema-registration order

- ✅ Task 6.1: Rewire `registerSchema`'s sweep (`exchange.ts:1049-1060`) to `mismatchForInterpretation`, replacing the hand-inlined triple.

  Frame this correctly in the commit message and the code comment: the sweep is not gaining the sync program's richer comparison. **It is adopting `resolveSchema`'s law, because it is asking `resolveSchema`'s question** — "should this local schema interpret this deferred document?" The two paths existed to answer the same question and disagreed; now they do not.

  Delete the factory construction above the loop (`exchange.ts:1044-1048`) while here. It builds an entire substrate factory to read `factory.replica.replicaType`, which Task 3.4 put on the `BoundSchema` directly. `metadataOf(bound)` replaces both lines and the loop keeps its single hoisted reader.

  Keep the sweep iterating `this.#runtime.deferred` only. **Do not extend it to replicate entries**, now or when promotion is implemented — see Alternatives Considered. Say so in a comment, because the natural instinct on reading a shared law is to widen the sweep to match.

- ✅ Task 6.2: `packages/exchange/TECHNICAL.md` §"Document classification on `present`" (`:249-260`) — the paragraph at `:260` describes the three-field validation. Point it at the two named laws and state the invariant this revision establishes: **every site asks the interpretation question with the same law, so promotion does not depend on schema-registration order.** That sentence is what a future contributor needs, because the bug it rules out is invisible from any single call site.

- ✅ Task 6.3: The order-invariance test in `exchange.test.ts`. The reproduction is already written; port it rather than inventing one.

  Alice binds `V1 = struct({ zip })`; Bob binds `V2 = struct({ postalCode }).migrated(Migration.rename("zip", "postalCode"))`. Assert the premise first — the primary hashes differ and `V2.supportedHashes` contains V1's — then run both orderings over a `Bridge` and assert `bob.deferred` is empty in **both**. Today the second ordering leaves `['doc-1']` deferred permanently.

  Write it as **one test over both orderings**, not two tests. The property is order invariance; two separate tests would let someone "fix" the failing one by matching the broken behaviour.

# ✅ Phase 7: One predicate for interpretation

Behaviour-preserving: after Phases 5 and 6 the two blanket doors already apply the right law, so routing them through a shared classifier changes nothing. `#getImpl` is deliberately left alone until Phase 8.

- ✅ Task 7.1: Add `packages/exchange/src/interpret.ts`. New file, matching the existing `doc-status.ts` / `initialize.ts` / `settle.ts` shape: pure function at the top, imperative shell consumers elsewhere.

  ```ts
  /** What `get()` should do about a document, given only local facts. */
  export type InterpretAction =
    | { action: "return-cached" }
    | { action: "create" }
    | { action: "promote"; from: "deferred" }
    | { action: "refuse"; kind: "mismatch"; mismatch: MetadataMismatch }
    | { action: "refuse"; kind: "unsupported"; from: "replicate" }

  export function planInterpretation(input: {
    /** The document's phase, or `"absent"` when nothing is cached. */
    phase: "absent" | "interpret" | "replicate" | "deferred"
    /** What the caller's BoundSchema can read. */
    reader: ReadCapability
    /** What is known about the document; `undefined` when nothing is. */
    doc: DocMetadata | undefined
  }): InterpretAction
  ```

  The two operands are named `reader` and `doc` so they pass straight into `mismatchForInterpretation(reader, doc)` with no re-labelling — and, after Task 3.1, with no way to reverse them. Do not name either one `requested`: the word describes the caller's side here and the document's side in `resolveSchema`, and a reader moving between the two would have to hold both meanings at once.

  Three things carry the design, and two of them are things the signature deliberately does **not** take:

  **`suspended` is not an input.** That is the claim "suspension is a different axis" stated in a way the compiler enforces. There is no branch to forget to remove in Phase 9.

  **`intent` is not an input.** The classifier reports what is true of the document; deciding to act against that is the caller's policy, and it lives with the caller — see "One policy, at one call site".

  **`sameBound` is not an input.** `BoundSchema` object identity is a guard against a caller rebuilding its schema on every call. It is not a fact about the document, it applies to exactly one of the three doors, and it already lives on that door at `exchange.ts:775`. Leave it there. Applying it to the network path would make sync depend on which `BoundSchema` object `resolveSchema` happened to return, including through its `supportedHashes` fallback, where the returned object legitimately carries a different `schemaHash` than the one requested.

  **The two refusals are separate arms carrying exactly their own fields.** A mismatch carries *which axis*; an unsupported transition carries where it came from. This is the discipline `Diagnostic` states for itself at `types.ts:88-90` — "no optionals; illegal states cannot be represented" — and it lets a caller distinguish "this can never work" from "this is not built yet" without parsing English.

  The rules, in full:

  | `phase` | Condition | Result |
  | --- | --- | --- |
  | `absent` | — | `create` |
  | `interpret` | — | `return-cached` |
  | `replicate` | — | `refuse` / `unsupported` |
  | `deferred` | `doc` is `undefined` | `promote` |
  | `deferred` | `mismatchForInterpretation` returns a mismatch | `refuse` / `mismatch` |
  | `deferred` | no mismatch | `promote` |

  With Phase 3 in hand the whole body is a four-arm switch whose only arm with content is one call:

  ```ts
  case "deferred": {
    const mismatch = doc && mismatchForInterpretation(reader, doc)
    return mismatch
      ? { action: "refuse", kind: "mismatch", mismatch }
      : { action: "promote", from: "deferred" }
  }
  ```

  `doc === undefined` promotes rather than refusing: nothing contradicts the request, and that matches what `#getImpl` does today. The sweep never reaches it — it keeps its own `if (!metadata) continue` guard, which is shell-level defensive coding about a synchronizer lookup, not a rule about documents.

  Note what is *absent* from this file: no comparisons, no hash logic, no policy. If it grows any of those, something has gone wrong.

- ✅ Task 7.2: Route `onEnsureDoc` step 1 (`exchange.ts:441-448`) through the predicate instead of calling `#interpretDoc` directly.

  This closes the third door. Every case reachable today is unchanged: `resolveSchema` has matched completely (Phase 5), and the `interpret` arm returns the cached ref exactly as `createInterpretDoc` does now. What changes is that a `replicate` entry can no longer reach the construction path from the network side — which after Phase 1 already throws, so the outcome is identical and only its origin moves.

  The `deferred` arm is unreachable from this door, and it is worth recording why rather than leaving a reviewer to wonder. `#deferDoc` (`exchange.ts:674-682`) calls `synchronizer.deferDoc` before `markDeferred`, so a deferred document **is** in the sync model — and `ensure-doc` is emitted only for documents unknown to it (`sync-program.ts:1239-1243`). The same mechanism is what makes Bug A permanent rather than merely delayed: once deferred, a document is invisible to the only path that would re-announce it, so `registerSchema`'s sweep really is its last chance.

  This door applies **no** policy: no identity check, no local-authoritative override. It takes the predicate's answer as given. That is the difference between the doors made visible — visible precisely because policy is written at the door that holds it rather than passed in as a flag.

- ✅ Task 7.3: Route `registerSchema`'s sweep through the predicate. Phase 6 already replaced its comparison; this replaces its control flow. Any `refuse` means "skip this document", which is what the loop already does by falling through. Like `onEnsureDoc`, it applies no policy of its own. Keep its `if (!metadata) continue` guard.

- ✅ Task 7.4: `packages/exchange/TECHNICAL.md` §Vocabulary — add **phase** as a term (`deferred` / `replicate` / `interpret`), distinguished from suspension. The `DocRuntime` row at `:47` calls it "the mode"; naming the axis is what makes "total over phase" a sentence a reader can parse.

  In the same pass, relate `InterpretAction` to the existing `Disposition` (`exchange.ts:81` — `Interpret | Replicate | Defer | Reject`). They are adjacent and easily confused: **`Disposition` decides which tier a newly discovered document should enter; `InterpretAction` decides how an existing document is raised to interpret.** Without that sentence the next reader will assume one supersedes the other.

  Add `src/interpret.ts` to §File Map.

- ✅ Task 7.5: Tests in `packages/exchange/src/__tests__/interpret.test.ts` (new). Six rows, six tests, calling `planInterpretation` directly. No Exchange, no Runtime, no mocks. Assert on the whole returned action — including `kind` and `mismatch.axis` — so a refusal that silently changes category fails.

  The classifier has no policy in it, so the interesting assertion is what it *refuses*: `deferred` + any mismatch → `refuse`, on every axis including `schemaHash`.

  Also add: `onEnsureDoc` does not enter interpretation for a document held in replicate mode. Drive it through a real two-peer setup using the existing helpers in `integration.test.ts` rather than calling the callback directly — the value is that the *wiring* is exercised. No existing test should need editing.

# ✅ Phase 8: `get()` checks replica type and sync mode before promoting

The named path stops being the odd one out. Three things change here, and the commit message should name all three:

1. **`#getImpl` gains `replicaType` and `syncMode`** on the deferred path — the gap from Scattering 2. This is the headline.
2. **Its hash comparison becomes membership** instead of exact equality, so a V2 schema reading a V1 document no longer warns. The spurious warning is the last trace of the wrong law on this door. (This is *not* part of Bug A — `#getImpl` always promoted regardless of hash, so no document was ever stuck by it. Bug A was the sweep alone, and Phase 6 fixed it.)
3. **Its one policy becomes explicit** rather than incidental to a `console.warn`.

- ✅ Task 8.1: Route `#getImpl` (`exchange.ts:741`) through `planInterpretation`.

  The method becomes: check the two things that are `#getImpl`'s own → call the predicate → execute the action.

  The `reader` is `metadataOf(bound)` — a field read and an array copy, no factory construction. That matters because `get()` on an already-interpreted document is the hottest path here and allocates nothing today (`createInterpretDoc` returns the cached ref before it builds anything, `runtime.ts:762-766`). Task 3.4 is what keeps it that way; without `bound.replicaType` this line would have quietly started building a substrate factory per call, and neither a test nor a review of this diff would have shown it.

  It keeps two guards the predicate deliberately does not hold, both exactly where they are today:

  1. **The `BoundSchema` identity check** (`exchange.ts:775`) — a named-caller ergonomics guard, applying to this door only.
  2. **The local-authoritative promotion policy.** On `refuse` / `mismatch` where `mismatch.axis === "schemaHash"` and the phase was `deferred`, promote anyway and emit the existing `console.warn` (`exchange.ts:763-767`, same wording).

  Comment the second with the reason from the Background — a deferred document arrived from a peer, so refusing here would let a remote peer break a local `get()` by announcing a colliding `docId`. Note in the same comment that the override applies to the `schemaHash` axis **only**: `replicaType` and `syncMode` refusals stand, because no local intent makes an undecodable format decodable.

  **Keep the suspended throw**, ahead of the predicate call, so this revision changes nothing about suspension and Phase 9 is a reviewable one-line deletion.

- ✅ Task 8.2: Tests in `exchange.test.ts`.

  - `get()` on a deferred document whose replica type is incompatible now throws rather than promoting. This is the gap closing.
  - The local-authoritative override: `get()` on a deferred document whose local schema does not support the document's hash promotes and warns, rather than throwing. This is the one policy the classifier does not hold, so this is the only place it can be tested. **Assert the `console.warn` fires** — nothing asserts it today, which is how it went unnoticed that the behaviour was untested at all.
  - The existing test at `:921` (`get() throws if docId is registered in replicate mode`) still passes unchanged. Add a comment pointing at the `"unsupported"` refusal kind, so a future reader knows the throw is a capability gap and not a correctness guard.

# ✅ Phase 9: `get()` returns suspended documents without resuming

- ✅ Task 9.1: Delete the suspended check from `#getImpl` (`exchange.ts:745-750`).

  `get()` on a suspended document returns the ref and **leaves it suspended**. Not "restores it", which is what `TECHNICAL.md:328` currently implies.

  The reasoning is worth a comment at the deletion site, because it is not the reading the documentation invites: suspension is about *sync-graph membership*, not local readability. `suspend()` sets a flag and sends `dismiss`; the ref and the substrate are untouched. If `get()` resumed, an unrelated read would silently re-enter the sync graph and restart traffic that peers observe. Returning without resuming preserves a property worth relying on — **`get()` never changes sync-graph membership** — and matches what a standalone `Runtime` already does.

- ✅ Task 9.2: `packages/exchange/TECHNICAL.md` §"Suspend vs destroy" (`:319`) and §"What `suspend` is NOT" (`:328`) — correct both. Each currently promises that `get()` un-suspends. It does not, and now deliberately does not. Say: `get()` returns the ref without resuming; only `resume()` re-enters the sync graph.

- ✅ Task 9.3: `packages/exchange/TECHNICAL.md` §"`exchange.get` — the four-case classifier" (`:296-313`) — replace the table with one that matches the code, now that the code has stopped moving.

  Case 2 currently claims replicate is upgraded to interpret. It is not; it is refused. Suspended is absent from the table entirely. Restructure around the rule rather than a case list: phase determines _what_ `get()` does, reconcilability determines _whether_ it does anything, and suspension does not participate.

  The "always a `Ref<S>`" sentence at `:313` needs qualifying, and the qualification is the rule rather than a list of exceptions. **Totality is over *phase*.** `get()` also throws on a `BoundSchema` identity mismatch (always has) and, after Phase 8, on a `replicaType` or `syncMode` mismatch — but those are refusals of an incoherent *request*, not of a document's state. Say that, then name `replicate` as the one phase still refused and why it is open rather than settled.

  State explicitly that the table describes `Exchange.get()` and note where `Runtime.get()` differs, so a standalone-`Runtime` reader is not misled one layer down.

- ✅ Task 9.4: Tests in `exchange.test.ts`: `get()` on a suspended document returns a ref, returns the *same* ref as before suspension, and leaves `exchange.documents.get(id)?.suspended === true`. The third assertion is the one that matters — it distinguishes "total" from "resumes on read".

- ✅ Task 9.5: No README changes. `get()`'s signature is unchanged, and the common case — an interpreted or brand-new document — behaves identically.

# ✅ Phase 10: Retire symbols removed in 3.0

Independent of every other phase; can land at any point in the stack. Kept separate because mixing dead-symbol cleanup into a behavioural revision is how doc drift gets re-introduced under cover of a real change.

- ✅ Task 10.1: Sweep the stale references left by the 3.0 cleanup. None were introduced by this plan, but they sit in the files it edits, and one sends readers hunting for a function that has never existed.

  | File | Line | Stale reference |
  | --- | --- | --- |
  | `packages/exchange/TECHNICAL.md` | `:251`, `:968` | `classifyDoc` — **exists in no source file** |
  | `packages/exchange/TECHNICAL.md` | `:7`, `:959`, `:980` | `describeSyncStatus`, `SyncStatusSummary`, and `src/describe-sync-status.ts` (deleted) |
  | `packages/exchange/TECHNICAL.md` | `:530-532`, `:539-540`, `:960` | `waitForSync`, `#isReady`, `waitUntilReady` — the whole removed chain |
  | `TECHNICAL.md` (root) | `:98` | `createDerivedSyncStore`; `useDocReady` described as "the monotonic readiness latch" (now sugar over `useDocStatus`) |
  | `packages/react/TECHNICAL.md` | `:597` | `describeSyncStatus`, `SyncStatusSummary` |

  While in §File Map, correct the line counts this stack moves: `src/exchange.ts` and `src/sync-program.ts` (recorded as 1127 at `:971`, which Phase 4 shortens materially). Re-derive both rather than adjusting by eye — a File Map is only worth having if its numbers are checkable.

# Tests

Strategy, since the specifics live with their revisions: **the laws are tested as tables over plain objects; the wiring is tested against real objects; nothing mocks a collaborator in order to assert the collaborator's semantics.** The two pure suites — `doc-metadata.test.ts` (Task 3.6) and `interpret.test.ts` (Task 7.5) — carry the design. Everything else is wiring.

**Green at every revision.** Each phase's tests land with its code, not after it. A phase whose claim is "changes nothing" (3, 4, 7) must additionally require **no edits to any existing test** — that is the only evidence for such a claim that does not depend on reading the diff carefully. If an existing test needs touching in one of those revisions, treat it as a finding and stop, rather than absorbing it into the diff.

**Regression watch.** The per-axis diagnostic assertions in `sync-program.test.ts` (`:641`, `:668`, `:790`, and the structured-field assertions at `:796-840`) are the tripwire for Phase 4. They must pass byte-for-byte and unedited.

Suspension is referenced in `sync-program.test.ts`, `integration.test.ts`, `runtime.test.ts`, `exchange.test.ts`, `settle.test.ts`, and `doc-feed.test.ts`. None assert that `get()` throws for a suspended document, so Phase 9 should not require edits to any of them.

# Transitive Effect Analysis [scratch]

**`@kyneta/schema` gains seven barrel exports and no dependencies.** All are pure functions and types over things the package already owns. `@kyneta/schema` does not learn about `DiagnosticCode`; the mapping lives in `@kyneta/exchange`. The dependency direction is unchanged.

**`bind()` gains a required parameter, and `BoundSchema` gains a field.** `bind` is a canonical public symbol, but it has exactly one production caller — `createBindingTarget` (`bind.ts:455`), which already holds `config.replicaFactory.replicaType` and currently discards it. All four binding targets (`json`, `ephemeral`, `loro`, `yjs`) route through there, so no target needs new information. The churn is ~18 direct `bind({...})` calls in four test files. A custom-substrate author calling `bind` directly must add one field; `createBindingTarget`, which the docs point such authors at (`bind.ts:443`), is unaffected.

**`DocMetadata` is a public exported type and loses a field.** This is a breaking change to `@kyneta/schema`'s surface, in a release that is already breaking — and the safest kind available, because the field has no runtime behaviour to break: nothing writes it and nothing reads it. The only visible effect on a downstream consumer is that an object literal supplying `supportedHashes` to something typed `DocMetadata` becomes an excess-property error, which is the compiler pointing at code that was already inert. Anyone who genuinely meant a reader now has `ReadCapability` to say so.

The blast radius stops at `DocMetadata`'s ~13 annotation sites because the three types that look like they inherit the field do not: `DocReadyInfo` (`runtime.ts:89`), `DocEntry` (`sync-program.ts:62`), and the wire message types each declare their own `supportedHashes` structurally. `StoreMeta` is the only derived type, and it becomes `DocMetadata` exactly.

`metadataOf`'s home is a judgment call worth recording: its only consumers are in `@kyneta/exchange`, which argues for keeping it there, but its input (`BoundSchema`) and its output (`ReadCapability`) are both schema-owned types, and a projection between two of a package's own types belongs with them. If a second projection like it appears with no schema-side consumer, revisit.

**`@kyneta/index` — `Source.fromExchange` (`source.ts:387`, `:429`, `:455`).** The crash that `PLAN-2026-08-03-index-exchange-source` fixes is a `replicate`-mode `get()`. This plan keeps replicate refused, so that crash still exists and that plan keeps its motivation intact. Sequencing this stack first means its real-Exchange tests pin the *final* semantics rather than semantics about to change underneath them.

Phase 9 does not reach index. `tryAdd` is only called from the `doc-created` branch of the subscriber; `doc-created` is emitted by `registerDoc` (`synchronizer.ts:748`), and resume emits `doc-resumed` (`synchronizer.ts:940`), which the subscriber ignores. So no suspended document reaches `get()` through a `Source` today.

**The ordering constraint that actually matters.** If `get()` ever promotes replicate documents (Alternatives Considered), `tryAdd` would silently upgrade a relay's replicate set into full substrates instead of crashing — trading a loud failure for a quiet one. Index's filter must be in place before that lands. It is not a constraint on this stack, because this stack keeps replicate refused; it is the reason the promotion question stays out of scope.

**Phase 5 reroutes classification, not just resolution.** When `resolveSchema` declines a bucket collision it previously accepted, `onEnsureDoc` falls through to step 2 and then step 4, which **defers** the document (`exchange.ts:466-470`). The document silently changes category from interpreted to deferred. That is the correct outcome — the local schema genuinely cannot serve it — but the deferred entry is the observable consequence, which is why Task 5.2 asserts it.

**Documents that were silently un-syncable may now report why.** Phases 5 and 6 both convert a silent skip into either a promotion or a structured refusal. A deployment where two peers disagreed on `syncMode` in a way `replicaKey` collapsed has been failing quietly; afterwards it fails loudly, at `resolveSchema`. That is the intended direction, but it is the change most likely to surface as "new" breakage in an existing deployment, and it belongs in Phase 5's commit message.

**`@kyneta/devtools` consumes the diagnostic vocabulary.** `stream.test.ts:78`, `log.test.ts:15`, `select.test.ts:88` and `:133` all construct or assert on `code: "schema-hash-mismatch"`. Nothing breaks — the three codes are unchanged and `DiagnosticCode` is untouched — but this is a second package depending on that vocabulary, and it is the reason the codes cannot simply be renamed to match `MetadataAxis`. The mapping table in Task 4.2 is what keeps both packages stable while the producer moves.

**`@kyneta/react` — `useDocument` (`use-document.ts:78`).** Calls `get()` inside a `useMemo`, so today a suspended document throws during render and surfaces at an error boundary. Phase 9 makes it return the ref. Strictly an improvement; no React-side change needed.

**`packages/exchange/src/line.ts:788`.** Subscribes to `doc-created` and never calls `get()` on the discovered document. Unaffected by every phase.

**`onEnsureDoc` reachability for replicate entries.** `ensure-doc` is emitted only for documents unknown to the sync model (`sync-program.ts:1239-1243`). A replicate document registered through `registerDoc` is known, so the network route does not reach it once registration completes. The window before registration — `replicate()` called, hydration still pending, `onDocReady` not yet fired — is not obviously closed. Task 7.2 makes the question moot rather than requiring it to be answered.

**Reentrancy.** `#getImpl` calls `registerSchema(bound)` before creating, and the sweep can re-enter `#interpretDoc` for *other* deferred documents (`exchange.ts:790-793`). Routing both through the same predicate does not change the reentrancy shape — the inner calls still operate on different `docId`s. The `create` action is only produced for `phase: "absent"`, so the document being created cannot be re-entered by its own sweep.

**Nothing becomes dead.** `replicaTypesCompatible` gains callers and keeps its `sync-program.ts:1159` usage through the shared axis helper. `syncModeName` and `replicaKey` remain the lookup index. No module is orphaned by any phase.

# Resources for Implementation [scratch]

- `packages/schema/TECHNICAL.md` — §`supportedHashes` (`:1109-1124`), the hash-comparison rules (`:446-451`), §"What migrations are NOT" (`:1126-1130`).
- `packages/exchange/TECHNICAL.md` — §"`exchange.get` — the four-case classifier" (`:296-313`), §"Document classification on `present`" (`:249-260`), §"Suspend vs destroy" (`:315-323`), §"What `suspend` is NOT" (`:325-329`), §Vocabulary (`:36-49`), §File Map (`:963`).
- `packages/exchange/src/exchange.ts` — `#getImpl` (`:741`), `onEnsureDoc` (`:431`), the two-tiered default (`:466-470`), `#interpretDoc` (`:589`), `registerSchema` + sweep (`:1038-1066`), `Disposition` (`:81`).
- `packages/exchange/src/runtime.ts` — `get` (`:440`) and its docstring (`:433`), `createInterpretDoc` (`:758`), the unconditional cache write (`:800`), `replicate` (`:449`), `suspend`/`resume` (`:526`, `:544`), `DocCacheEntry` (`:145-164`), interpret `readyInfo` (`:778-786`), replicate `readyInfo` (`:869-876`).
- `packages/exchange/src/sync-program.ts` — the three-axis validation with diagnostics (`:1154-1221`), `ensure-doc` emission (`:1239-1243`).
- `packages/exchange/src/capabilities.ts` — `syncModeName` (`:50`), `replicaKey` (`:65`), `resolveSchema` (`:263-278`), `ReplicaEntry` (`:40`).
- `packages/exchange/src/types.ts` — `DiagnosticCode` (`:64`), `Comparison` (`:82-86`), the `Diagnostic` union and its "no optionals" rationale (`:88-109`).
- `packages/schema/src/substrate.ts` — `ReplicaType` + `replicaTypesCompatible` (`:677`, `:685`), `SyncMode` (`:710`), `DocMetadata` (`:753`), `ReplicaFactoryLike` (`:776`), `SubstrateFactory.upgrade` (`:893`).
- `packages/schema/src/bind.ts` — `BoundSchema` (`:107-150`), `supportedHashes` (`:150`), `BoundReplica` (`:164`), `createBindingTarget` (`:445`).
- `packages/schema/src/migration.ts` — `computeSupportedHashes` (`:1221`).
- Pure-classifier precedents to match in shape and comment style: `deriveDocStatus` (`doc-status.ts:57`), `planInitialization` (`initialize.ts:43`), `derivePeerSettled` (`synchronizer.ts:389`), `classifyProtocolSkew` (`protocol-version.ts`), `resolveLease` (`persistent-peer-id.ts`).

# Alternatives Considered

**One comparison law for all four sites.** This was the plan's earlier shape: a single `compareDocMetadata` using the sync program's set-intersection on the hash axis. Rejected on inspection, and it would have been a regression rather than a tidy-up. Intersection is strictly weaker than membership, so applying it to `resolveSchema` would have made it return a `BoundSchema` for documents that schema cannot interpret, on nothing more than a shared migration ancestor. The two laws are not one law implemented twice; they answer two questions that `packages/schema/TECHNICAL.md` documents separately, and the correct move is to name both, not to merge them.

**One function with a `law: "interpret" | "sync"` parameter.** Rejected for the same reason as `intent` below: a flag makes one function answer two questions and lets the call site stop saying which one it is asking. Two exported names cost one extra export and make every call site self-describing.

**Memoise `ReadCapability` in a `WeakMap<BoundSchema, ReadCapability>` instead of adding `replicaType` to `BoundSchema`.** This was the plan's previous answer to the hot-path problem, and it works — a read capability is a pure function of the bound for a fixed `peerId`. Rejected because it treats a missing field as a lookup problem.

A side table is the right shape for per-object state on an object you **cannot change**: `settleTerms` (`settle.ts:105`) and `syncRefMap` exist because the schema layer creates refs and the exchange must annotate them from outside. `BoundSchema` is ours. Adding the field deletes the memo, the two-argument `metadataOf`, and a factory construction that already exists in `registerSchema` — where a `WeakMap` would have deleted only the first and left the other two in place, plus a cache to reason about.

**Derive `replicaType` inside `bind()` by calling the factory builder once with a sentinel `peerId`.** Rejected, though it is the version with no signature change and no test churn. It would construct a substrate factory at module-load time for every bound schema — for Loro, potentially reaching WASM at import — and pass a fabricated identity into third-party builder code whose side effects are not ours to predict. Building an object solely to read a constant off it is the wart being removed, not a way to remove it. Eighteen mechanical test edits are cheaper than any of that.

**Keep `supportedHashes` on `DocMetadata` and have both comparisons take two `DocMetadata`s.** This was the plan's shape one revision ago, and it fails three ways at once — all traceable to one conflation.

It makes the two parameters of a *directional* law the same type, so swapping them typechecks and silently inverts newer-reads-older into older-reads-newer. It accepts a `doc.supportedHashes` that the interpretation law must ignore, which is an open invitation to "fix" that law into an intersection — the exact regression the two-law split exists to prevent. And it gives `mismatchForSync` a parameter type that cannot express what sync actually compares, since its one call site holds two live capability sets.

The field is also, empirically, dead: never populated, never read, and `Omit`ted by the one type derived from it. Keeping a dead field to preserve a symmetry that was itself the bug is the worst of both.

**Add `ReadCapability` but leave `supportedHashes` on `DocMetadata` too.** Rejected. It would leave the dead field in place, keep `StoreMeta`'s `Omit` needed, and — decisively — leave `DocMetadata` assignable to `ReadCapability`'s shape wherever the field is optional, so the compiler could no longer tell a reader from a document. The direction check works *because* the field is required on one type and absent from the other. Making it optional on both is the same as not splitting.

**Unify `resolveSchema` into the comparison.** Rejected. `resolveSchema` is an indexed lookup and the coarse `replicaKey` bucket is what makes it O(1); replacing it with a scan-and-compare trades a real property for tidiness. Verifying *after* the lookup keeps both and is strictly less code than a scan.

**Put `MetadataAxis` and `DiagnosticCode` in the same type.** Rejected. `@kyneta/schema` cannot depend on `@kyneta/exchange`, and the axis names are a fact about `DocMetadata` while the diagnostic codes are a fact about how the exchange reports to users. `@kyneta/devtools` also depends on the codes, so they are load-bearing beyond one package. The three-entry `satisfies` mapping is the layer boundary made explicit.

**Give `planInterpretation` an `intent: "named" | "blanket"` parameter.** Rejected, for two reasons.

It is not a fact about the document. Every other input to the classifier — the phase, the document's metadata, the reader's capability — describes what is there; `intent` describes who is asking. Mixing them makes the function answer "what is true of this document *for you*", which is two questions wearing one signature, and it forces a carve-out row that then needs a paragraph of defence.

And it is not worth its cost. The parameter existed to preserve exactly one behaviour, and that behaviour turned out to be worth about four lines: five of eleven truth-table rows, two union arms, and a `schemaHashDiverged` field, all to express something one caller does. Written at that caller it is four lines with the reason attached. The rule of thumb this leaves behind is worth keeping: **if a classifier needs to know who is asking, the thing that varies is policy, and policy belongs to the asker.**

**Delete the local-authoritative promotion entirely.** Tempting once `intent` was gone — the behaviour has no test coverage, and `sync-invariants.test.ts:462` shows the promoted document cannot sync with the peer that announced it, so it produces a document that only half exists. Rejected: a deferred document arrived from a peer, so refusing hands a remote peer a way to break a local `get()` by announcing a colliding `docId` with a different schema. The behaviour is defensive rather than permissive, which is not what its warning text suggests — hence the comment Task 8.1 requires.

**Implement replicate → interpret promotion in this stack.** The mechanics are largely present: `SubstrateFactory.upgrade(replica, schema)` (`substrate.ts:893`) wraps the same backing document, and all four backends define `create()` in terms of it, so accumulated state would carry over where the replica types match. Excluded for two reasons about consequences rather than difficulty.

First, promotion is one-way — there is no `demote()` — so a participant that promotes a document acquires a full substrate for something it only meant to forward, and cannot give it back. That cost lands on relays, which is precisely who `replicate` exists for.

Second, it must not land before `@kyneta/index`'s source filter. `Source.fromExchange` calls `get()` on every document matching its schema; the moment `get()` promotes, attaching a `Source` silently upgrades a relay's entire replicate set. Today that path crashes, which is bad but loud. Trading it for silence during the window between the two plans would be a regression in kind, not just degree.

Keeping the refusal but expressing it as an `"unsupported"` arm costs one union member and makes the eventual change a single branch of one function plus an executor arm, decided deliberately.

**Extend `registerSchema`'s sweep to replicate entries when promotion arrives.** Rejected in advance, and worth a comment now. The sweep is blanket: registering one schema would promote every matching replicate document at once. A relay that registers a schema in order to interpret *one* document would silently acquire full substrates for all of them. Named promotion — the caller supplied both a `docId` and a `BoundSchema` — is a deliberate act. Blanket promotion is an accident waiting for a large enough replicate set.

**Make `get()` total in the unqualified sense — never throw.** Rejected. It would require either a result type at the front door, degrading ergonomics for the overwhelmingly common case, or silently returning a ref built from the wrong schema. A `BoundSchema` mismatch is the caller passing incoherent arguments, and throwing is the correct answer. "Total over phase" is the useful claim; "total" is not.

**Fix the documentation to match the code instead of the code to match the documentation.** Rejected. Three separate passages describe `get()` as total, `Runtime` already implements it that way for suspension, and the one code path that disagrees is a guard layered on top of a shell that had already answered the question. When the docs, the lower layer, and the design rule all agree against a single guard, the guard is the outlier.

**Land the work as fewer, larger revisions.** Rejected. The earlier five-phase shape put four independent claims in one revision and pooled every documentation change at the end, which guarantees that intermediate revisions have docs contradicting their code. Ten revisions is more than it looks: three of them change no behaviour at all and are verified by existing tests not needing edits, which is a cheaper review than any of them would get inside a larger diff.
