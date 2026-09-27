// exchanges — the Exchange and drain helpers the integration tests share.

import { afterEach } from "vitest"
import { Exchange, type ExchangeParams } from "../exchange.js"

/**
 * Let queued work run: `rounds` turns of the microtask queue, each followed by
 * a turn of the timer queue, so work a transport or store defers by a
 * `setTimeout(0)` runs too.
 */
export async function drain(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

/** Wait `ms` of real time. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Makes Exchanges for one test file, and shuts them down after each test. */
export type ExchangeFactory = ((
  params?: Partial<ExchangeParams>,
) => Exchange) & {
  /**
   * Leave `exchange` out of the shutdown, for one that must not be shut down:
   * its load never settles, or a crash is being simulated.
   */
  forget(exchange: Exchange): void
}

/**
 * A `createExchange` for one test file. The principal is `"test"` unless
 * `params` names one, and every Exchange it made is shut down after each test.
 * Call it once, at the top level of the file.
 */
export function exchangesPerTest(): ExchangeFactory {
  const active = new Set<Exchange>()
  afterEach(async () => {
    const exchanges = [...active]
    active.clear()
    for (const ex of exchanges) await ex.shutdown()
  })
  const create = (params: Partial<ExchangeParams> = {}): Exchange => {
    const ex = new Exchange({ principal: "test", ...params })
    active.add(ex)
    return ex
  }
  return Object.assign(create, {
    forget: (exchange: Exchange) => {
      active.delete(exchange)
    },
  })
}
