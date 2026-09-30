# Undo probes: what Yjs and Loro give a durable, selective undo

Measured on yjs 13.6.30 and loro-crdt 1.16.1, with disposable vitest scripts
beside each backend. Every scenario ran across a reload: the step's record was
kept, the document rebuilt from its full state in a fresh `Y.Doc` (gc on) or
`LoroDoc`, and the undo run there.

## Answers

1. **Yjs undo can be built on its public API alone, and survives a reload
   with gc on.** A relative position built from a deleted item's id
   (`createRelativePositionFromJSON({ item: { client, clock } })`), or from the
   pre-state index before the delete (`createRelativePositionFromTypeIndex`),
   resolves after gc and a reload to where the run was, with edits by others on
   both sides (1a). Re-inserting the saved text there restored the document
   exactly.
2. **Deleting exactly my own inserts spares a collaborator's typing.** My
   insert ranges come from `afterState − beforeState`. After a reload, the ones
   still alive (`Y.isDeleted(Y.snapshot(doc).ds, id)`) resolve to indices
   through relative positions, and deleting those removed my text and kept
   what a collaborator typed inside it (1d). Resolving one anchor in a 20,000
   item text took 0.2 ms (1e).
3. **An anchor into a type whose parent was deleted resolves to `null`**, live
   and after a reload (1c): gc turns the children into bare stubs. Restoring a
   deleted nested value has to come from a saved value (Kyneta's inverse
   already holds it), not from anchors. The content is still readable in
   `afterTransaction`, which fires before gc (verified in `Transaction.js`).
4. **"Is my map write still current?" is `!isDeleted(my entry id)`**, and it
   answers correctly live and after a reload for an overwrite (2b), a deleted
   key (2d) and a deleted parent map (2e). A concurrent overwrite is decided by
   who won: if mine won, it is current (2c). The previous entry's id is in the
   transaction's `deleteSet` (2f).
5. **The Yjs id rule needs an id substitution for my own later steps (2g).**
   Step 1 sets `b`, step 2 sets `c`. Undoing step 2 writes `b` again as a new
   entry, so step 1's entry is deleted, and without a substitution its undo is
   skipped (result `b`). Recording "step 1's entry is now the new one" when
   step 2 is undone gives `a`.
6. **Capture: `afterTransaction` is enough, and `transaction.local` separates
   local from remote.** For every Kyneta batch and every native write it shows
   the insert ranges, the deleted structs and the changed types (3a, 3c). A
   merge has `local = false` (3c).
   - **Its order against the changefeed differs by route.** A Kyneta batch
     fires `afterTransaction` before its changeset. A native write or a merge
     delivers its changeset first. Capture must not depend on either order.
   - **The delete clock writes its own local transactions.** A delete-only
     transaction is followed by a tick inserting and deleting one character in
     `kyneta.clock`. After a native write or a merge there is also an empty
     local transaction. Capture must ignore the clock type and empty records.
   - **An aborted batch is one real transaction** (3b). Its compensation of a
     never-set scalar writes the default as a new entry, so it is not empty.
     Capture has to skip it by knowing the batch aborted, not by its content.
7. **Pre-existing hazard: Yjs's own `UndoManager` captures Kyneta merges.**
   It tracks `origin === null` by default, and `merge` passes
   `options?.origin`, which is `null` when omitted (3c: `local=false
   origin=null`). The exchange always merges with `"sync"`, but a direct
   `merge` without an origin is recorded as undoable: with the defaults, the
   first undo removed a peer's merged text. Scoping the manager to the root
   map with `captureTransaction: tr => tr.local` removed only local writes.
   The Yjs backend's TECHNICAL.md now says so (§ Using `Y.UndoManager`). Our
   capture keys on `transaction.local`, so it is immune.
8. **Loro undo can be built on `diff`/`applyDiff` over history, and matches
   Loro's own manager.** A step's record is its two frontiers and a container
   id. After a reload, `diff(after, before)` is its inverse, `diff(after, now)`
   is everything since, and a text transform of the one over the other gave
   `">> hel_lo world <<"` (4a), exactly what Loro's `UndoManager` gave in the
   same scenario (6b). A collaborator's `_` typed inside my insert survived.
9. **`diff` covers every Loro type, and the raw inverse is exact at the tip**
   (4b): map, counter, list, movable list, tree (a real `move` with
   `oldParent`/`oldIndex`), and nested containers. A deleted list item holding
   a map with a text inside is restored whole (4e). A removed key is
   `undefined` in `updated`.
