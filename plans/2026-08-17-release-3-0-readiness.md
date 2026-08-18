chore(release): ready 3.0.0 for publication

# Background

Kyneta is preparing its 3.0.0 release. The code itself is in good shape:
`pnpm verify` passes 56/56, no `@deprecated` markers remain anywhere in source,
all internal peer dependencies use `workspace:^` (which pnpm rewrites to a
concrete range at publish time), and publish metadata — `files`, `exports`,
`repository`, `license`, `publishConfig` — is complete on all 24 public
packages.

The gaps are in what ships *around* the code, plus two new APIs whose types do
not infer. Three facts shape the work:

- **The changelog has been unmaintained for three releases.** At tag `v2.3.2`
  its newest heading was already `# 2.1.0`. Tags `v2.2.0`, `v2.3.0` and `v2.3.2`
  shipped with no entries — 22 commits in total (8 + 9 + 5). A user upgrading
  from 2.3.2 reads a document that never described the version they are on.

- **The README predates this development cycle.** Its last content change was
  2026-06-13, before the readiness-API removal and several renames. Its Quick
  Start does not compile, and two further claims name APIs that do not exist.

- **`initialize` and `useInitialize` cannot infer their draft type.** Both are
  new in 3.0. Each places its type parameter only in a callback argument
  position, so it always falls back to `unknown`. The examples are not part of
  `pnpm verify`, which is why this went unnoticed: compiling
  `examples/todo-react` by hand reports `'d' is of type 'unknown'` at
  `src/app.tsx:46`.

# Problem Statement

Publishing 3.0.0 as it stands would ship:

1. A front-page Quick Start that does not compile.
2. A changelog documenting 4 of 10 breaking changes, and none of the new
   features.
3. No upgrade path for the 6 undocumented breaking changes.
4. Packaging metadata that disables tree-shaking for every consumer.
5. Two new public APIs that hand every caller an `unknown` draft, locking a
   mistake that is free to fix now and breaking to fix later.

# Success Criteria

- `initialize` and `useInitialize` infer the draft type from the document passed
  to them, and `examples/todo-react` compiles as a result.
- Every fenced TypeScript block in every shipped README is backed by compiled
  source, and a check enforces that the prose matches it.
- Every change a downstream user must act on appears in `CHANGELOG.md` under a
  `3.0.0` heading, as one concise bullet naming the symbol and its replacement.
  Changes with no downstream impact are absent.
- The `3.0.0` section is substantially shorter than the draft it replaces, with
  the reasoning relocated to `docs/upgrading-3.0.md` rather than deleted.
- The released history for 2.2.0, 2.3.0 and 2.3.2 is present, so the changelog
  is continuous from 1.3.1 to 3.0.0.
- `docs/upgrading-3.0.md` exists and covers every breaking change with a
  before/after.
- No shipped document references a symbol that no longer exists.
- All 24 public packages declare `"sideEffects": false` and an `engines.node`
  floor.
- All packages are at 3.0.0 and `pnpm verify` passes.

# Revision Sequence

Each phase below lands as one revision, in this order, and each leaves
`pnpm verify` green. Two orderings are deliberate and easy to get wrong:

- **Phase 2 precedes Phase 3.** Building the drift guard first is the better
  *working* method — it enumerates the broken snippets instead of relying on a
  hand audit. But landing it first would commit a revision where the guard fails
  against the un-fixed README, breaking bisect. Build it first, land it second.
- **Phases 7 and 8 are separate revisions.** Adding `sideEffects` and `engines`
  is mechanical across 24 manifests; the `@kyneta/index` peer-dependency fix is
  semantic and moves the lockfile. Combined, the meaningful change hides inside
  the noise.

- **Phase 3 must land whole.** It is the one phase where a partial revision is
  red rather than merely incomplete: the guard fails the moment it exists
  without every snippet file and every fence binding beside it. Splitting it for
  reviewability is a false economy — the four tasks are one mechanism, and a
  reviewer reading half of it learns less, not more.

Every revision references `PLAN-2026-08-17-release-3-0-readiness`.

# ✅ Phase 1 — Make the new initialization APIs infer

This goes first because it is the only change here whose cost rises sharply
after publication. Once 3.0.0 is on npm the signature is part of the published
surface, and correcting it needs its own major or a deprecation cycle.

Both APIs are shaped like this today:

