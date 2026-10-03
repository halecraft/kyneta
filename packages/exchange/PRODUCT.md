# Observability — product intent

> Product notes for the DevTools observation surface in `@kyneta/exchange`.
> Technical detail lives in `TECHNICAL.md`; this file records *why*, so the
> rationale survives once the plan's `[scratch]` sections are stripped.

## Goal

An in-browser visualizer / developer tool for Kyneta apps — so a developer can
**see, understand, reason about, and debug** sync across its layers: wire
(frames), protocol (the 9-message vocabulary), sync-engine (the TEA programs),
directory (peers × documents), doc (the changeset stream), substrate (CRDT
version/op history), and diagnostics (silent failures).

## Strategy: one protocol, many renderers — spine first

The leverage is the **contract + publish points** (the part that needs core
changes and versioning), not any UI. So we shipped that first:

- `exchange.observe(sink)` streams a correlated `ObsEvent` union (engine /
  protocol / doc / directory / diagnostic / wire). `exchange.docHistory(docId)`
  is the lazy pull for substrate history.
- Renderers are **deferred, separate deliverables** and cheap once the contract
  exists: (1) an embeddable in-app panel, (2) the flagship **standalone
  multi-peer inspector that is itself an Exchange peer** (consuming the
  `ObsEvent` stream over a `Line`), (3) optionally a browser-extension panel.

## Why not (primarily) a browser extension

Considered and rejected as the *foundation*:

- Kyneta is a **topology**, not a browser library — the highest-value view is
  *cross-peer* (alice + a relay server + bob at once). A server/Node/DO peer
  has no browser tab; an extension is single-realm by nature.
- You must build the in-page hook regardless (extensions can't read page-heap
  JS), so the hook + protocol is the real foundation; the extension is one
  consumer, and not the differentiating one.
- The standalone inspector-as-a-peer dogfoods Kyneta's own primitives — the
  strongest evidence the primitives are real.

A browser-extension panel remains a fine *late skin* over the same hook.

## Highest-value signal: diagnostics

The events developers most need are the **silent failures** — "peer declared a
different schemaHash → nothing converges," sync-mode mismatch, protocol-version
skew. These already exist as effects internally and ride the same observation
tee for near-zero cost; they are first-class `diagnostic` events.

## Status & deferrals

Push spine (engine/protocol/doc/directory/diagnostic), wire-frame layer (all
transports), and the substrate-history pull (Loro deep with time-travel; Yjs
summary) are shipped and tested. The renderer-agnostic **world model**
(`@kyneta/devtools`) is shipped too — composed from `@kyneta/index` (append
logs + cross-peer `docId` grouping) and `@kyneta/changefeed` `ReactiveMap`s
(LWW status), fed by one pure classifier; it dogfoods the framework's own
data primitives. **Next**: renderers (in-app panel, then the multi-peer
inspector) and `Line` egress (the `discriminatedSum` schema makes `ObsEvent`
a clean `Line` message).

`ObsEvent` is **experimental** (`v: 1`) until the renderers teach us the right
shape. Known deferrals: `onWireError → diagnostic`; the substrate **op-DAG**
drill-down; Yjs `valueAt` time-travel (needs `gc: false`); a correct
frame-level cross-peer thread (awaits a content-addressed `Frame.hash` — frame
`seq` collides per channel/direction).
