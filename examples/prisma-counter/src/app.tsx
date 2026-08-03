// ═══════════════════════════════════════════════════════════════════════════
//
//   Prisma Counter — App
//
//   A single collaborative counter. The count is a Loro Counter CRDT —
//   concurrent increments from multiple peers merge additively.
//
//   Imports from @kyneta/react:
//     useDocument   — get (or create) a document from the Exchange
//     useValue      — subscribe to a ref's plain snapshot (re-renders)
//     useDocStatus  — "pending" until every source has reported, then
//                     "empty" or "populated"
//
//   Counter refs auto-commit: doc.count.increment(n) writes directly.
//   No batch() wrapper needed for single-counter mutations.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useDocStatus, useDocument, useValue } from "@kyneta/react"
import { CounterDoc } from "./schema.js"

// ─────────────────────────────────────────────────────────────────────────
// Sync indicator
// ─────────────────────────────────────────────────────────────────────────

function SyncIndicator({ doc }: { doc: object }) {
  // `useDocStatus` answers what we actually want to show: has everything that
  // could tell us about this document reported in yet? `useSyncState` — the
  // raw per-peer array — is the escape hatch for multi-peer dashboards, not
  // for a one-glyph indicator.
  const status = useDocStatus(doc)
  const ready = status !== "pending"

  return (
    <span className="sync-indicator" title={ready ? "Ready" : "Loading..."}>
      {ready ? "✅" : "⏳"}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────

export function App() {
  const doc = useDocument("counter", CounterDoc)

  // useValue on a counter leaf ref returns the current count as a number.
  // Re-renders on every increment (local or remote).
  const count = useValue(doc.count) as number

  return (
    <div className="app">
      <h1>
        Collaborative Counter <SyncIndicator doc={doc} />
      </h1>

      <div className="counter-display">
        <span className="counter-value">{count}</span>
      </div>

      <div className="counter-buttons">
        <button
          type="button"
          className="btn btn-minus"
          onClick={() => doc.count.increment(-1)}
        >
          −
        </button>
        <button
          type="button"
          className="btn btn-plus"
          onClick={() => doc.count.increment(1)}
        >
          +
        </button>
      </div>

      <p className="hint">
        Open this page in another tab to see real-time collaborative counting!
        The counter persists in Postgres — restart the server and the count
        survives.
      </p>
    </div>
  )
}
