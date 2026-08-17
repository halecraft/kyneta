refactor(schema): derive descendant delivery from paths instead of a subscription graph

# Background

Every schema-issued ref carries a `[CHANGEFEED]` with two channels
(`packages/schema/TECHNICAL.md` §"Recursive changefeed"):

- `subscribe` — own-path only.
- `subscribeDescendants` — own-path *plus* every descendant, each change
  carrying its path relative to the subscription point. The facade
  `subscribe(ref, cb)` is this one.

Own-path delivery is **path-keyed**. A node registers a callback in a shared
`Map<pathKey, Set<cb>>` via `listenAtPath`, and `deliverNotifications` looks it
up by the changed path's key. Nothing is bound to a ref object, so it survives
anything that reshapes the document.

Descendant delivery is **object-keyed**. Each composite subscribes to its
children's changefeeds and re-prefixes their ops upward, holding references to
the child ref objects that existed at wiring time. That graph has to be repaired
whenever the document's shape changes, and each dynamic composite grew its own
repair machinery to do it — `createSequenceChangefeed` keyed by stable address
ID, `createMapChangefeed` by entry key, `createTreeChangefeed` by TreeID.
`packages/schema/TECHNICAL.md` §"Dynamic-collection changefeed factories"
documents all three as instances of one pattern.

Products got no repair machinery, because a product's fields are fixed. But a
**sum's** carrier is not fixed: `withChangefeed.sum()` is a pass-through
("Sum nodes are structurally transparent"), so a sum has no changefeed of its
own and `sumRef[CHANGEFEED]` resolves to *the live variant's* feed.

# Problem Statement

**Subscribing to a document while a `.nullable()` field is null permanently
loses every interior write to that field.**

`createProductChangefeed.wireChildren()` runs once, latched by
`childWiringDone`, and binds to whatever `productRef[key]` returns at that
moment. If the sum is null then, the product binds to the null variant's leaf
feed. When the variant later becomes a struct, that is a different carrier with
a different feed, and writes inside it are delivered where nobody is listening.
The latch never resets, so the subscriber never recovers.

Measured on `json` — the reference substrate — with no Exchange involved:

```
subscribe while null:
  optional.set({from:1,to:7})  → notifies "optional"
  optional.to.set(2)           → notifies NOTHING
  optional.to.set(3)           → notifies NOTHING
  optional.set({from:9,to:9})  → notifies "optional"
  optional.to.set(4)           → notifies NOTHING

subscribe after populating: every interior write notifies "optional.to",
and keeps working across null → populated round-trips.
```

Whole-value writes keep working because they are own-path ops, and own-path
delivery is path-keyed. That asymmetry is the entire bug: **one relation
represented two ways, and only the derived-on-demand one is correct.**

Two consequences, both silent:

- **Sync.** `Runtime.#wireDocSubscription` subscribes when a document is
  created, before anything is written, so every Exchange-managed document is in
  the broken case. No changeset means no `onDocChangeset`, no
  `notifyLocalChange`, no offer. The write reaches the substrate and syncs only
  when some later unrelated write triggers an offer. `tests/conformance`
  currently fails on all five substrates for exactly this.
- **Reactivity.** `@kyneta/reactive`'s `deep` aspect subscribes via
  `subscribeDescendants` (`packages/reactive/TECHNICAL.md`), so React's
  `useValue` / `useTracked` miss the same writes. "Render, populate an optional
  field, edit one of its leaves" shows a stale UI with no error.

# Success Criteria

- Subscribing before a sum is populated notifies on interior writes, and keeps
  notifying across variant shifts.
- `tests/conformance` returns to green on all five substrates. That suite is
  currently red on purpose; returning it to green is the acceptance test.
- Descendant delivery holds no reference to any ref object. Reshaping a
  document — variant shift, insert, delete, reorder, tree move — cannot orphan a
  subscription, because there is nothing to orphan.
- The per-composite repair machinery is deleted, not extended.
- Observable delivery semantics are unchanged: per-path batching, relative paths,
  own-path-as-`[]`, and the tree's terminal-on-delete.

