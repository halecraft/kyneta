# @kyneta/devtools — Technical Reference

> **Package**: `@kyneta/devtools`
> **Role**: A reactive **world model** folded from the Kyneta observation (`ObsEvent`) stream, composed from existing machinery — `@kyneta/index` (append logs + cross-peer grouping) and `@kyneta/changefeed` `ReactiveMap`s (LWW current-state). The only bespoke logic is one pure classifier.
> **Depends on**: `@kyneta/index`, `@kyneta/changefeed`, `@kyneta/exchange` (the `ObsEvent` type; `observe` at runtime inside `attach` / `streamObservations` / `logObservations`)
> **Depended on by**: DevTools renderers (in-app panel, multi-peer inspector — not yet built); NDJSON consumers (tail / pipe / record the observation stream)
> **Canonical symbols**: `classify`, `Routing`, `WorldStream`, `createWorldModel`, `WorldModelHandle`, `CreateWorldModelOptions`, `attach`, `ObservableExchange`, `WorldModel`, `PeerView`, `DocView`, `SyncEntry`, `DiagnosticEntry`, `WorldMapChange`, `docView`, `docActivity`, `syncFor`, `timeline`, `DocViewComposite`, `serializeObservation`, `parseObservation`, `streamObservations`, `ingestObservations`, `ingestObservationStream`, `convergence`, `ConvergenceState`, `stalledDocs`, `formatObservation`, `logObservations`, `LogObservationsOptions`
> **Key invariant(s)**:
> 1. The world model is folded **purely from the `ObsEvent` stream** — never by reaching into the live Exchange. This keeps it delivery-agnostic (the same fold consumes one peer's `observe()` and a merged multi-peer stream).
> 2. The only bespoke logic is `classify` (pure, total). Grouping, joins, integration, and reactivity are reused `@kyneta/index` + `@kyneta/changefeed`.
> 3. Cross-peer correlation is keyed on the genuinely-shared `docId`. Frame `seq` is **not** a cross-peer key (see below).

`@kyneta/devtools` turns the producer-side `exchange.observe(sink)` stream (from `@kyneta/exchange`, jj:qpmkoryn) into a queryable, reactive model a renderer can bind to. Experimental — tracks `ObsEvent` v1.

---

## Architecture

**Thesis**: observation is *another interpreter of the event stream*, and the world model is *composed from the framework's own data primitives* — so it inherits their rigor (DBSP ℤ-set algebra, the changefeed protocol) instead of re-deriving it.

```
exchange.observe()  ─→  classify(event)  ─→  per-stream backing stores  ─→  views
  (ObsEvent stream)       (pure routings)     index Collections (append)     [CHANGEFEED]
                                              changefeed ReactiveMaps (LWW)
```

| Concern | Primitive | Why |
|---------|-----------|-----|
| Event log, diagnostics | `@kyneta/index` `Collection` (`Source.create` + `Collection.from`) | append-only, unique keys (`${peerId}:${seq}`) |
| Cross-peer `byDoc` grouping | `@kyneta/index` `Index.by(events, keySpec)` | incremental grouping on the shared `docId` |
| Cross-peer `syncByDoc` grouping | `@kyneta/index` `Index.by(Source.fromReactiveMap(syncStates), …)` | per-doc sync status across peers — the LWW map bridged into the index (jj:qwzkmzvy) |
| Peers, documents, sync status | `@kyneta/changefeed` `createReactiveMap` | **LWW current-state** — a value that mutates per key |
| Reactivity | `[CHANGEFEED]` (every view is one) | renderers `useValue(model.peers)` — granular, no monolithic model feed |

### The pure classifier (the only bespoke logic)

`classify(event: ObsEvent): readonly Routing[]` (`src/classify.ts`) maps one event to backing-agnostic mutations — `{ stream, op: "set" | "delete", key, value? }`. Total: an unknown layer/kind routes only to `events` and never throws. It does not know how a stream is backed (Collection vs ReactiveMap) — the shell (`src/world.ts`) decides that. This is the unit-tested functional core; everything else is reused machinery or thin wiring.

### Why LWW state is NOT an index `Collection` (and how it still feeds the index)

`@kyneta/index` `Collection`s are *membership-oriented*: a manual `Source.set(key, value)` emits an `added` delta **only for a new key** — re-setting an existing key to a new value emits nothing, so the value never updates downstream (and index has no aggregation operator). Sync status mutates (`pending → synced`), so `peers`/`documents`/`syncStates` are `@kyneta/changefeed` `ReactiveMap`s (overwrite-by-key + `emit`) — the same primitive `exchange.peers` uses. `events`/`diagnostics` have unique keys, so index `Collection`s fit them. Context: jj:pusmrzuy.

To **group** an LWW map, the map is bridged into the index via `Source.fromReactiveMap`: an in-place value update lowers to retract+insert at the source boundary (the DBSP/Materialize UPSERT envelope), so `syncByDoc = Index.by(Source.fromReactiveMap(syncStates, { equals }))` is an incrementally-maintained grouping rather than a linear scan. `equals` (a shallow `SyncEntry` compare) suppresses no-op re-emits. The base `syncStates` `ReactiveMap` is unchanged — a renderer still reads current status from it directly. Context: jj:qwzkmzvy.

### Cross-peer correlation: `docId`, not frame `seq`

`docId` is shared by every peer → `byDoc` (grouping doc-scoped events across peers) is correct under any topology. Frame `seq` is **not** a cross-peer key: it is per-(channel, direction), so counters collide across channels and across the two directions of one channel; `channelId` is peer-local (minted per synchronizer), not shared. Raw frame send↔receive pairing (`Index.join` on `seq`) is therefore omitted — a spurious thread is worse than none. A correct frame-level join awaits a content-addressed `Frame.hash` (reserved in the wire format), a separate wire-layer feature.

### Retention

`@kyneta/index` has no windowing ("not a window"). Both append logs self-bound via `boundedHandle(handle, cap)` — FIFO eviction of the oldest-inserted key past `cap`: `events` (`eventCap`, default 5000) and `diagnostics` (`diagnosticCap`, default = `eventCap`).

### Ordering

`timeline` / `docActivity` order by `(peerId, seq)`. Per-peer order is **exact** (the bus `seq` is monotonic per peer); there is no cross-peer clock, so the merged interleave is stable-per-peer — never claimed as a global total order.

### Selector discipline (snapshot reads)

`select.ts` selectors read group **membership** from a `SecondaryIndex`'s `.current` (`Map<groupKey, Set<entryKey>>`) and resolve **values** from the base store (`events` / `syncStates`). They never call `SecondaryIndex.get(key)`: that allocates a fresh `ReactiveMap` + a parent subscription retained until index `dispose()` on *every* call — a leak under repeated rendering. `.get()` is reserved for a renderer that genuinely holds one group's live subscription. Context: jj:qwzkmzvy.

### Observation stream — egress / ingest (the two planes)

Observability splits into two planes (jj:kvulloro):

- **Observation plane** — events, sync status, diagnostics, directory, op-*summaries*. `ObsEvent` is plain JSON, folds without an Exchange, location-independent. **This plane egresses.**
- **Interpretation plane** — actual doc *values*. Needs the substrate + schema; in-process only. The stream carries op summaries (`ChangesetBody.ops` = `{ type, path? }`), never values or CRDT bytes — so it does not cross a process boundary.

`src/stream.ts` is the observation plane's **data path**, platform-neutral (sinks are `(line) => void`, sources are `Iterable`/`AsyncIterable<string>` — no Node `Writable`/`stdout`/`console`):

- `serializeObservation(event) → string` / `parseObservation(line) → ObsEvent | undefined` — the NDJSON line codec. `parse` is **tolerant**: blank/torn input *and* valid-JSON scalars (`null`/`42`/`"x"`) return `undefined`. The guard is structural (reject anything not an object carrying `peerId`/`seq`) so a torn line never reaches `classify`; `v` is preserved and unknown layers survive — forward-compat, not a validation boundary.
- `streamObservations(exchange, write) → detach` — taps `exchange.observe`, writes `serialize(ev) + "\n"` per event. Passive (inherits `observe`'s zero-cost-when-unobserved + fire-and-forget); no producer/core change.
- `ingestObservations(lines, model)` / `ingestObservationStream(asyncLines, model)` — fold NDJSON back into a `createWorldModel()` with **no Exchange** (reusing `model.ingest`). Malformed lines are skipped (total, never throws). The caller frames bytes into lines (e.g. Node `readline`); this consumes one line per item.

This cashes out the delivery-agnostic invariant: egress → ingest reconstructs the same `peers`/`documents`/`syncStates` a direct `attach` reaches (proven by the two-peer round-trip test). Useful standalone: `… | jq 'select(.layer=="diagnostic")'`.

**Scope**: local egress only. Network / cross-machine egress + auth, and the `Line`-native (`discriminatedSum`) schema-validated egress, are deferred — and the latter is where real validation belongs (Kyneta's own schema algebra, not a third-party validator). Context: jj:qpqwrlsx.

### Convergence + staleness projections

`convergence(model) → ConvergenceState` (`src/select.ts`) is a **pure, clock-free** rollup over `syncStates` + the structured diagnostics: `pending` counts only `state === "pending"` (`synced`/`vacant` are terminal/non-blocking — `vacant` is the settled "peer isn't syncing this"); `stuck` gates on **`error` severity** (warnings — e.g. protocol minor-skew — never gate) and is **per-doc where attributable** (`stuckDocs` = pending docs that also carry an `error` diagnostic for that `docId`); a peer/protocol error (`self-connection`/`protocol-mismatch`, no `docId`) yields a *global* `stuck` with empty `stuckDocs`. `state = pending === 0 ? "converged" : errors > 0 ? "stuck" : "syncing"`. Reads `severity`/`docId` off `DiagnosticEntry` — no join back to `events` for the structured `code` (that is only the formatter's concern).

Limitations (honest, same register as the `seq`-isn't-cross-peer and egocentric caveats): (1) `pending` counts only `"pending"`; (2) `stuck` errs **loud** — a past (possibly resolved) `error` still reads `stuck` while unrelated work is pending (`diagnostics` is a bounded append log; "diagnostics since converged" is a noted refinement); (3) a hard failure that prevents a doc from ever becoming `pending` reads `converged` in the header while its diagnostic still surfaces in the diagnostics view.

`stalledDocs(model, { now, quietMs }) → string[]` is the clock-**injected** counterpart (the shell supplies `now`; `convergence` itself keeps no clock — clean FC/IS). Returns the pending docs whose latest observed event `t` is older than `now - quietMs` (reusing `docActivity`'s max `t`; a pending doc with no surviving activity is skipped). `ObsEvent.t` is the *emitter's* wall-clock — pass `Date.now()` for a live in-process tap, the latest observed `t` (or disable the hint) for a recorded/remote stream where wall-clock isn't comparable.

### Diagnostics-loud log head

`formatObservation(event, { color? }) → string` (`src/log.ts`) is a **pure** correlated one-line render keyed `peerId:seq` + layer + a per-layer summary; `diagnostic` events render their **structured cause** (`severity` + `code` + `local`/`remote`), not just the message. ANSI is optional and off by default (portable, hand-rolled — no `chalk`). `logObservations(exchange, opts?) → detach` is the shell: prints each event via `formatObservation` and escalates `error`-severity diagnostics (default `console.error`; warnings print normally; `onDiagnostic` overrides). `console` lives only in this shell — it is universal (browser/Deno/Node), unlike `process.stdout`; the data path (`src/stream.ts`) stays sink-only.

---

## Public API

| Symbol | Role |
|--------|------|
| `createWorldModel(opts?) → WorldModelHandle` | Build an empty model. `ingest(event)` (manual / merged-stream entry), `dispose()`, and the views. |
| `attach(exchange, model) → () => void` | Subscribe `exchange.observe` → `model.ingest`; returns detach. Caller owns the model. |
| `classify(event) → Routing[]` | The pure routing core (exported for testing/reuse). |
| `docView` / `docActivity` / `syncFor` / `timeline` | Pure selectors over the live views. |
| `serializeObservation` / `parseObservation` | NDJSON line codec — tolerant structural-guard parse; preserves `v`. |
| `streamObservations(exchange, write) → detach` | Egress: tap `observe`, write one NDJSON record per event to a `(line) => void` sink. |
| `ingestObservations(lines, model)` / `ingestObservationStream(asyncLines, model)` | Fold NDJSON back into a model with **no Exchange** (skips malformed lines). |
| `convergence(model) → ConvergenceState` | Pure clock-free rollup: `converged`/`syncing`/`stuck` + per-doc `stuckDocs`. |
| `stalledDocs(model, { now, quietMs })` | Clock-injected staleness hint (pending docs quiet too long). |
| `formatObservation(event, { color? }) → string` | Pure one-line render; diagnostics show their structured cause. |
| `logObservations(exchange, opts?) → detach` | Shell: print each event + escalate `error` diagnostics (default `console.error`). |

`WorldModel` fields: `events`, `diagnostics` (index `Collection`s); `peers`, `documents`, `syncStates` (`ReactiveMap`s); `byDoc`, `syncByDoc` (`SecondaryIndex`es).

## File Map

| File | Role |
|------|------|
| `src/classify.ts` | The pure classifier — `ObsEvent → Routing[]`. The only bespoke logic. |
| `src/model.ts` | `WorldModel` shape + view value types (`PeerView`/`DocView`/`SyncEntry`/`DiagnosticEntry`). |
| `src/world.ts` | Shell: per-stream backing (index `Collection`s + changefeed `ReactiveMap`s), `byDoc` + `syncByDoc` groupings, the uniform `WriteTarget` table (`lwwTarget`), `createWorldModel`, `attach`, `boundedHandle`. |
| `src/select.ts` | Pure selectors (`docView`, `docActivity`, `syncFor`, `timeline`) + projections (`convergence`, `stalledDocs`) — membership from index `.current`, values from the base store. |
| `src/stream.ts` | Observation-plane data path: NDJSON codec (`serializeObservation`/`parseObservation`), egress (`streamObservations`), Exchange-free ingest (`ingestObservations`/`ingestObservationStream`). |
| `src/log.ts` | Diagnostics-loud head: pure `formatObservation` + the `logObservations` shell (sink + `error` escalation). |
| `src/index.ts` | Public barrel. |

## Testing

`classify.test.ts` is pure (ObsEvent literals → routings; totality). `world.test.ts` / `views.test.ts` run a two-peer `Bridge` (`@kyneta/bridge-transport`), merge both peers' `observe()` streams into one model, and assert convergence + the cross-peer `byDoc` / `syncByDoc` groupings + `events`/`diagnostics` retention + selector-call stability. `stream.test.ts` adds the pure codec round-trip (`toEqual`, since the producer emits explicit `undefined` optionals that `JSON.stringify` drops) + tolerant-parse (blank/torn/scalar/identity-less) + a two-peer egress→ingest round-trip (the delivery-agnostic proof) + detach; `select.test.ts` covers `convergence`/`stalledDocs` from `ObsEvent` literals (no clock); `log.test.ts` covers `formatObservation` + the `logObservations` escalation/detach shell. **Tests**: 38 passed. Run with `cd packages/devtools && pnpm verify`.
