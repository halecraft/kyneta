// fake-locks — a model of Web Locks across the pages of one origin.
//
// One process cannot make a page die, so the allocation tests run against
// this model: exclusive named locks, `ifAvailable`, `query()`, release when
// the callback's promise settles, and the termination of every lock a page
// holds, as the browser does when a page unloads or crashes.

import type { SeatLocks } from "../index.js"

type Grant = { readonly page: FakePage }

type Waiter = {
  readonly page: FakePage
  readonly grant: () => void
}

/** The locks of one origin, shared by its pages. */
export class FakeLockManager {
  readonly #held = new Map<string, Grant>()
  readonly #waiting = new Map<string, Waiter[]>()
  readonly #hidden = new Set<string>()

  /** A page of this origin, with its own view of the locks. */
  page(): FakePage {
    return new FakePage(this)
  }

  /** Leave `name` out of every `query()`, as a snapshot taken too early would. */
  hideFromQuery(name: string): void {
    this.#hidden.add(name)
  }

  /** The names of the locks held now. */
  heldNames(): string[] {
    return [...this.#held.keys()]
  }

  /** @internal */
  async request<T>(
    page: FakePage,
    name: string,
    ifAvailable: boolean,
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T> {
    if (this.#held.has(name)) {
      if (ifAvailable) return callback(null)
      await new Promise<void>(grant => {
        const queue = this.#waiting.get(name) ?? []
        queue.push({ page, grant })
        this.#waiting.set(name, queue)
      })
    }
    const grant: Grant = { page }
    this.#held.set(name, grant)
    try {
      return await callback({ name })
    } finally {
      this.#release(name, grant)
    }
  }

  /** @internal */
  query(): { held: { name: string }[] } {
    return {
      held: [...this.#held.keys()]
        .filter(name => !this.#hidden.has(name))
        .map(name => ({ name })),
    }
  }

  /** @internal Release every lock `page` holds, and drop its waiting requests. */
  terminate(page: FakePage): void {
    for (const [name, queue] of this.#waiting) {
      this.#waiting.set(
        name,
        queue.filter(waiter => waiter.page !== page),
      )
    }
    for (const [name, grant] of [...this.#held]) {
      if (grant.page === page) this.#release(name, grant)
    }
  }

  #release(name: string, grant: Grant): void {
    if (this.#held.get(name) !== grant) return
    this.#held.delete(name)
    const next = this.#waiting.get(name)?.shift()
    next?.grant()
  }
}

/** One page's `navigator.locks`. */
export class FakePage implements SeatLocks {
  readonly #manager: FakeLockManager

  constructor(manager: FakeLockManager) {
    this.#manager = manager
  }

  request<T>(name: string, callback: () => Promise<T>): Promise<T>
  request(
    name: string,
    options: { readonly ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<unknown>
  request(
    name: string,
    optionsOrCallback:
      | { readonly ifAvailable?: boolean }
      | ((lock: unknown) => Promise<unknown>),
    maybeCallback?: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown> {
    const [options, callback] =
      typeof optionsOrCallback === "function"
        ? [{}, optionsOrCallback]
        : [optionsOrCallback, maybeCallback]
    if (callback === undefined) throw new Error("request: no callback")
    return this.#manager.request(
      this,
      name,
      options.ifAvailable === true,
      callback,
    )
  }

  async query(): Promise<{ held: { name: string }[] }> {
    return this.#manager.query()
  }

  /** The page unloads or crashes: the browser releases its locks. */
  terminate(): void {
    this.#manager.terminate(this)
  }
}