```ts
initialize<T = unknown>(doc: object, seed: (d: T) => void, opts?)     // exchange
useInitialize<T = unknown>(doc: object, seed: (d: T) => void, opts?)  // react
```

`T` appears only in the callback's parameter position, and `doc` is typed
`object`, so there is nothing for TypeScript to infer *from*. `T` resolves to
its default `unknown` on every call that does not name it explicitly.

- ✅ **Task 1.1** — Re-shape `initialize` (`packages/exchange/src/initialize.ts:123`)
  on the model of `batch` (`packages/schema/src/facade/batch.ts:109`), which is
  the same pattern done correctly in this monorepo:
  `batch<D extends object>(ref: D, fn: (draft: D) => void, options?)`.
  Binding the document and the draft to one type parameter is what makes the
  draft inferrable.
- ✅ **Task 1.2** — Re-shape `useInitialize`
  (`packages/react/src/use-initialize.ts:43`) the same way. The fix does not
  cascade from Task 1.1: the hook declares its own type parameter and passes an
  explicitly annotated callback down at `use-initialize.ts:64`, so that call
  site needs updating too.
- ✅ **Task 1.3** — Watch for TS2589 ("type instantiation is excessively deep")
  in `@kyneta/react`. That package already works around it twice —
  `use-document.ts` uses a declared call-signature plus an `as any`
  implementation precisely because `Ref<S>` blows TypeScript's recursion budget
  when `S` is an abstract generic parameter. Binding `D` to a *concrete*
  `DocRef<S, N>` at the call site should be safe, since nothing new is evaluated
  deeply against an abstract parameter, but this is the one package where that
  assumption has already failed twice. Verify rather than assume.
- ✅ **Task 1.4** — Confirm the change is a repair rather than a break for
  callers who never named the parameter: their draft goes from `unknown` to a
  real type, so code that compiled before still compiles. Callers who wrote
  `initialize<Foo>(…)` keep working when `Foo` is the document type.
- ✅ **Task 1.5** — Compile the five examples by hand
  (`tsgo --noEmit --skipLibCheck` in each) and confirm `examples/todo-react`
  now passes. `useDocument` returns a fully typed `DocRef<S, N>`, so the draft
  should infer without any annotation being added to the example — if one is
  needed, the signature is still wrong. This is a one-time check, not new CI;
  see Alternatives for why the examples stay outside `pnpm verify` for 3.0.
  Expect two unrelated failures that are configuration gaps rather than defects:
  three examples import CSS as a side effect with no ambient module
  declaration, and `prisma-counter` needs `prisma generate` to have been run.
- ✅ **Task 1.6** — Comment both functions to say why the type parameter is
  bound to the document. A future reader needs to know that loosening `doc` back
  to `object` silently removes inference without producing any error in these
  packages — the damage appears only at call sites.

# ✅ Phase 2 — Fix the README and stale documentation references

- ✅ **Task 2.1** — Fix the Quick Start's two independent breakages
  (`README.md:9–44`):
  - `import { Schema, change }` — `change` is not exported from
    `@kyneta/schema`, as a value or a type. The block calls `batch(doc, …)`,
    which **is** exported but never imported. Import `batch`, drop `change`.
  - `await sync(doc).waitForSync()` — removed. Replace with
    `await whenSettled(doc)`, imported from `@kyneta/exchange`
    (`packages/exchange/src/sync.ts:246`).
- ✅ **Task 2.2** — Fix the "Grow Without Rewriting" table (`README.md:78–79`).
  It names a `route` and `authorize` predicate pair, and a `type: "relay"`
  exchange option. None exist. The real `Policy` surface is at
  `packages/exchange/src/governance.ts:87` — `canShare`, `canAccept`,
  `canReset`, `cohort`, `canConnect`, `authority`, `resolve`. Relay is a
  topology built from those gates, not a config flag; describe it as such.
- ✅ **Task 2.3** — Correct every remaining fence and API claim in the root
  `README.md`, and in each package-level `README.md`. Package READMEs ship in
  the published tarballs and are what a consumer reads on npm. Use the Phase 3
  guard as the working tool here: build it against the current documents, let it
  list the mismatches, fix them, and land the fixes in this revision.
- ✅ **Task 2.4** — Correct `packages/schema/theory/sql.md:387,762`. Both cite
  `waitForSync({ kind: "storage" })` as something that "already exists". Reword
  against `whenSettled`, whose options object is the nearest equivalent.