10. **A movable-list move is undone as delete-and-insert, by `diff` and by
    Loro's own manager alike** (4f, 6e). The element loses its identity: when a
    peer concurrently moves the original, the list ends up with it twice
    (`["x","y","z","x"]`). Loro reports a movable list's diff as `list`, with
    no moves.
11. **A shallow snapshot cuts `diff` off with a clear error** ("You cannot
    switch a document to a version before the shallow history's start
    version", 4c). A step older than the shallow root is simply not undoable.
12. **Loro's anchors can't carry the Yjs algorithm.** A cursor to a deleted
    character resolves (5a), but `getLastEditor` names only a peer, so it
    cannot tell my step's write from my later one (5b), and there is no public
    per-character op id to build a cursor from. Two algorithms, not one.
13. **Loro's own manager overwrites a later write by someone else; Yjs's
    skips it.** Undo restored `drawer` over a peer's `queue` (6a), and moved a
    tree node back over a peer's later move (6f). Yjs skips by default
    (`ignoreRemoteMapChanges`). The `diff` approach skips naturally: the key
    appears in `diff(after, now)` (4d).
14. **The state-based rule handles my own later steps without a
    substitution** (4g). Undoing step 2 then step 1 gives `a`: after step 2's
    undo, the key is back to what step 1 wrote, so `diff(after₁, now)` does not
    mention it.
15. **Both backends agree on a tie**: a deletion restored where a peer inserted
    at its boundary goes before the peer's text (`abXc`), by Yjs's own manager,
    by the Yjs anchor to the deleted item (1b) and by Loro's own manager (6d).
    The Loro transform must let the inverse win ties (`aFirst = true`); with
    the other side it gives `aXbc` (5c).

## Second round: direct writes, rich text, arrays, the delete clock

16. **A direct write to a schema type can be undone from Kyneta's shadow.**
    The Yjs event bridge announces a direct write after re-materializing σ
    (`syncShadow` in the `observeDeep` handler), so before that call σ is
    still the state before the write. An observer registered ahead of the
    bridge computed `invert(path.read(σ), op.change)` for a
    codemirror-style edit on a `Y.Text` (N1: `retain 3, insert "lo wo",
    delete 4`) and for a native `Y.Array.delete` of a list item holding a
    struct with a nested list (N2): the inverse held the whole value, and
    re-inserting it at the deleted item's anchor after a reload restored the
    document exactly. Doing this inside the bridge, before `syncShadow`, is
    the authored path's own inverse, reached by a second route.
17. **y-prosemirror's `XmlFragment` is out of reach.** It lies outside the
    schema, so the bridge sees nothing (N3: no ops). In `afterTransaction` the
    deleted element already reads as empty through the public API
    (`<paragraph></paragraph>`, no attributes). Its subtree could only be
    rebuilt from struct internals (`Item.parent`, `parentSub`, content
    classes), which is what this design avoids.
18. **Yjs's own `UndoManager` corrupts formatting when a peer typed inside a
    mark through Kyneta.** Undoing a bold over `hello` after a peer inserted
    `XX` inside and `YY` before left `llo world` bold, including text that
    was never bold (R1). Kyneta writes an unmarked insert inside a mark with
    format boundaries of its own; Yjs's manager deletes only my format items,
    so the peer's closing boundary re-bolds the rest. Unmarking the anchored
    range instead (start anchor on the first character, end anchor on the
    last, left-sticky) gave the right text, `YYheXXllo world`, all plain.
19. **Deleted rich text is restored with its marks** at its anchor after a
    reload (R2), from spans Kyneta's inverse carries.
20. **Loro rich text: the diff approach matches Loro's own manager** when the
    transform carries attributes on retains (R-Loro): both unbold `he` and
    `llo` and leave the peer's `XX` as the peer wrote it.
21. **Yjs arrays behave like text** (A1, A2): deleting my own inserted items
    by id spares a peer's item between them, and a deleted struct item is
    restored at its anchor after a reload.
22. **The delete clock needs no special case** (D1). Its tick is a local
    transaction whose one insert it deletes itself, so a record built from it
    has nothing alive to delete and nothing outside its own insertions to
    restore. A record is empty when it has no effect, and an empty record is
    dropped; no knowledge of the clock's type is needed.
23. **Kyneta's rich-text insert means "no marks" on both backends.** An
    unmarked insert inside or at the end of a bold range is plain on Yjs and on
    Loro alike. Only Loro's own API inherits the mark; that difference is
    Loro's, not Kyneta's.

## Third round: restoring a deletion, then undoing an older step inside it

The common sequence "type, delete what you typed (or the item holding it),
undo, undo" needs the second undo to find content the first undo re-created.
Neither CRDT can undelete: a restore inserts new items, or new containers,
with new ids.

24. **Without a remap, the older step silently does nothing, on both
    backends.** Loro: undoing a tree-node delete through `diff`/`applyDiff`
    re-created the node as `5@1`, and the older step's diff, addressed to the
    old node, changed nothing; the same for text inside a deleted list item.
    Yjs: the older step's inserted ids are dead.
25. **Loro's own manager remaps containers** (in a session): it undid the
    delete, then the typing inside the restored item (`"hi"`).
26. **Loro: a remap by structural pairing works.** The inverse diff lists
    the restored containers by their old ids (`cid:0@1:Map`,
    `cid:1@1:Text`); walking the restored value at the same place gives the
    new ones, and the older step's diff, retargeted through the map, undid
    the typing (L1). `getPathToContainer` returns `undefined` for a deleted
    container, so pairing walks the restored value rather than looking up
    the old path.
27. **Yjs: the ids of deleted text, in document order, come from public
    API.** In `afterTransaction`, before gc,
    `text.toDelta(Y.snapshot(doc), Y.createSnapshot(Y.createDeleteSet(),
    tr.beforeState), computeYChange)` marks each removed run with its item id;
    keeping the runs whose ids are in `tr.deleteSet` gives exactly this
    transaction's deletions, in order (`a1 b3 c2` for text typed out of
    order), for text directly deleted and for text inside a deleted list item
    (Y2, Y3). The call opens a transaction of its own, so the handler must
    guard against re-entry. A restore inserts one run, whose new ids are this
    client's consecutive clocks, so pairing old ids with new ones is
    positional; undoing an older insert through that map gave the right text
    (Y2). For an authored delete, `createRelativePositionFromTypeIndex` over
    the pre-state gives the same ids per index (Y1), for arrays as well as
    text.

