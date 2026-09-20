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
 * owner and resets `iterations`/`history`/`counts`/`origin` on its
 * eventual 1→0 exit.
 *
 * Diagnostic instrumentation (history, counts, origin) supports
 * `BudgetExhaustedError`'s message:
 * - `history` — bounded ring buffer of recent `{label, type}` events.
 * - `counts` — cumulative `${label}:${type}` → count over the whole drain.
 * - `origin` — names the boundary where the dispatch system was entered
 *   from outside (userland for client-side flows, transport for
 *   server-side). Present only once a cascade stops looking ordinary;
 *   see the capture site for why it is taken there and not at entry.
 *   Held as the `Error`, not its `.stack` string — reading `.stack`
 *   serializes the whole trace, so that cost belongs on the failure path.
 */
export type Lease = {
  depth: number
  iterations: number
  readonly budget: number
  history: { label: string; type: string }[]
  readonly historyCapacity: number
  counts: Map<string, number>
  origin: Error | undefined
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
    counts: new Map(),
    origin: undefined,
  }
}

// ---------------------------------------------------------------------------
// Diagnostic recording — single mutation site for history + counts
// ---------------------------------------------------------------------------

/**
 * Single mutation site for the lease's diagnostic projections. Future
 * additions (e.g. subscriber-call site) land here so `history` and
 * `counts` can't drift out of sync with each other.
 */
function recordDispatch(lease: Lease, label: string, type: string): void {
  if (lease.history.length >= lease.historyCapacity) lease.history.shift()
  lease.history.push({ label, type })
  const key = `${label}:${type}`
  lease.counts.set(key, (lease.counts.get(key) ?? 0) + 1)
}

// ---------------------------------------------------------------------------
// Pure formatters for BudgetExhaustedError's message sections
// ---------------------------------------------------------------------------

/**
 * Pure formatter for the cascade-origin section of `BudgetExhaustedError`'s
 * message. Strips the synthetic `Error: cascade origin` header from the
 * captured stack — it's the label we used to *construct* the Error solely
 * to grab a stack, not a meaningful frame.
 */
export function formatOrigin(origin: Error | undefined): string {
  const stack = origin?.stack
  if (!stack) return ""
  const lines = stack.split("\n")
  const start = lines[0]?.startsWith("Error") ? 1 : 0
  const frames = lines.slice(start).map(l => `    ${l.trim()}`)
  return `  cascade entered from:\n${frames.join("\n")}\n`
}

/**
 * Pure formatter for the histogram section. Width is computed per
 * render because cooperating dispatchers produce labels as long as
 * `synchronizer:sync:sync/synthetic-doc-removed-all` (46 chars) — a
 * fixed `padEnd` width would mis-align the count column.
 */
export function formatHistogram(
  counts: ReadonlyMap<string, number>,
  total: number,
  topN: number,
): string {
  if (counts.size === 0 || total <= 0) return ""
  const entries = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
  const maxKeyLen = Math.max(...entries.map(([k]) => k.length))
  const rows = entries.map(([key, n]) => {
    const pct = ((n / total) * 100).toFixed(1)
    return `    ${key.padEnd(maxKeyLen)}  ${String(n).padStart(7)}  (${pct.padStart(4)}%)`
  })
  return `  top message types:\n${rows.join("\n")}\n`
}

export function formatRecent(
  history: readonly { label: string; type: string }[],
): string {
  if (history.length === 0) return ""
  const tail = history.map(h => `${h.label}:${h.type}`).join(", ")
  return `  recent (${history.length}): ${tail}\n`
}

// ---------------------------------------------------------------------------
// BudgetExhaustedError
// ---------------------------------------------------------------------------

export class BudgetExhaustedError extends Error {
  readonly lease: Lease
  readonly label: string
  constructor(label: string, lease: Lease) {
    const header = `[dispatcher:${label}] iteration budget exhausted (${lease.iterations} > ${lease.budget})`
    const body =
      formatOrigin(lease.origin) +
      formatHistogram(lease.counts, lease.iterations, 5) +
      formatRecent(lease.history)
    super(body.length > 0 ? `${header}\n${body}` : header)
    this.name = "BudgetExhaustedError"
    // Snapshot the lease so the diagnostic state survives the owning
    // dispatcher's finally-block reset that runs as the exception unwinds.
    // `counts` is a Map and must be cloned explicitly — spread does not
    // copy Map contents.
    this.lease = {
      ...lease,
      history: [...lease.history],
      counts: new Map(lease.counts),
    }
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
  // A cursor, not `shift()`: draining by cursor is O(1) per message and
  // needs no non-null assertion to type. The consumed prefix is dropped on
  // the way out, so a handler that throws still leaves the unprocessed tail
  // queued for the next drain.
  const pending: Msg[] = []
  let head = 0
  let isDispatching = false
  // The iteration count past which a cascade stops looking ordinary: the
  // earlier of `history` beginning to drop events and the budget tripping.
  // Taking the budget into account is what makes the origin diagnostic
  // unconditional — a lease may be configured with a budget smaller than
  // its history, and the frame has to exist by the time the error is built.
  const originWatermark = Math.min(lease.historyCapacity, lease.budget)

  function dispatch(msg: Msg): void {
    pending.push(msg)
    if (isDispatching) return

    isDispatching = true
    const owns = lease.depth === 0
    lease.depth += 1
    try {
      while (head < pending.length) {
        const next = pending[head]
        head += 1
        lease.iterations += 1
        // Capture the cascade's provenance — late, and only once.
        //
        // `new Error` walks the stack: microseconds, on a path every write
        // in the system goes through. Capturing at the entry point would
        // buy a diagnostic for a failure that needs `budget` iterations to
        // occur, and charge every ordinary cascade for it.
        //
        // Deferring loses nothing. The `dispatch` call that opened this
        // drain has not returned — it is running this very loop — so its
        // caller frames are still beneath us, and an Error built here names
        // the same entry point. `originWatermark` picks the moment.
        if (lease.origin === undefined && lease.iterations > originWatermark) {
          lease.origin = new Error("cascade origin")
        }
        const type =
          typeof next === "object" && next !== null && "type" in next
            ? String((next as { type: unknown }).type)
            : "<untyped>"
        recordDispatch(lease, label, type)
        if (lease.iterations > lease.budget) {
          throw new BudgetExhaustedError(label, lease)
        }
        handler(next, dispatch)
      }
    } finally {
      pending.splice(0, head)
      head = 0
      lease.depth -= 1
      if (owns) {
        lease.iterations = 0
        lease.history.length = 0
        lease.counts.clear()
        lease.origin = undefined
      }
      isDispatching = false
    }
  }

  return {
    dispatch,
    get queueDepth(): number {
      return pending.length - head
    },
  }
}
