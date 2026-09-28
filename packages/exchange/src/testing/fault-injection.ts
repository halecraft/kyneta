// fault-injection — shared deferred-arm, op-weighted write-fault primitive.
//
// The Store conformance suite's atomicity property (store-conformance.ts) arms
// a fault *after* priming, via `injectFault(n)`, then asserts that no partial
// state leaked, for every `n` until a write completes without reaching it.
// Each backend wraps its own write seam (LevelDB `put`/`batch`, SQLite
// `exec`, Postgres `query`); this primitive handles the parts every backend
// would otherwise hand-roll: latent (deferred) arming so construction writes
// don't count, op-weighted counting (one `batch(ops)` counts as `ops.length`
// ops), sync-throw vs async-reject dispatch, and reporting whether the armed
// fault fired. Context: jj:pzuytnvo.

/** A target wrapped so the Nth weighted write fails, plus the arming handle. */
export interface ArmedFault<T> {
  readonly proxy: T
  /**
   * Reset the counter and arm: the call whose running op-tick reaches `n` fails
   * **before delegating**, letting ops 1..n-1 commit. Latent until armed — calls
   * made before `arm` (e.g. schema/format setup, priming) do not count.
   */
  readonly arm: (n: number) => void
  /**
   * Whether the fault armed by the latest `arm` has fired. A run that ends with
   * it unfired had fewer than `n` weighted writes, which is how a sweep over
   * `n = 1, 2, …` knows it has covered every step.
   */
  readonly fired: () => boolean
}

/** Op-weight for a seam method: a constant, or a function of the call args
 *  (e.g. LevelDB `batch`: `ops => ops.length`). Unlisted methods pass through. */
type Weight = number | ((...args: readonly unknown[]) => number)

/**
 * Wrap `target` so that, once armed, the call whose running op-tick reaches the
 * armed value throws (sync seams) or rejects (async seams) before delegating.
 * Only methods named in `seams` are counted and faultable; everything else is
 * forwarded untouched (bound to the real target).
 */
export function makeArmedFault<T extends object>(
  target: T,
  seams: { readonly [K in keyof T]?: Weight },
  error: Error = new Error("fault-injected write"),
): ArmedFault<T> {
  let tick = 0
  let armed: number | null = null
  let fired = false

  const arm = (n: number): void => {
    if (n < 1) throw new Error(`makeArmedFault: n must be >= 1, got ${n}`)
    tick = 0
    armed = n
    fired = false
  }

  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver) as unknown
      const weight = (seams as Record<PropertyKey, Weight | undefined>)[prop]
      if (weight === undefined || typeof value !== "function") {
        // Not a seam (or not callable): forward, binding methods to the target
        // so internal `this` use never re-enters the proxy.
        return typeof value === "function" ? value.bind(obj) : value
      }

      const fn = value as (...args: unknown[]) => unknown
      const isAsync = fn.constructor.name === "AsyncFunction"
      return function (this: unknown, ...args: unknown[]): unknown {
        if (armed !== null) {
          const start = tick
          tick += typeof weight === "function" ? weight(...args) : weight
          if (armed > start && armed <= tick) {
            armed = null
            fired = true
            if (isAsync) return Promise.reject(error)
            throw error
          }
        }
        return fn.apply(obj, args)
      }
    },
  })

  return { proxy, arm, fired: () => fired }
}