# ✅ Phase 1 — Pin the behaviour that must not change

The delivery contract is subtle and mostly untested at the seams this change
touches. Pin it first, so a later failure names which property broke.

- ✅ Add a schema-package test for the bug itself: subscribe while a
  `.nullable()` struct is null, populate it, write a leaf, and assert the
  subscriber saw it. This is the non-sync half of the defect and belongs next to
  the code, not only in the conformance suite.

- ✅ Pin **per-path batching**. A root descendant-subscriber receives one
  changeset *per changed path*, not one per flush. A three-field batch delivers
  three changesets. This is easy to "simplify" into a single grouped changeset,
  which would silently change the contract.

- ✅ Pin **relative paths**, including the own-path case. A subscriber at the
  node itself receives `path: []`; a subscriber N levels up receives the N-segment
  relative path. Cover a sequence item and a tree node, where the path segments
  are address-bearing rather than plain field names.

- ✅ Do **not** pin cross-level ordering. Measured: subscribing root→outer→leaf
  delivers `["root","outer","leaf"]`, and reversing the registration order
  reverses the delivery order. It is an artifact of registration sequence, not a
  contract. The new implementation should choose a deterministic order and
  document it rather than reproduce an accident.

# ✅ Phase 2 — The traversal

- ✅ Extend `NotificationPlan` with a representative `Path` per group key:

  ```ts
  export interface NotificationPlan {
    readonly grouped: ReadonlyMap<string, readonly ChangeBase[]>
    readonly paths: ReadonlyMap<string, Path>
  }
  ```

  The walk must be structural, and a key string alone cannot support that. This
  is an additive change to an exported type (`NotificationPlan` and
  `planNotifications` are both public).

- ✅ Add a second path-keyed map for descendant subscribers, alongside
  `listeners`, on `ContextWiringState`. Thread it through `ensurePrepareWiring`
  and `wireChangefeed` exactly as `listeners` is threaded. Add
  `listenDescendants(map, path, cb)` mirroring `listenAtPath`.

- ✅ Implement the walk in `deliverNotifications`. For each changed path (the
  existing per-path loop), walk its ancestor chain and deliver to any ancestor
  with descendant subscribers, rebasing the ops to the relative path.

- ✅ Walk **structurally** — take the first N segments, then compute their key
  (`path.slice(0, i).key`). Do not derive ancestors by cutting the joined key
  string on its separator. Joining is lossy: a segment whose own text contains
  the separator makes the split invent a level that never existed, and a
  subscriber at that phantom path would receive ops from an unrelated subtree.
  Verified — for an entry key containing the separator, the structural walk
  yields `["", "m", "m\0x\0y"]` while the string split yields
  `["", "m", "m\0x", "m\0x\0y"]`. `markPopulated` already walks structurally for
  the same reason. Leave a comment saying so; the shortcut is tempting and its
  failure is invisible.

- ✅ Allocate the rebased relative path only where a subscriber actually exists.
  A deep tree with few subscribers should pay lookups, not allocations.

- ✅ Deliver deepest-first, and say in a comment that the order is chosen rather
  than emergent.

# ✅ Phase 3 — Delete the subscription graph

Every composite's `subscribeDescendants` becomes one line: register at this
node's path. The factories stop needing any access to the ref tree.

- ✅ `createProductChangefeed` — delete `wireChildren` and `childWiringDone`.
- ✅ `createSequenceChangefeed` — delete `subscribeToItem`, `itemUnsubs`,
  `getAddressTable`, `subscribeToAllItems`, `handleStructuralChange`,
  `initialWiringDone`. The address-table lookup existed solely to keep
  subscriptions keyed by something stable across reorders; path keys already
  encode the stable address ID (`AddressedPath.computeKey` emits `@${seg.id}`
  for index segments), so the walk gets that property for free.
- ✅ `createMapChangefeed` — delete `subscribeToEntry`, `entryUnsubs`,
  `subscribeToAllEntries`, `initialWiringDone`.