- ✅ **Task 2.5** — Leave the three historical references to removed symbols
  **unchanged**: `packages/exchange/TECHNICAL.md:624`,
  `packages/react/TECHNICAL.md:432`, and the explanatory comment at
  `packages/exchange/src/__tests__/exchange.test.ts:264`. Each narrates a
  removal in the past tense and is correct as written. They are listed here so a
  search-and-replace does not sweep them up.

# ✅ Phase 3 — Guard against documentation drift

Snippets live as ordinary source under a package the `types` task already
covers, so they are typechecked by the run that exists. What remains is a
comparison between the prose and that source, which is pure string work:

```ts
extractFences(markdown: string): Fence[]                     // pure
matchFences(fences: Fence[], sources: Source[]): Mismatch[]  // pure
```

A thin imperative shell reads the files, calls the core, and reports.

- ✅ **Task 3.1** — Create a snippets directory under an existing typechecked
  package. `tests/integration/tsconfig.json` has `"include": ["src/**/*"]`, so
  snippets must live under a `src/` to be compiled at all.
- ✅ **Task 3.2** — Write the pure core. `extractFences` parses fenced `ts` and
  `tsx` blocks with their source positions; `matchFences` compares each fence
  against its named snippet file and returns the mismatches. Both are ordinary
  functions over strings, testable without touching a filesystem.
- ✅ **Task 3.3** — Write the shell as a vitest test that reads the READMEs and
  snippet files, calls the core, and fails with the mismatching fence and its
  line number.
- ✅ **Task 3.4** — Bind each fence to its snippet with an HTML comment
  immediately preceding it, so the association is visible in the document source
  rather than inferred from ordering.

# 🔴 Phase 4 — Restore the missing released history

The changelog must be continuous before 3.0.0 is added on top. Otherwise the new
entry sits directly on 2.1.0 and implies the 2.2–2.3 work belongs to this
release.

**The changelog rule, which governs this phase and Phase 5.** The changelog is
compact. An entry earns its place only if it changes what a downstream user must
do, and it says so in one bullet.

- **Include**: removed or renamed public API, behaviour a caller can observe
  changing, wire-format changes, genuinely new capability.
- **Exclude**: internal refactors, test changes, comment and documentation work,
  and any fix whose own description concedes it was unreachable or invisible.
- **One bullet per change.** Name the symbol, say what changed, give the
  replacement. Reasoning, worked examples and migration walkthroughs go in
  `docs/upgrading-3.0.md` — the changelog says *what*, the guide says *how* and
  *why*.

A reader scans a changelog to find out whether this release affects them. Prose
that answers a question they have not yet asked makes that slower, not more
thorough.

- 🔴 **Task 4.1** — Reconstruct `# 2.2.0` from the 8 commits in
  `v2.1.0..v2.2.0`. Group under `## Breaking` / `## Added` / `## Fixed` /
  `## Changed`. Most of the 22 commits across these three releases will produce
  no entry at all; that is the expected outcome, not an incomplete job.
- 🔴 **Task 4.2** — Reconstruct `# 2.3.0` from the 9 commits in
  `v2.2.0..v2.3.0`.
- 🔴 **Task 4.3** — Reconstruct `# 2.3.2` from the 5 commits in
  `v2.3.0..v2.3.2`.

# 🔴 Phase 5 — Complete the 3.0.0 changelog entry

The existing `# Unreleased` section documents 4 breaking changes. Six are
missing, as is every feature added this cycle.

Phase 4's changelog rule applies here in both directions. The section currently
runs 2,219 words across 16 bullets — an average of 139 words each, the longest
314 — so this phase compresses what is there as much as it adds what is missing.
Expect the finished section to be several times shorter despite covering more
ground.

The task descriptions below are **source material, not target length**. Each
gives the implementer what the change was and why it matters; the entry itself
is one bullet.

- 🔴 **Task 5.1** — Merge the two `## Added` blocks. The section currently has
  `## Added` at two separate points with `## Fixed` and `## Changed` between
  them, so a reader who finds one will not look for the other.
- 🔴 **Task 5.2** — Compress the four existing `## Breaking` entries and the
  `## Fixed` / `## Changed` / `## Added` prose to one bullet each, moving the
  reasoning to `docs/upgrading-3.0.md` where it is still wanted.
