// observe — a ref's `[CHANGEFEED]` and `[POPULATED]`, each made on first
// access and kept in the ref's state.
//
// A subscriber registers at the ref's coordinate in the context's subscriber
// trie (`ctx.subscribers`); delivery finds it by walking each change's
// ancestors and the part of the tree the change rewrote (`delivery.ts`). So a
// subscription belongs to its coordinate, not to the ref: it keeps hearing
// changes after the ref it was made through is collected.

import type { Feed } from "@kyneta/changefeed"
import { CHANGEFEED, createFeed } from "@kyneta/changefeed"
import type { ChangeBase } from "../change.js"
import type {
  Changeset,
  Op,
  RecursiveChangefeedProtocol,
} from "../changefeed.js"
import { liftToOps } from "../delivery.js"
import { isPropertyHost } from "../guards.js"
import type { Path } from "../path.js"
import { RawPath } from "../path.js"
import { CALL, getter } from "./read.js"
import { lazySlots, stateOf } from "./state.js"
import { reportFeed } from "./track.js"

// ---------------------------------------------------------------------------
// Flags — a boolean a ref holds under a symbol
// ---------------------------------------------------------------------------

/**
 * A ref flag: a boolean the ref holds under `K`, as a feed. Keyed by a
 * symbol, never a string: a ref exposes its schema's fields as properties,
 * so a string key could collide with one.
 */
export type HasFlag<K extends symbol> = { readonly [key in K]: Feed<boolean> }

/** What `flag` gives each flag: its guard, its value and its feed. */
export interface Flag<K extends symbol> {
  /** Whether `value` is a ref that holds the flag. */
  has(value: unknown): value is HasFlag<K>
  /** The flag's boolean; `false` for anything that does not hold it. */
  value(ref: unknown): boolean
  /**
   * The flag's feed. `null` and `undefined` pass through unchanged, as they
   * do through `useValue`, so a ref that may be absent composes. Any other
   * value without the flag throws.
   */
  feed<R>(ref: R): R extends null | undefined ? R : Feed<boolean>
}

/**
 * The guard, value and feed of the flag under `slot`. `feed` is named
 * `name` in its error, which says the ref it requires (`requires`).
 */
export function flag<K extends symbol>(
  slot: K,
  name: string,
  requires: string,
): Flag<K> {
  const has = (value: unknown): value is HasFlag<K> =>
    isPropertyHost(value) && slot in value
  return {
    has,
    value: ref => has(ref) && ref[slot]() === true,
    feed<R>(ref: R): R extends null | undefined ? R : Feed<boolean> {
      type Out = R extends null | undefined ? R : Feed<boolean>
      if (ref === null || ref === undefined) return ref as Out
      if (!has(ref)) throw new Error(`${name}() requires ${requires}`)
      return ref[slot] as Out
    },
  }
}

/**
 * A flag's feed: `current()` read through a `[CHANGEFEED]` whose subscribers
 * hear each change of it, deep subscribers at the empty relative path.
 * `tracked` makes a call report a dependency on the feed.
 */
export function flagFeed(
  current: () => boolean,
  subscribe: (
    callback: (changeset: Changeset<ChangeBase>) => void,
  ) => () => void,
  tracked: boolean,
): Feed<boolean> {
  const protocol: RecursiveChangefeedProtocol<boolean, ChangeBase> = {
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
  const feed: Feed<boolean> = createFeed(() => {
    if (tracked) reportFeed(feed)
    return current()
  }, protocol)
  return feed
}

// ---------------------------------------------------------------------------
// Population
// ---------------------------------------------------------------------------

export const POPULATED: unique symbol = Symbol.for("kyneta:populated")

/** A ref that tracks whether a change has reached its coordinate: every
 *  ref of a document. */
export type HasPopulated = HasFlag<typeof POPULATED>

const population = flag(
  POPULATED,
  "populatedFeed",
  "a ref that tracks population (a document ref or one below it)",
)

/** Whether `value` tracks population. */
export const hasPopulated = population.has

/**
 * Whether a change has reached the ref's coordinate: an op landed at or below
 * it, or an op above it rewrote a part of the tree containing it. Monotonic:
 * once true, never false. False for a value that does not track population.
 */
export const populated = population.value

/**
 * The feed behind `populated(ref)`: a callable returning the boolean, with a
 * `[CHANGEFEED]` that fires once, when the coordinate is first populated.
 * Always truthy when present, so call it rather than test it. `null` and
 * `undefined` pass through; any other value that is not a ref throws.
 */
export const populatedFeed = population.feed

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
    [POPULATED]: getter(function (this: unknown): Feed<boolean> {
      const state = stateOf(this, "[POPULATED]")
      const slots = lazySlots(state)
      if (slots.populated !== undefined) return slots.populated
      const { subscribers } = state.ctx
      const path = state.path
      const origin = { changes: [], origin: "populated" } as const
      slots.populated = flagFeed(
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