- ✅ `createTreeChangefeed` — delete `subscribeToNode`, `nodeUnsubs`,
  `tearDownForwarder`, `subscribeToAllNodes`, `initialWiringDone`. Keep the
  terminal (next phase).
- ✅ Stop fanning own-path changes out to tree subscribers in `fanOutOwnPath`.
  The walk's deepest step *is* that case; firing both would double-deliver.
- ✅ Drop the now-unused factory parameters — `getItemRef`, `getLength`,
  `getEntryRef`, `getKeys`, `getNodeRef`, `getLiveIds`, and the product's
  `productRef` / `fieldKeys` — and their call sites in `withChangefeed`. That
  these become unused is the load-bearing evidence that routing was never a
  property of the ref graph: a changefeed needs `(listeners, path, readCurrent)`
  and nothing more.
- ✅ `prefixOps` becomes unused. It is module-internal (not exported from
  `src/index.ts`), so delete it and update the one test that imports it directly.
  `liftToOps` survives, used by the tree terminal.

# ✅ Phase 4 — Preserve terminal-on-delete

The tree's one genuinely extra responsibility, and the only thing in these
factories that is not routing.

- ✅ Keep `deliverDeleteTerminal`, driven by scanning `TreeChange` delete
  instructions in the tree's own-path listener. This scan never depended on the
  forwarder bookkeeping — `packages/schema/TECHNICAL.md` already calls it an
  "independent scan" — which is why removing the forwarders leaves it intact.

- ✅ Fire **both** subscriber channels from the terminal. This is the one place a
  synthetic event is injected rather than derived from an op, so it is the one
  place both maps must be fed by hand. The facade `subscribe` is
  `subscribeDescendants`, so a per-node subscriber lives in the descendant map;
  `.subscribe(cb)` on the node lives in the own-path map. Missing the descendant
  channel is the failure this phase exists to prevent — it is what two
  `tree-changefeed.test.ts` cases catch.

- ✅ Note in a comment why the terminal bypasses the notification plan: it must
  reach the deleted node only, never its ancestors, since the tree already
  reported the delete via its own-path change and an ancestor receiving both
  would see it twice.

# ✅ Phase 5 — Documentation

`packages/schema/TECHNICAL.md` documents the deleted design in detail, so this is
a real rewrite rather than a touch-up.

- ✅ §"Dynamic-collection changefeed factories" — the three-factory comparison
  table and the "own-path listener + per-key forwarder map + structural-change
  wire/unwire" pattern describe code that no longer exists. Replace with the
  ancestor walk, and state plainly what it replaced and why: three hand-written
  repair mechanisms existed to keep a derived structure aligned with a document
  whose shape changes at runtime, and the relation they encoded is recomputable
  in O(depth) at delivery.

- ✅ Same section — the paragraph on "the dynamic-lookup property of
  `deliverNotifications`… same-batch wiring correctness" is obsolete. There is no
  wiring, so same-batch correctness is not a property that needs arguing.

- ✅ §"Terminal-on-delete" — the identity-semantics justification for why only
  trees get a terminal is still correct and worth keeping. Update the mechanism,
  and delete the "Last-subscriber teardown is distinct from terminal-on-delete"
  paragraph, which describes forwarder teardown that no longer happens.

- ✅ §"Recursive changefeed" — "For a composite ref, `subscribeDescendants`
  aggregates own-path changes with children's tree-streams" is now wrong. Every
  node registers at its own path; aggregation happens at delivery.

- ✅ Same section — the "pure helpers" paragraph claims `liftToOps` and
  `prefixOps` "form the entire shape-grammar of the changefeed delivery
  pipeline". With `prefixOps` gone, rebasing happens once at delivery.

- ✅ §"`planNotifications` → `deliverNotifications`" — pre-existing drift worth
  fixing while here: the documented signatures (`planNotifications(changes,
  addressTable)`, `deliverNotifications(plan, subscribers)`) do not match the
  code. Correct them and document the new `paths` field.