- 🔴 **Task 5.3** — Remove the entries that declare their own irrelevance.
  Several say plainly that nothing downstream changes: the `richtext`
  container-classification fix states "No user-visible behaviour changes", the
  atomic-register map-change fix states it is "unreachable in normal operation"
  and that "local reads were unaffected", and the `NotificationPlan` `paths`
  field states "Additive; existing consumers of `planNotifications` are
  unaffected". These are commit-message material. The `stepSchema` error-message
  rename is borderline — keep it only as a single clause, since its whole
  audience is someone grepping an error string.
- 🔴 **Task 5.4** — Add the breaking entry for **the readiness API removal**.
  Removed: `waitForSync`, `sync(doc).settled()`, `hasSync`, `describeSyncStatus`,
  `SyncStatusSummary`, `createDerivedSyncStore`. Migration: `whenSettled(doc)`
  for waits, `docStatus(doc)` for readiness, and compose a status label from
  connectivity + `peerStates` + `docStatus`. This is the highest-impact entry:
  it is what breaks the README, and the API it removes was the documented way to
  await sync in 2.x.
- 🔴 **Task 5.5** — Add the breaking entry for **`populated` / `deleted` now
  returning booleans**. The carriers keep the `Feed` suffix (`populatedFeed`,
  `deletedFeed`); `isPopulated` and `isDeleted` are removed. Call out the one
  silent change: `if (populated(ref))` was *always* truthy before, because a
  carrier is a callable object. It now returns the correct boolean, so this
  migration repairs latent bugs rather than introducing them.
- 🔴 **Task 5.6** — Add the breaking entry for **`get()` promoting a replicate
  document**. When a caller supplies a schema for a document held as a bare
  replica, `get()` now upgrades it in place over the same backing document
  rather than throwing. State accumulated while it was headless carries across.
- 🔴 **Task 5.7** — Add the breaking entry for **`get()` returning suspended
  documents without resuming**. It previously threw. Suspension is about
  sync-graph membership, not local readability, so a read no longer risks
  silently restarting traffic that peers can observe.
- 🔴 **Task 5.8** — Add the breaking entry for **`createDocAs` / `createDoc`**.
  `createDoc(bound, payload?)` no longer accepts a peer identity; it always uses
  a random one. `createDocAs(peerId, bound, payload?)` leads with the identity
  and requires it. Migration: `createDoc(bound, undefined, "peer-a")` becomes
  `createDocAs("peer-a", bound)`.
- 🔴 **Task 5.9** — Add the breaking entry for **the two schema-compatibility
  laws**. `supportsHash` is the primitive; `hashesIntersect` applies it pairwise.
  `mismatchForInterpretation` answers "can my schema read this document?" and
  `mismatchForSync` answers "is there a shape we both speak?". `supportedHashes`
  moves from `DocMetadata` to `ReadCapability`, and becomes required there: a
  document has one shape, a peer has a set it can cope with. `PresentMsg` now
  declares the field itself, optional, since a `present` is where a document's
  identity and the sender's declared range travel together.
- 🔴 **Task 5.10** — Add the breaking entry for **`formatPath` removal**. Use
  `path.format()`. The free function was only ever a wrapper around the method.
- 🔴 **Task 5.11** — Add `## Added` entries for this cycle's features:
  `whenSettled`, `docStatus`, `initialize` and the settle-term registry
  (`@kyneta/exchange`); `useDocStatus` and `useInitialize` (`@kyneta/react`);
  `Source.fromExchange` and the exchange-backed source (`@kyneta/index`);
  `Policy.authority`; and `exchange.replicate` with schema-driven promotion.
- 🔴 **Task 5.12** — Verify nothing remains undocumented by listing every commit
  in the release range whose subject carries a `!` marker or whose body carries
  a `BREAKING CHANGE:` trailer, and checking each against the changelog.

# 🔴 Phase 6 — Write the upgrade guide

Ten breaking changes with no single document describing the upgrade.
`docs/migrations.md` is about *schema* migration chains — a different mechanism
that happens to share the word.

This guide is the other half of the changelog rule. Everything the changelog
drops for being too long — the reasoning, the worked migration, the explanation
of why a behaviour changed — belongs here, where a reader has already decided
they are affected and wants the detail. Nothing is lost by compressing the
changelog; it is relocated to where it answers a question the reader is actually
asking.