## Fourth round: a step of several commits to one text

Reported downstream (Pineta): typing a word (one commit per keystroke,
grouped into one step), undoing it and redoing it gave `Goerom` for `Gomore`;
undoing a word backspaced a key at a time did the same.

28. **A `Y.Text` insert goes past the tombstones to its right**
    (`minimizeAttributeChanges` steps over deleted items); a `Y.Array` insert
    goes before them. A deleted run anchored to its own first item resolves
    to the index where its tombstone sits, which is right for one run. For
    several runs deleted one commit at a time, restoring the last deleted
    (`m`) puts `m'` past the tombstones `[m][o][r][e]`, and the next run's
    anchor, the tombstone `o`, resolves to before `m'`: each restore lands
    before the one above it, reversing the word. The remap cannot help, since
    `o`'s anchor names `o`, which is not re-created until its own restore.
    Anchoring each run just after the item before it (`assoc: -1`) and
    rewriting that id through the remap makes `o` land after `m'`. Loro and
    plain documents were not affected. The conformance suite now covers it.

## What this settles

- **Yjs:** anchors and ids through the public API for text and sequences. A
  record holds my inserted ids, my deleted ids in document order, and the
  values to restore (from Kyneta's inverse). Maps and scalars are
  state-based, as on Loro: a key is restored only while it still holds what
  the step wrote. That needs no map entry ids, which Yjs exposes only for
  one's own fresh write and never for entries re-created by a restore, and
  it handles one's own later steps as Loro does (4g) without the
  substitution 2g needed.
- **Loro:** `diff`/`applyDiff` with a Kyneta transform. A record holds two
  frontiers. A key or node touched in `diff(after, now)` is skipped.
- **Skip, not overwrite,** on both, which departs from Loro's own manager.
- **Open:** undoing a movable-list move without losing the element's
  identity. Neither Loro's manager nor `diff` does it; it needs moves built
  from element ids, which Loro exposes only through `exportJsonInIdSpan`.
- **Direct writes** to schema types are undoable: the Yjs bridge computes
  their inverse from σ before re-materializing it, and Loro needs nothing
  more than its history. Types outside the schema (y-prosemirror's
  `XmlFragment`) are not.
- **Restores remap.** Undoing a deletion returns the new ids of what it
  re-created, paired with the old ones (Yjs items, Loro containers), and
  every older step resolves its ids through that map.
- **Rich text on Yjs is state-based, not id-based:** a mark is undone by
  restoring the previous marks over the anchored range, never by deleting
  format items.
