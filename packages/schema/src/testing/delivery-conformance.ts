// delivery-conformance — shared, re-exportable conformance suite for changefeed
// delivery.
//
// The notification engine lives in `@kyneta/schema` and every substrate routes
// through it, so a bug there is a bug on all of them. Two things make a
// plain-substrate-only test insufficient:
//
//   1. An announcement — an incoming sync merge — is where delivery fans out
//      hardest. A merge announces its whole payload and flushes once, so a
//      payload touching N paths is one flush over N ops. That path is driven by
//      the CRDT event bridges, which is exactly what a plain-only test misses.
//   2. Substrates legitimately disagree about op *shape*. `expandMapOpsToLeaves`
//      turns a product's MapChange into per-key ops on the CRDT bridges, while
//      the plain substrate dispatches per field directly.
//
// So this suite asserts *invariants*, never literal op lists. Five hold on every
// substrate:
//
//   Cardinality   one changeset per subscribed key per flush
//   Containment   every delivered op's relative path lies within the subtree
//   Order         dispatch order within a changeset; deepest-first across them
//   Metadata      origin/replay/aborted/source identical across one flush
//   Conservation  what the root sees equals the union of what everyone sees
//
// A substrate opts in by supplying a factory that returns two wired peers. See
// `positionConformance` in this directory for the same pattern applied to the
// Position contract.

import type { Changeset } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import type { Op } from "../changefeed.js"
import { batch } from "../facade/batch.js"
import { subscribe } from "../facade/observe.js"
import type { Ref } from "../ref.js"
import { Schema } from "../schema.js"

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * The document every conformance run writes against. Deliberately shallow and
 * broad: a scalar, a nested struct and a record, so that one batch can touch
 * several sibling subtrees at different depths.
 *
 * `blob` exists for the payload-stability invariant. Aliasing needs an object
 * payload to alias — the rest of this fixture is scalars all the way down, so
 * without it the invariant would check the one shape that cannot fail.
 *
 * Every kind here is one all four substrates admit. `ephemeral` accepts the
 * narrowest set — no sequence, set, text or counter — so a fixture that
 * reaches past it cannot run on all four, and a sequence that no assertion
 * writes to would buy nothing for the price.
 *
 * The suite owns this rather than accepting it from the factory, because the
 * assertions below refer to specific paths within it.
 */
export const DeliveryFixture = Schema.struct({
  top: Schema.number(),
  outer: Schema.struct({ x: Schema.number(), y: Schema.number() }),
  entries: Schema.record(Schema.number()),
  blob: Schema.struct({ label: Schema.string(), count: Schema.number() }),
})

// ---------------------------------------------------------------------------
// Factory interface
// ---------------------------------------------------------------------------

/**
 * A ref over the fixture. Every substrate produces the same shape, so the
 * suite can be written against a real type rather than `any` — which means the
 * writes below are checked against the schema instead of silently accepting
 * whatever a substrate happens to expose.
 */
export type DeliveryDoc = Ref<typeof DeliveryFixture>

export interface DeliveryTestEnv {
  /** The local document ref, bound to `DeliveryFixture` on this substrate. */
  readonly doc: DeliveryDoc

  /**
   * Write on a second peer and merge the result into `doc`.
   *
   * This is the whole reason the factory takes two peers. A merge is
   * announced with `ctx.announce(ops, origin)` — a different
   * entry point from a local `batch()`, and the one that carries the largest
   * payloads in practice.
   */
  remoteMerge(fn: (draft: DeliveryDoc) => void): void
}

export type DeliveryConformanceFactory = () => DeliveryTestEnv