- 🔴 **Task 6.1** — Create `docs/upgrading-3.0.md`. One section per breaking
  change, each with a before/after pair. Order by likelihood of being hit rather
  than by package: the readiness API first, then the `populated`/`deleted`
  booleans, then the rest.
- 🔴 **Task 6.2** — Open with the two changes that alter behaviour *without* a
  compile error, since those are what a type-driven upgrade will miss:
  `if (populated(ref))` silently flipping from always-true to correct, and
  `get()` on a suspended or replicate document no longer throwing.
- 🔴 **Task 6.3** — Note the wire-compatibility boundary. The ephemeral tag
  changed from `["plain", 1, 0]` to `["ephemeral", 1, 0]`, and the ephemeral
  `StateTuple` gained a third slot, so 2.x and 3.0 peers cannot sync ephemeral
  documents. Nothing ephemeral is persisted, so there is nothing to migrate, but
  a mixed deployment will not exchange presence until both sides upgrade.
- 🔴 **Task 6.4** — Link the guide from `README.md` and from the top of the
  `# 3.0.0` changelog section.

# 🔴 Phase 7 — Declare packaging metadata

- 🔴 **Task 7.1** — Add `"sideEffects": false` to all 24 public packages.
  Without it a bundler must assume every module mutates something on import, so
  it cannot drop unused code — tree-shaking is off for every consumer. Before
  adding it, scan all 24 public source trees for module-level global assignment,
  prototype patching, bare `import "…"` statements and CSS imports, and record
  that check in the commit message. The flag is a standing claim rather than a
  one-time setting, so a future reviewer needs to know what backs it. The CSS
  side-effect imports in the examples do not bear on this; examples are private
  and unpublished.
- 🔴 **Task 7.2** — Add `"engines": { "node": ">=18.0.0" }` to all 24 public
  packages, matching the floor already declared by `@halecraft/verify`.

# 🔴 Phase 8 — Declare the index's optional exchange peer

- 🔴 **Task 8.1** — Fix `packages/index/package.json`. It declares
  `peerDependenciesMeta` marking `@kyneta/exchange` optional, but
  `@kyneta/exchange` is absent from `peerDependencies`, which makes the meta
  entry inert. The package has no runtime import of the exchange —
  `Source.fromExchange` types it structurally — so add `@kyneta/exchange` to
  `peerDependencies` as `workspace:^` and keep the optional marker. That pair is
  what the code actually means: usable with it, not requiring it.
- 🔴 **Task 8.2** — Confirm the resulting `pnpm-lock.yaml` diff is confined to
  `@kyneta/index`. This is a separate revision from Phase 7 because it changes
  what pnpm resolves, and that must be reviewable on its own rather than buried
  in a 24-manifest diff.

# ✅ Phase 9 — Lockfile hygiene

- ✅ **Task 9.1** — Remove the tracked `bun.lock`. Root `TECHNICAL.md` states
  that bun and npm do not work for the monorepo build, so `bun install` cannot
  regenerate it. Nothing references it. Bun still runs `scripts/release.ts` and
  the `logic-bun` suite, but both execute against a pnpm-installed
  `node_modules` and read no lockfile; verify both after removal.
- ✅ **Task 9.2** — Record in root `TECHNICAL.md`, beside the existing "pnpm is
  required" rule, that `pnpm-lock.yaml` is the only lockfile and why bun needs
  none. The rule explains why pnpm is mandatory but not why a bun lockfile sat
  next to it, which makes the file read as deliberate.

# 🔴 Phase 10 — Version bump and release

Last, so that everything published describes the release accurately.

- 🔴 **Task 10.1** — Rename the changelog's `# Unreleased` heading to `# 3.0.0`.
- 🔴 **Task 10.2** — Run `bun scripts/release.ts bump 3.0.0 --group all`. Groups
  derive from directory convention, so no group list needs updating. Internal
  dependents use `workspace:^` and resolve automatically; `pnpm publish`
  rewrites those to `^3.0.0` in the published tarball.
- 🔴 **Task 10.3** — Run `pnpm build && pnpm verify` and confirm 56/56.
- 🔴 **Task 10.4** — Run `bun scripts/release.ts status` and confirm every
  package reports 3.0.0 locally against its registry version.

# Tests

Most of this work is documentation, so verification is the existing suite plus
two additions.

