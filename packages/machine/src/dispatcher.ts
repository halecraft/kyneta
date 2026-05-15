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
 * owner and resets `iterations`/`history`/`counts`/`originStack` on its
 * eventual 1→0 exit.
 *
 * Diagnostic instrumentation (history, counts, originStack) supports
 * `BudgetExhaustedError`'s message:
 * - `history` — bounded ring buffer of recent `{label, type}` events.
 * - `counts` — cumulative `${label}:${type}` → count over the whole drain.
 * - `originStack` — captured at the cascade's entry point (depth 0→1).
 *   Names the boundary where the dispatch system was re-entered from
 *   outside (userland for client-side flows, transport for server-side).
 */
export type Lease = {
  depth: number
  iterations: number
  readonly budget: number
  history: { label: string; type: string }[]
  readonly historyCapacity: number
  counts: Map<string, number>
  originStack: string | undefined
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
    originStack: undefined,
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
export function formatOrigin(originStack: string | undefined): string {
  if (!originStack) return ""
  const lines = originStack.split("\n")
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
      formatOrigin(lease.originStack) +
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
  const pending: Msg[] = []
  let isDispatching = false

  function dispatch(msg: Msg): void {
    pending.push(msg)
    if (isDispatching) return

    isDispatching = true
    const owns = lease.depth === 0
    if (owns) {
      // Capture the frame that opened this drain. Subscribers re-entering
      // mid-cascade don't overwrite it — the owning drain resets it on
      // exit. The frame names the *entry point* into the dispatch system
      // (userland or transport), not necessarily user code.
      lease.originStack = new Error("cascade origin").stack
    }
    lease.depth += 1
    try {
      while (pending.length > 0) {
        const next = pending.shift()!
        lease.iterations += 1
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
      lease.depth -= 1
      if (owns) {
        lease.iterations = 0
        lease.history.length = 0
        lease.counts.clear()
        lease.originStack = undefined
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
