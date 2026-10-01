// measure — time and retained heap, measured the same way for every case.
//
// Retained memory is the heap after two full collections, before and after
// the work, with the work's result held live across the second measurement.
// Two collections, because one can leave objects a finalizer or weak
// reference only released during it.

const gc = (globalThis as { gc?: () => void }).gc

function collect(): number {
  if (gc === undefined) {
    throw new Error("Run with `node --expose-gc` (`pnpm bench` does).")
  }
  gc()
  gc()
  return process.memoryUsage().heapUsed
}

/** One measured unit of work: how long it took and what it left reachable. */
export interface Measured<T> {
  readonly value: T
  readonly ms: number
  readonly retainedBytes: number
}

/** Run `work` once, holding its result, and measure it. */
export function measure<T>(work: () => T): Measured<T> {
  const before = collect()
  const start = performance.now()
  const value = work()
  const ms = performance.now() - start
  const retainedBytes = collect() - before
  return { value, ms, retainedBytes }
}

/** Mean microseconds per call of `step` over `iterations` calls. */
export function microsPer(
  iterations: number,
  step: (i: number) => void,
): number {
  const start = performance.now()
  for (let i = 0; i < iterations; i++) step(i)
  return ((performance.now() - start) * 1000) / iterations
}

/** One reported number. */
export interface Result {
  readonly group: string
  readonly substrate: string
  readonly metric: string
  readonly value: number
  readonly unit: string
}

export const KiB = 1024
export const MiB = 1024 * 1024
