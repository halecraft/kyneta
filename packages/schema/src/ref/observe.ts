// observe — a ref's `[CHANGEFEED]` and `[POPULATED]`, each made on first
// access and kept in the ref's state.
//
// A subscriber registers at the ref's coordinate in the context's subscriber
// trie (`ctx.subscribers`); delivery finds it by walking each change's
// ancestors and the part of the tree the change rewrote (`delivery.ts`). So a
// subscription belongs to its coordinate, not to the ref: it keeps hearing
// changes after the ref it was made through is collected.

import type { HasChangefeed } from "@kyneta/changefeed"
import { CHANGEFEED } from "@kyneta/changefeed"
import type { ChangeBase } from "../change.js"
import type {
  Changeset,
  Op,
  RecursiveChangefeedProtocol,
} from "../changefeed.js"
import { liftToOps } from "../delivery.js"
import type { Path } from "../path.js"
import { RawPath } from "../path.js"
import { CALL, getter } from "./read.js"
import { type FeedCarrier, lazySlots, stateOf } from "./state.js"
import { reportFeed } from "./track.js"

export const POPULATED: unique symbol = Symbol.for("kyneta:populated")

/**
 * A ref that tracks whether a change has reached its coordinate. The slot
 * holds a callable returning the boolean, which carries its own
 * `[CHANGEFEED]` so the transition can be subscribed to.
 *
 * Keyed by a symbol, never by the string `"populated"`: a ref exposes its
 * schema's fields as properties, so a string key could collide with one.
 */
export interface HasPopulated {
  readonly [POPULATED]: (() => boolean) & HasChangefeed<boolean>
}

/** Whether `value` tracks population. */
export function hasPopulated(value: unknown): value is HasPopulated {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    POPULATED in (value as object)
  )
}

/**
 * Whether a change has reached the ref's coordinate: an op landed at or below
 * it, or an op above it rewrote a part of the tree containing it. Monotonic:
 * once true, never false. False for a value that does not track population.
 */
export function populated(ref: unknown): boolean {
  if (!hasPopulated(ref)) return false
  return ref[POPULATED]() === true
}

/**
 * The observable carrier behind `populated(ref)`: a callable returning the
 * boolean, with a `[CHANGEFEED]` that fires once, when the coordinate is
 * first populated. Always truthy when present, so call it rather than test
 * it. Throws for a value that does not track population.
 */
export function populatedFeed(
  ref: unknown,
): (() => boolean) & HasChangefeed<boolean> {
  if (!hasPopulated(ref)) {
    throw new Error(
      "populatedFeed() requires a ref that tracks population (a document ref or one below it)",
    )
  }
  return ref[POPULATED]
}

/**
 * A callable returning `current()`, carrying a `[CHANGEFEED]` whose
 * subscribers hear each change of it: `[DELETED]` and `[POPULATED]` are both
 * one. `tracked` makes a call report a dependency on the carrier.
 */
export function feedCarrier(
  current: () => boolean,
  subscribe: (
    callback: (changeset: Changeset<ChangeBase>) => void,
  ) => () => void,
  tracked: boolean,
): FeedCarrier {
  const carrier = (): boolean => {
    if (tracked) reportFeed(carrier)
    return current()
  }
  const changefeed: RecursiveChangefeedProtocol<boolean, ChangeBase> = {
    get current(): boolean {
      return current()
    },
    subscribe,
    subscribeDescendants(callback: (changeset: Changeset<Op>) => void) {
      return subscribe(changeset =>
        callback(liftToOps(changeset, RawPath.empty)),
      )
    },
  }
  Object.defineProperty(carrier, CHANGEFEED, {
    value: changefeed,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return carrier as FeedCarrier
}

/** `[CHANGEFEED]` and `[POPULATED]`, for a ref of any kind. */
export function observeMembers(): PropertyDescriptorMap {
  return {
    [CHANGEFEED]: getter(function (
      this: unknown,
    ): RecursiveChangefeedProtocol<unknown> {
      const state = stateOf(this, "[CHANGEFEED]")
      const slots = lazySlots(state)
      if (slots.changefeed !== undefined) return slots.changefeed
      const ref = this as { [CALL](): unknown }
      const { subscribers } = state.ctx
      const path = state.path
      slots.changefeed = {
        get current() {
          return ref[CALL]()
        },
        subscribe: callback => subscribers.listenOwn(path, callback),
        subscribeDescendants: callback =>
          subscribers.listenDeep(path, callback),
      }
      return slots.changefeed
    }),
    [POPULATED]: getter(function (this: unknown): FeedCarrier {
      const state = stateOf(this, "[POPULATED]")
      const slots = lazySlots(state)
      if (slots.populated !== undefined) return slots.populated
      const { subscribers } = state.ctx
      const path = state.path
      const origin = { changes: [], origin: "populated" } as const
      slots.populated = feedCarrier(
        () => subscribers.isPopulated(path),
        callback => {
          // Already populated: fire once, after the caller has its teardown.
          if (subscribers.isPopulated(path)) {
            Promise.resolve().then(() => callback(origin))
            return () => {}
          }
          return subscribers.listenPopulated(path, () => callback(origin))
        },
        false,
      )
      return slots.populated
    }),
  }
}

/**
 * Number of own-path subscribers at `path` in `ctx`'s subscriber trie.
 *
 * @internal Not exported from the package barrel. Test-only: a registration
 * that outlives its subscriber costs memory and per-delivery work and
 * nothing else, so reading the structure is the test that holds.
 */
export function __getListenerCountAtPath(
  ctx: {
    readonly subscribers: {
      find(path: Path): { own?: Set<unknown> } | undefined
    }
  },
  path: Path,
): number {
  return ctx.subscribers.find(path)?.own?.size ?? 0
}