- ✅ `packages/reactive/TECHNICAL.md` — its "Subscription multiplicity" note
  records a deferred idea: *"Central op-stabilization (one shared index, resolve
  positional Op paths once at delivery) is the deferred scaling lever for the
  many-subscriber regime."* This change delivers the delivery-side half of that.
  Add a sentence pointing at it, so the deferred item is not re-planned from
  scratch.

- ✅ CHANGELOG entry under `@kyneta/schema`: the fix, the additive
  `NotificationPlan.paths` field, and no other public surface change.

- ✅ No README change. This is internal machinery; the documented user-facing
  behaviour is what was already promised.

**Comments.** Why, not what. Four carry real weight:

- ✅ On the walk — why ancestors are derived structurally and not by splitting
  the key string. This is the one place a plausible optimization is silently
  wrong.
- ✅ On `subscribeDescendants` in any one factory — why there is no wiring, with
  the sum case as the concrete reason a subscription to a child *object* goes
  stale.
- ✅ On the terminal — why it feeds both maps by hand and bypasses the plan.
- ✅ On `fanOutOwnPath` — why it no longer lifts to tree subscribers, so nobody
  restores it and creates double delivery.

# Tests

Reuse `packages/schema/src/__tests__/changefeed.test.ts`,
`tree-changefeed.test.ts` (terminal cases), `plan-notifications.test.ts` (pure
grouping), and `tests/conformance` (cross-substrate, through a real Exchange).

- ✅ **The bug, at the schema level** (Phase 1). Subscribe while null → populate →
  interior write → subscriber fires. Also assert it survives a null round-trip,
  since the old behaviour never recovered.
- ✅ **Per-path batching.** Three writes in one batch → three changesets at a root
  descendant-subscriber.
- ✅ **Relative paths.** Own-path `[]`; N levels up gives N segments. Include a
  sequence item and a tree node.
- ✅ **Structural reshaping cannot orphan a subscriber.** Subscribe at the root,
  then: switch a sum variant, insert before a subscribed sequence item, delete a
  map entry and re-add it, move a tree node. Every case must keep delivering.
  This is the class of bug the change eliminates, so it deserves a direct test
  rather than being implied by the existing suites.
- ✅ **Terminal-on-delete still fires**, via both `subscribe(node)` (descendant
  channel) and `node[CHANGEFEED].subscribe` (own-path channel). The existing two
  cases cover the first; add the second.
- ✅ **Ancestor derivation is structural.** A record entry whose key contains the
  separator character must not be treated as two path segments. Cheap, and it
  pins the reasoning behind the walk.
- ✅ **`tests/conformance` goes green** — all five profiles, no `.fails`, no
  skips. Its currently-failing scenario is the acceptance test.
- ✅ **Full `npm run verify`.** Backends and the conformance suite resolve
  `@kyneta/schema` to `dist/`, so `SKIP_BROTLI=1 npm run build` must run before
  they reflect core changes. A stale `dist/` silently reports the old behaviour.

# Transitive Effect Analysis [scratch]

**schema changefeed → `@kyneta/reactive` → `@kyneta/react` → applications.**
`reactive`'s `deep` aspect installs one `subscribeDescendants` per dependency
(`packages/reactive/TECHNICAL.md`), and `WatcherTable` is shared with
`@kyneta/index`. Delivery shape is what these consume, which is why per-path
batching and relative paths are pinned before anything moves. `react`'s
`createChangefeedStore` discriminates on `hasRecursiveChangefeed`; the protocol
shape is unchanged, so that discriminator still holds.

**schema changefeed → Exchange sync.** `Runtime.#wireDocSubscription` →
`onDocChangeset` → `notifyLocalChange` → offer. This chain is currently broken
for sum-interior writes and will start firing where it did not. Expect
`tests/conformance` to go green and no other suite to change — but the exchange
suite is the one to watch, since more changesets means more offers.

**`NotificationPlan` is public.** Exported from `src/index.ts` along with
`planNotifications`. Adding `paths` is additive, so existing consumers compile
unchanged. Worth stating in the CHANGELOG regardless.