- **Inference regression test** (Phase 1). A type-level assertion that the draft
  passed to `initialize` and `useInitialize` is the document's type and not
  `unknown`. Without it, someone widening `doc` back to `object` reintroduces
  the bug silently, because nothing inside these packages would fail — and the
  examples that would have caught it are not in `pnpm verify`.
- **Documentation fence check** (Phase 3). `extractFences` and `matchFences` get
  direct unit tests over string inputs. The shell gets one integration test over
  the real READMEs.
- **`pnpm verify` after Phase 7.** `sideEffects` and `engines` do not affect the
  build, but the edits touch 24 manifests and malformed JSON surfaces here.
- **`pnpm install` after Phase 8.** Adding `@kyneta/exchange` to
  `@kyneta/index`'s peer dependencies changes what pnpm resolves. The install
  must stay clean.
- **`pnpm build && pnpm verify` after Phase 10.** The version bump rewrites 24
  manifests.

No new unit tests are warranted for Phases 4, 5, 6 or 10: they change prose and
version strings, which have no testable behaviour.

# Transitive Effect Analysis [scratch]

- **Phase 1 → every caller of `initialize` / `useInitialize`.** Binding the type
  parameter to the document turns a previously-`unknown` draft into a real type.
  Callers who ignored the draft still compile; callers who used it were
  annotating or casting already, and their annotation now has to be *correct*
  rather than merely present. That is the desirable direction, but it means the
  change can surface errors in code that compiled before — latent mistakes, not
  regressions.
- **Phase 1 → `@kyneta/react`'s TS2589 history.** This package has hit
  TypeScript's recursion budget twice on the `Ref<S>` type and works around it
  with a declared call signature plus an `as any` implementation. A new generic
  parameter in the same package is exactly the shape that has failed before, so
  it needs checking rather than assuming.
- **Phase 3 → the existing `types` task.** Snippets live under an existing
  package's `src/`, so the compiler already covers them and `turbo.json`'s
  `verify.dependsOn: ["build"]` already sequences it. Nothing new enters the
  task graph.
- **The examples stay outside `pnpm verify`.** They keep their current status:
  compiled only by hand, and only when someone thinks to. `todo-react` is
  repaired by Phase 1 regardless, since the fix is in the library rather than
  the example. The residual risk is that a future library change breaks an
  example silently, which is the same risk that exists today.
- **`sideEffects: false` → bundlers → consumers.** This is a claim to every
  downstream bundler that importing any module has no observable effect. If it
  were false anywhere, consumers would see code silently dropped from production
  builds, and the failure would appear in the consumer's app rather than here.
  It must be re-checked if a package later registers a global, patches a
  prototype, or gains a bare `import "…"`.
- **Version bump → `workspace:^` → published ranges.** Internal peer deps are
  all `workspace:^`, which pnpm rewrites at pack time. Bumping every package
  together keeps them consistent; bumping a subset would publish a 3.0.0 package
  depending on `^3.0.0` of a sibling still at 2.3.2 — hence `--group all`.
- **`engines.node` → installs.** Declaring a floor makes npm warn, or fail under
  `engine-strict`, for users below it. `>=18.0.0` matches the existing
  `@halecraft/verify` declaration, so it introduces no new constraint in
  practice.
- **Phase 8 → pnpm resolution → devtools.** `@kyneta/devtools` depends on
  `@kyneta/index` and already depends on `@kyneta/exchange` directly, so adding
  the optional peer changes no resolution it relies on. A mistake here surfaces
  in devtools before the index's own tests.
- **Phase 4 → Phase 5.** Reconstructing 2.2–2.3 first means the 3.0.0 entry is
  written against a complete document, so a change already shipped in 2.3.0 is
  not accidentally attributed to 3.0.0.

# Resources for Implementation [scratch]

- `packages/schema/src/facade/batch.ts:109` — `batch<D extends object>(ref: D,
  fn: (draft: D) => void, options?)`, the inference pattern Phase 1 copies.
- `packages/exchange/src/initialize.ts:123` and
  `packages/react/src/use-initialize.ts:43` — the two signatures to fix;
  `use-initialize.ts:64` is the delegation site between them.
- `packages/react/src/use-document.ts:40` — `UseDocument`'s declared call
  signature, which is both the TS2589 workaround to be careful of and the reason
  `useInitialize`'s draft will infer once bound: it returns a fully typed
  `DocRef<S, N>`.
