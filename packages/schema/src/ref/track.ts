// track — the dependency reports a ref's members make while a tracking scope
// is active (`tracking.ts`). Each member that reads the document calls
// `report` itself, so there is no wrapper around it; with no scope active a
// report is one guard.
//
// Aspect inference (read-method × node-kind):
//   leaf `()`            → value        (scalar/text/counter/richtext/set)
//   composite `()`       → deep         (product/sequence/map/tree)
//   container navigation → structure    (.at/.length/iteration/.keys/.has/.size/
//                                        .entries/.values/.node/.ids/.roots)
//   container `.get(k)`  → structure on the container, and the child's own
//                          `value` or `deep`, through `.at(k)` and its `()`
//
// A dependency is keyed by the ref it was read through (its `trackingId`).
// There is one canonical ref per coordinate while it is held, and a scope
// holds the refs it depends on (`Dependency.ref`), so the key is stable
// across inserts and deletes around the coordinate.

import type { HasChangefeed } from "@kyneta/changefeed"
import {
  type Aspect,
  currentScope,
  dependencyKey,
  reportRead,
} from "../tracking.js"
import { lazySlots, type RefState } from "./state.js"

let nextTrackingId = 1

/** Report a read of `ref`, whose state is `state`, at `aspect`. */
export function report(ref: unknown, state: RefState, aspect: Aspect): void {
  if (!currentScope()) return
  const slots = lazySlots(state)
  slots.trackingId ??= nextTrackingId++
  reportRead({
    key: dependencyKey(`n${slots.trackingId}`, aspect),
    aspect,
    ref: ref as HasChangefeed,
  })
}

const feedIds = new WeakMap<object, number>()

/** Report a read of a feed carrier (`[DELETED]`), as a value. */
export function reportFeed(carrier: object): void {
  if (!currentScope()) return
  let id = feedIds.get(carrier)
  if (id === undefined) {
    id = nextTrackingId++
    feedIds.set(carrier, id)
  }
  reportRead({
    key: dependencyKey(`f${id}`, "value"),
    aspect: "value",
    ref: carrier as HasChangefeed,
  })
}