export interface DeliveryConformanceOptions {
  /** Appended to the suite name, so a failure names its substrate. */
  readonly label?: string
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

interface Probe {
  readonly changesets: Changeset<Op>[]
  /** Relative path of every op received, flattened across changesets. */
  readonly paths: () => string[]
}

function probe(ref: unknown): Probe {
  const changesets: Changeset<Op>[] = []
  subscribe(ref, cs => changesets.push(cs))
  return {
    changesets,
    paths: () =>
      changesets.flatMap(cs => cs.changes.map(op => op.path.format())),
  }
}

// ---------------------------------------------------------------------------
// Conformance suite
// ---------------------------------------------------------------------------

export function deliveryConformance(
  factory: DeliveryConformanceFactory,
  options?: DeliveryConformanceOptions,
): void {
  const suffix = options?.label ? ` (${options.label})` : ""

  // Both entry points into the notification engine. Every invariant below runs
  // through both: `batch()` opens a runBatch frame and flushes at the depth-0
  // release, while a merge bypasses the frame and flushes directly. They must
  // deliver identically.
  const drivers: ReadonlyArray<{
    readonly name: string
    readonly write: (env: DeliveryTestEnv, fn: (d: DeliveryDoc) => void) => void
    readonly replay: boolean
  }> = [
    {
      name: "local batch",
      write: (env, fn) => batch(env.doc, fn),
      replay: false,
    },
    {
      name: "remote merge (replay)",
      write: (env, fn) => env.remoteMerge(fn),
      replay: true,
    },
  ]

  describe(`delivery conformance${suffix}`, () => {
    for (const driver of drivers) {
      describe(driver.name, () => {
        // ===================================================================
        // Cardinality
        // ===================================================================

        it("cardinality: one changeset per subscribed key, however many paths changed", () => {
          const env = factory()
          const atRoot = probe(env.doc)
          const atOuter = probe(env.doc.outer)

          driver.write(env, d => {
            d.top.set(1)
            d.outer.x.set(2)
            d.outer.y.set(3)
            d.entries.set("k", 4)
          })

          expect(atRoot.changesets).toHaveLength(1)
          expect(atOuter.changesets).toHaveLength(1)
        })

        it("cardinality: a subscriber whose subtree is untouched hears nothing", () => {
          const env = factory()
          const atOuter = probe(env.doc.outer)

          driver.write(env, d => d.top.set(1))

          expect(atOuter.changesets).toHaveLength(0)
        })

        // ===================================================================
        // Containment
        // ===================================================================

        it("containment: every op lies within the subscriber's subtree", () => {
          const env = factory()
          const atOuter = probe(env.doc.outer)

          driver.write(env, d => {
            d.top.set(1)
            d.outer.x.set(2)
            d.entries.set("k", 3)
          })

          // Relative paths, so nothing here may mention a sibling subtree.
          for (const path of atOuter.paths()) {
            expect(path).not.toContain("top")
            expect(path).not.toContain("entries")
          }
          expect(atOuter.paths().length).toBeGreaterThan(0)
        })

        it("containment: a leaf receives its own change at the empty path", () => {
          const env = factory()
          const atLeaf = probe(env.doc.top)

          driver.write(env, d => d.top.set(7))

          // A leaf is a tree of size one, so its own change is its whole
          // subtree. `format()` renders the empty relative path as "root".
          expect(atLeaf.paths()).toEqual(["root"])
        })

        // ===================================================================
        // Order
        // ===================================================================

        it("order: deep subscribers fire deepest-first", () => {
          const env = factory()
          const order: string[] = []
          subscribe(env.doc, () => order.push("root"))
          subscribe(env.doc.outer, () => order.push("outer"))

          driver.write(env, d => {
            d.top.set(1)
            d.outer.x.set(2)
          })

          expect(order).toEqual(["outer", "root"])
        })

        it("order: every level sees a subtree's ops in the same relative order", () => {
          const env = factory()
          const atRoot = probe(env.doc)
          const atOuter = probe(env.doc.outer)

          driver.write(env, d => {
            d.outer.y.set(1)
            d.top.set(9)
            d.outer.x.set(2)
          })

          // The engine preserves the order of the ops it was handed; it never
          // re-groups them. So a subtree's ops must appear at the root in the
          // same relative order they appear at the subtree — a subsequence
          // relation, which holds whatever order the ops arrived in.
          //
          // This is the substrate-independent half of the ordering contract.
          // Where those ops came from in the first place is the driver's
          // business, and the two drivers differ — see the local-batch-only
          // dispatch-order test below.
          const rootPaths = atRoot.paths()
          const outerAtRoot = rootPaths.filter(p => p.startsWith("outer"))
          const rebased = atOuter
            .paths()
            .map(p => (p === "root" ? "outer" : `outer.${p}`))

          expect(rebased.length).toBeGreaterThan(0)
          expect(outerAtRoot).toEqual(rebased)
        })

        if (!driver.replay) {
          it("order: ops keep the order they were dispatched in", () => {
            const env = factory()
            const atOuter = probe(env.doc.outer)

            driver.write(env, d => {
              d.outer.y.set(1)
              d.outer.x.set(2)
            })

            // Local writes only. A merge carries a CRDT diff rather than a
            // write log: the event bridge reconstructs ops by enumerating what
            // changed, so their order reflects the diff's enumeration and not
            // the sequence the remote peer wrote them in. The engine preserves
            // whatever order it is handed either way, which is what the
            // subsequence test above pins for both drivers.
            const paths = atOuter.paths()
            const yAt = paths.indexOf("y")
            const xAt = paths.indexOf("x")
            expect(yAt).toBeGreaterThanOrEqual(0)
            expect(xAt).toBeGreaterThanOrEqual(0)
            expect(yAt).toBeLessThan(xAt)
          })
        }

        // ===================================================================
        // Metadata
        // ===================================================================

        it("metadata: replay marks merged state and only merged state", () => {
          const env = factory()
          const atRoot = probe(env.doc)

          driver.write(env, d => {
            d.top.set(1)
            d.outer.x.set(2)
          })

          // The exchange's echo suppression turns on exactly this flag. If a
          // merged changeset lost it, every incoming offer would be re-emitted
          // to all peers; if a local one gained it, local writes would never
          // sync at all.
          for (const cs of atRoot.changesets) {
            expect(cs.replay).toBe(driver.replay)
          }
        })

        it("metadata: identical across every changeset of one flush", () => {
          const env = factory()
          const atRoot = probe(env.doc)
          const atOuter = probe(env.doc.outer)
          const atLeaf = probe(env.doc.outer.x)

          driver.write(env, d => {
            d.top.set(1)
            d.outer.x.set(2)
          })

          const all = [
            ...atRoot.changesets,
            ...atOuter.changesets,
            ...atLeaf.changesets,
          ]
          expect(all.length).toBeGreaterThan(0)
          const first = all[0]
          for (const cs of all) {
            expect(cs.origin).toBe(first?.origin)
            expect(cs.replay).toBe(first?.replay)
            expect(cs.aborted).toBe(first?.aborted)
            expect(cs.source).toBe(first?.source)
          }
        })

        // ===================================================================
        // Conservation
        // ===================================================================

        it("conservation: the root sees everything a deeper subscriber sees", () => {
          const env = factory()
          const atRoot = probe(env.doc)
          const atOuter = probe(env.doc.outer)

          driver.write(env, d => {
            d.top.set(1)
            d.outer.x.set(2)
            d.outer.y.set(3)
          })

          // Rebasing is the only difference between the two views, so
          // re-prefixing the deeper subscriber's paths must land inside the
          // root's set — nothing invented, nothing dropped.
          const rootPaths = atRoot.paths()
          for (const path of atOuter.paths()) {
            const absolute = path === "root" ? "outer" : `outer.${path}`
            expect(rootPaths).toContain(absolute)
          }
          expect(atOuter.paths().length).toBeGreaterThan(0)
        })

        // =================================================================
        // Payload stability
        // =================================================================

        it("payload stability: a captured op does not change under later writes", () => {
          const env = factory()
          const atRoot = probe(env.doc)

          driver.write(env, d => d.blob.set({ label: "first", count: 1 }))
          const captured = atRoot.changesets
            .flatMap(cs => cs.changes)
            .find(op => op.path.format().includes("blob"))?.change as
            | { value?: { label?: string; count?: number } }
            | undefined
          const before = JSON.stringify(captured?.value ?? null)

          // A second, unrelated write into the same subtree. If the op aliased
          // the store, this would rewrite what the first subscriber received.
          driver.write(env, d => d.blob.label.set("second"))

          expect(JSON.stringify(captured?.value ?? null)).toBe(before)
        })

        it("conservation: op count at the root matches the union below it", () => {
          const env = factory()
          const atRoot = probe(env.doc)
          const atTop = probe(env.doc.top)
          const atOuter = probe(env.doc.outer)

          driver.write(env, d => {
            d.top.set(1)
            d.outer.x.set(2)
          })

          // Every op reaches the root exactly once, and reaches exactly one of
          // these two disjoint subtrees.
          expect(atRoot.paths()).toHaveLength(
            atTop.paths().length + atOuter.paths().length,
          )
        })
      })
    }
  })
}