- `tests/integration/tsconfig.json` — `"include": ["src/**/*"]`, which
  constrains where Phase 3's snippets can live.
- `turbo.json` — `verify.dependsOn: ["build"]`, already in place.
- `CHANGELOG.md` — the existing `# 2.0.0` section is the style model for
  reconstructed entries.
- `README.md:9–44` (Quick Start), `README.md:78–79` (Grow Without Rewriting).
- `packages/exchange/src/sync.ts:246` — `whenSettled(ref, opts?)` signature.
- `packages/exchange/src/governance.ts:87` — the real `Policy` surface.
- `packages/index/TECHNICAL.md:207` — `Source.fromExchange` contract.
- `packages/exchange/TECHNICAL.md:624` and `packages/react/TECHNICAL.md:432` —
  correct historical narration; leave alone.
- `scripts/release.ts` — `bump`, `publish`, `status`; groups derive from
  directory convention via `deriveGroup`.
- Root `TECHNICAL.md:164–172` — build and verify commands, the pnpm requirement,
  and the lockfile rule.
- `docs/migrations.md` — schema migration chains. Named here so it is not
  confused with the new upgrade guide.

# Alternatives Considered

**Bringing the examples into `pnpm verify`, versus leaving them out.** Wiring
them in would have caught the `initialize` inference bug automatically, and is
attractive on that basis. It costs more than it looks. Each example needs a
`verify` script as well as a config, because turbo runs npm scripts rather than
configs. Three examples need an ambient CSS module declaration, and
`prisma-counter` needs a generated Prisma client that does not exist on a clean
checkout. Worse, `turbo.json` declares `verify.dependsOn: ["build"]`, so two
examples would pull `bun src/build.ts` into the verify path — a full client
bundle through `@kyneta/cast`, a private experimental package — adding both
runtime cost and a new failure surface to every `pnpm verify`. None of that
makes 3.0.0 more correct: the example defect is fixed by Phase 1 in the library
itself, and the type-level regression test pins the signature directly. The
examples keep their current status for this release.

**Extracting README snippets to typecheck them, versus keeping snippets as
source.** The direct approach extracts fenced blocks to a scratch directory,
prepends a preamble of ambient declarations, invokes the compiler, and parses
the output. It works, but it rebuilds the `types` task that already runs in all
24 packages, needs a new output parser, and interleaves parsing, file writing,
process invocation and result interpretation with no separately testable core.
Keeping the snippet as ordinary source inverts this: the compiler already covers
it, and what remains is pure string comparison. It also removes the preamble and
the opt-out mechanism, which exist only to serve extraction.

**Landing the drift guard before the README fix, versus after.** Building the
guard first is the better working method: it enumerates the broken snippets
instead of leaving them to a hand audit. But landing it first would commit a
revision in which the guard fails against the un-fixed README, so `pnpm verify`
is red in the middle of the stack and bisect stops being usable. Build first,
land second — the two are independent decisions.

**Fixing `initialize` after 3.0.0, versus before.** Deferring is tempting
because the API works, in the sense that it runs. But the type parameter is part
of the published surface: after 3.0.0, correcting it is a breaking change
needing its own major or a deprecation cycle. Before publication it costs one
signature edit and repairs the callers it currently forces into `unknown`.

**Reconstructing 2.2.0–2.3.2, versus a single note that they went out
undocumented.** A note is cheaper and honest, but leaves a user upgrading from
2.3.2 with no way to learn what changed under them, and the information is fully
recoverable from 22 commits. Reconstruction is chosen because the cost is
bounded and known — and bounded further by the changelog rule, since most of
those 22 commits changed nothing a downstream user can observe and so produce no
entry.

**Blanket `sideEffects: false`, versus a per-package audit.** A per-package
audit is the careful form, and is what Task 7.1 does — the blanket edit is
applied only if the audit comes back empty. The distinction matters going
forward: the flag is a standing claim, so the commit records the check that
justifies it.

**Refreshing `bun.lock`, versus deleting it.** Refreshing looks right given that
bun runs the release script and one test suite. But both run against a
pnpm-installed `node_modules` and read no lockfile, and refreshing would require
`bun install` — precisely the command root `TECHNICAL.md` says does not work in
this monorepo. Deletion is the only option that leaves a consistent repository.