**Address-table coupling disappears.** `createSequenceChangefeed` currently reads
`ADDRESS_TABLE` from `withAddressing` to key subscriptions by stable ID. After
this change the changefeed layer no longer consults the address table at all —
the stability it needs is already inside the path key. That removes a
layer-to-layer dependency, but it also means a bug in address-key generation
would now surface as mis-delivery rather than as a stale subscription. The
reshaping test above is the guard.

**`fanOutOwnPath` is called by every factory.** Changing it to stop lifting to
tree subscribers affects all of them at once. If any factory is migrated without
the others, that node double-delivers. Phases 2 and 3 must land together.

**Delivery volume.** Previously an ancestor with no subscribers still cost a
propagation hop (guarded by `treeSubs.size === 0`). Now it costs a map lookup.
Both are O(depth) per changed path; the new one allocates strictly less, since
`prefixOps` allocated a Changeset and a Path per level.

# Resources for Implementation [scratch]

- `packages/schema/src/interpreters/with-changefeed.ts` — the whole change.
  `planNotifications` / `deliverNotifications`, `listenAtPath`, `markPopulated`
  (the existing structural ancestor walk to model on), `fanOutOwnPath`, and the
  five `create*Changefeed` factories.
- `packages/schema/src/path.ts` — `computeKey` for `RawPath` (line ~494) and
  `AddressedPath` (line ~764). The latter's `@${seg.id}` for index segments is
  what makes path keys survive reorders.
- `packages/schema/src/facade/observe.ts` — `subscribe` is `subscribeDescendants`;
  `subscribeNode` is the shallow channel.
- `packages/schema/TECHNICAL.md` — §"Recursive changefeed",
  §"`planNotifications` → `deliverNotifications`", §"Dynamic-collection
  changefeed factories", §"Terminal-on-delete", §"Per-ref-instance listener
  multiplication".
- `packages/reactive/TECHNICAL.md` — the `deep` aspect and the "Subscription
  multiplicity" note.
- `packages/exchange/src/runtime.ts` — `#wireDocSubscription`, the subscription
  whose timing exposed the bug.

# Alternatives Considered

**Re-wire a product's child when that child is replaced.** Detect an op at a
child's exact path and re-run wiring for it. Proven to work — full suite green —
and it is the smallest possible diff. Rejected as the answer: it adds a fourth
hand-written repair mechanism to a design whose problem is hand-written repair.
It also fixes only the product case, leaving sequence, map, and tree each
carrying their own version of the same workaround.

**Give sums their own changefeed** so a variant shift is observable and can
trigger re-wiring. Rejected on two counts. It contradicts an explicit design
decision — `withChangefeed.sum()` is a pass-through because sums are
structurally transparent, and the resolved variant already carries the protocol.
And it still leaves the object graph in place, so the same staleness would
remain reachable by any other means of reshaping a document.

**Derive ancestor keys by splitting the joined key string.** Allocation-free and
tempting. Rejected on correctness: joining segments is lossy, so splitting can
invent a path level that never existed and deliver ops across unrelated
subtrees. This was measured, not assumed. It was also very nearly adopted — an
early check compared the two on a path with no separator in any segment, where
they agree by construction, and the "verification" proved nothing.

**Group all of a flush's ops into one changeset per subscriber.** Would fall out
of the ancestor walk naturally and looks tidier. Rejected: measured current
behaviour is one changeset *per changed path*, so grouping would silently change
a contract that `@kyneta/reactive` and `@kyneta/index` consume.

**Merge this walk with `markPopulated`'s.** Both walk ancestors over path keys,
so sharing one pass looks obvious. Rejected: they differ in schedule and policy.
`markPopulated` fires eagerly per-prepare; delivery is batched at flush. And
`populated` is a monotonic latch that fires once per key, deletes its listeners,
and short-circuits as soon as it meets an already-marked ancestor, whereas
delivery fires every time and must reach every ancestor. Share the traversal
helper if it is worth extracting; do not merge the passes.
