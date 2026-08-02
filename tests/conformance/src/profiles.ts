import { loro } from "@kyneta/loro-schema"
import { ephemeral, json, Schema, state } from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"

/**
 * A sum whose two variants share NO field names.
 *
 * The disjointness is the whole point. "A concurrent variant switch never blends
 * fields across peers" is only checkable if a blend is visible, and a blend looks
 * like a value carrying `radius` AND `side`, or a `kind` that disagrees with its
 * payload. Two variants sharing a field name would let a blended result pass for
 * a coherent one.
 */
export const Shape = Schema.discriminatedUnion("kind", [
  Schema.struct({ kind: Schema.string("circle"), radius: Schema.number() }),
  Schema.struct({ kind: Schema.string("square"), side: Schema.number() }),
])

/**
 * A nullable struct, for the scenario that writes a leaf INSIDE a sum.
 *
 * `Shape` cannot serve that purpose. Per the `WritableDiscriminantProductRef`
 * contract, a discriminated union's variant fields are read-only — the only
 * mutation it offers is a whole-value `.set()` on the union itself. A
 * `.nullable()` struct is the shape whose interior is writable at runtime.
 */
export const Optional = Schema.struct({
  from: Schema.number(),
  to: Schema.number(),
}).nullable()

// The schema every substrate is measured against.
//
// `a` and `b` are the crux of the concurrent-write invariant: two INDEPENDENT
// fields, so a substrate that merges below whole-document granularity
// (field-level LWW, or op-level CRDT) keeps both a peer-A write to `a` and a
// concurrent peer-B write to `b`, while a whole-document last-writer-wins
// substrate keeps only one.
//
// A note for anyone extending this further: what a substrate accepts is decided
// by composition laws, and wrapping changes them. `Schema.list(...)` is rejected
// on `state` and `ephemeral` because a sequence carries `positional-ot`, which is
// not in `EphemeralLaws` — and `.nullable()` does NOT change that, because it
// does not erase the inner laws. `Schema.list.json(...)` binds fine on all five,
// because `.json()` collapses the subtree to an inert blob and leaves only `lww`.
// Struct- and record-shaped sums like the two above are unaffected.
export const ConformanceSchema = Schema.struct({
  a: Schema.string(),
  b: Schema.string(),
  shape: Shape,
  optional: Optional,
})

/** Whether concurrent writes to two DIFFERENT fields both survive a merge. */
export type FieldConcurrency = "both-survive" | "one-wins"

/**
 * The row of the substrate-unification matrix, as data. Each substrate declares
 * its axes; the conformance harness asserts the universal invariants hold and
 * that the capability-gated ones match what is declared here. This table is the
 * living specification — if a substrate's behavior drifts from its row, a
 * conformance test fails.
 */
export type SubstrateProfile = {
  readonly name: string
  readonly bind: () => ReturnType<typeof json.bind>
  /**
   * "serialized" = one authoritative writer at a time (Plain / `json`);
   * "concurrent" = many peers may write simultaneously (CRDT / LWW families).
   */
  readonly writerModel: "serialized" | "concurrent"
  /** Persistent history (Plain, CRDT) vs transient broadcast (LWW families). */
  readonly durable: boolean
  /**
   * Whether `Exchange.compact()` works on a *live interpret-mode* doc. Only
   * Plain does — its `advance()` truncates the op log in place. CRDT substrates
   * are compactable too, but only via a headless *replica* (store/relay):
   * `advance()` on a live Loro/Yjs substrate throws by design (a shallow
   * snapshot would desync the interpreter's shadow). That replicate-mode
   * compaction path is a separate scenario, out of scope for this first cut.
   */
  readonly liveCompactable: boolean
  readonly fieldConcurrency: FieldConcurrency
}

// biome-ignore lint/suspicious/noExplicitAny: substrate-agnostic BoundSchema — the
// harness accesses docs untyped on purpose, so the concrete NativeMap is irrelevant.
const anyBind = (b: unknown) => b as ReturnType<typeof json.bind>

export const PROFILES: readonly SubstrateProfile[] = [
  {
    name: "json (Plain, serialized)",
    bind: () => anyBind(json.bind(ConformanceSchema)),
    writerModel: "serialized",
    durable: true,
    liveCompactable: true,
    // Sequential authorship — one writer at a time, so no field conflict arises.
    fieldConcurrency: "both-survive",
  },
  {
    name: "ephemeral (whole-doc LWW)",
    bind: () => anyBind(ephemeral.bind(ConformanceSchema)),
    writerModel: "concurrent",
    durable: false,
    liveCompactable: false,
    // A single document-wide timestamp: the newer write replaces the whole doc.
    fieldConcurrency: "one-wins",
  },
  {
    name: "state (field-level LWW)",
    bind: () => anyBind(state.bind(ConformanceSchema)),
    writerModel: "concurrent",
    durable: false,
    liveCompactable: false,
    // A `[value, timestamp]` per leaf — concurrent writes to distinct fields
    // never clobber each other. This is the property that distinguishes `state`
    // from `ephemeral`.
    fieldConcurrency: "both-survive",
  },
  {
    name: "loro (CRDT)",
    bind: () => anyBind(loro.bind(ConformanceSchema)),
    writerModel: "concurrent",
    durable: true,
    liveCompactable: false, // compactable via a headless replica, not a live doc
    fieldConcurrency: "both-survive",
  },
  {
    name: "yjs (CRDT)",
    bind: () => anyBind(yjs.bind(ConformanceSchema)),
    writerModel: "concurrent",
    durable: true,
    liveCompactable: false, // compactable via a headless replica, not a live doc
    fieldConcurrency: "both-survive",
  },
]
