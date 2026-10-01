// state — what one ref holds. Everything a ref does lives on its prototype,
// built once per schema node (`prototype.ts`).
//
// A ref is its state made callable: a function bound to its state record
// (`bindState`). Binding costs one small object and no closure, and a member
// reaches the state by calling the ref with a key only this module has
// (`[STATE]`), so the state is no property of the ref either.

import type { Feed } from "@kyneta/changefeed"
import type { RecursiveChangefeedProtocol } from "../changefeed.js"
import type { AddressedPath } from "../path.js"
import type { WritableContext } from "../writable-context.js"

/**
 * Asks a ref for its state: `ref[STATE]` is a getter on every ref's
 * prototype (`refBase`) that calls the ref with this key. Module-private, so
 * only this module can ask.
 */
export const STATE: unique symbol = Symbol("kyneta:ref-state")

/** A ref as the construction sees it: a callable carrying its state. */
export type RefFunction = ((...args: unknown[]) => unknown) & {
  readonly [STATE]: RefState
}

/**
 * Everything one ref holds. Every slot is declared, so every ref has one
 * shape; the lazy ones start `undefined`.
 */
export interface RefState {
  readonly ctx: WritableContext
  readonly path: AddressedPath
  /**
   * The ref this one was reached from, held strongly: the ref, not its
   * state. The parent's canonical ref is what `.at(k)` hands back, so holding
   * any ref must keep the ancestor refs themselves alive.
   */
  readonly parent: RefFunction | undefined
  /** The ref whose state this is: a sum's `Proxy`, for a sum. */
  readonly ref: RefFunction
  /**
   * The refs this one made and holds: a product's fields by name, or a sum's
   * variants by discriminant or index. A ref is one or the other.
   */
  children: Record<string, RefFunction> | undefined
  /** What only some refs need, made with the first of it. */
  lazy: LazySlots | undefined
}

/** The slots a ref fills on first use: most refs never fill any. */
export interface LazySlots {
  changefeed: RecursiveChangefeedProtocol<unknown> | undefined
  populated: Feed<boolean> | undefined
  deleted: Feed<boolean> | undefined
  /** A text's or rich text's position capability. */
  position: unknown
  /** The id a tracking dependency on this ref is keyed by. */
  trackingId: number | undefined
}

/** `state`'s lazy slots, made on first use. */
export function lazySlots(state: RefState): LazySlots {
  state.lazy ??= {
    changefeed: undefined,
    populated: undefined,
    deleted: undefined,
    position: undefined,
    trackingId: undefined,
  }
  return state.lazy
}

/**
 * A new state record, and its ref: `call` bound to the record, or what
 * `wrap` makes of it (a sum's `Proxy`). `call` answers `[STATE]` with its
 * `this`, the record.
 */
export function bindState(
  ctx: WritableContext,
  path: AddressedPath,
  parent: RefFunction | undefined,
  call: (this: RefState, key?: unknown) => unknown,
  wrap: (bound: RefFunction) => RefFunction = bound => bound,
): RefFunction {
  const state: { -readonly [K in keyof RefState]: RefState[K] | undefined } = {
    ctx,
    path,
    parent,
    ref: undefined,
    children: undefined,
    lazy: undefined,
  }
  // The record is complete once `ref` is set, two lines on; nothing reads it
  // before then.
  const ref = wrap(call.bind(state as RefState) as RefFunction)
  state.ref = ref
  return ref
}

/**
 * The prototype every ref prototype inherits: `Function.prototype`, so
 * `call`, `apply` and `bind` work on a ref, and the `[STATE]` getter, which
 * makes `ref[STATE]` true of refs alone.
 */
export const refBase: object = Object.create(Function.prototype, {
  [STATE]: {
    get(this: (key: typeof STATE) => RefState): RefState {
      return this(STATE)
    },
    enumerable: false,
    configurable: false,
  },
})

/**
 * The state of the ref `thisValue`, which `method` was called on. Throws when
 * the method was called without its ref: a member taken off a ref and called
 * on its own (`const f = ref.set; f(x)`) has no `this`.
 */
export function stateOf(thisValue: unknown, method: string): RefState {
  const state =
    typeof thisValue === "function" || typeof thisValue === "object"
      ? (thisValue as { [STATE]?: RefState } | null)?.[STATE]
      : undefined
  if (state === undefined) {
    throw new TypeError(
      `"${method}" was called without its ref; pass (v) => ref.${method}(v)`,
    )
  }
  return state
}
