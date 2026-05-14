// dispatcher — drain-to-quiescence primitive shared by reactive frontiers.
//
// createDispatcher() is the underlying primitive that the input-processing
// loop in createObservableProgram is built on. Factoring it out as a named
// export lets cooperating dispatchers share a Lease — a single iteration
// budget and re-entry depth tracker that bounds runaway cascades.

/**
 * Shared iteration budget for cooperating dispatchers.
 *
 * A Lease is a plain mutable record. Dispatchers mutate its fields
 * directly; no methods. When `depth` goes 0→1 a dispatcher becomes the
 * owner and resets `iterations`/`history` on its eventual 1→0 exit.
 */
export type Lease = {
  depth: number
  iterations: number
  readonly budget: number
  history: { label: string; type: string }[]
  readonly historyCapacity: number
}

export type LeaseOptions = {
  budget?: number
  historyCapacity?: number
}

export function createLease(options?: LeaseOptions): Lease {
  return {
    depth: 0,
    iterations: 0,
    budget: options?.budget ?? 100_000,
    history: [],
    historyCapacity: options?.historyCapacity ?? 32,
  }
}

export class BudgetExhaustedError extends Error {
  readonly lease: Lease
  readonly label: string
  constructor(label: string, lease: Lease) {
    super(
      `[dispatcher:${label}] iteration budget exhausted (${lease.iterations} > ${lease.budget}); ` +
        `recent: ${lease.history.map(h => `${h.label}:${h.type}`).join(", ")}`,
    )
    this.name = "BudgetExhaustedError"
    // Snapshot the lease so the history survives the owning dispatcher's
    // finally-block reset that runs as the exception unwinds.
    this.lease = { ...lease, history: [...lease.history] }
    this.label = label
  }
}

export type DispatcherOptions = {
  lease?: Lease
  label?: string
}

export interface DispatcherHandle<Msg> {
  dispatch(msg: Msg): void
  readonly queueDepth: number
}

/**
 * Drain-to-quiescence dispatcher with optional shared budget.
 *
 * Re-entrant `dispatch(msg)` from inside the handler — including from
 * another `DispatcherHandle.dispatch(...)` sharing the same Lease —
 * joins the current drain rather than recursing. This is the property
 * that lets cooperating dispatchers compose: an A→B→A oscillation is
 * one cascade in one lease, not a stack overflow.
 */
export function createDispatcher<Msg>(
  handler: (msg: Msg, dispatch: (msg: Msg) => void) => void,
  options?: DispatcherOptions,
): DispatcherHandle<Msg> {
  const lease = options?.lease ?? createLease()
  const label = options?.label ?? "dispatcher"
  const pending: Msg[] = []
  let isDispatching = false

  function dispatch(msg: Msg): void {
    pending.push(msg)
    if (isDispatching) return

    isDispatching = true
    const owns = lease.depth === 0
    lease.depth += 1
    try {
      while (pending.length > 0) {
        const next = pending.shift()!
        lease.iterations += 1
        const type =
          typeof next === "object" && next !== null && "type" in next
            ? String((next as { type: unknown }).type)
            : "<untyped>"
        if (lease.history.length >= lease.historyCapacity) {
          lease.history.shift()
        }
        lease.history.push({ label, type })
        if (lease.iterations > lease.budget) {
          throw new BudgetExhaustedError(label, lease)
        }
        handler(next, dispatch)
      }
    } finally {
      lease.depth -= 1
      if (owns) {
        lease.iterations = 0
        lease.history.length = 0
      }
      isDispatching = false
    }
  }

  return {
    dispatch,
    get queueDepth(): number {
      return pending.length
    },
  }
}
