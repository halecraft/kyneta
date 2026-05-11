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
//     useSyncStatus — observe sync connection state
//
//   Counter refs auto-commit: doc.count.increment(n) writes directly.
//   No change() wrapper needed for single-counter mutations.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useDocument, useValue, useSyncStatus } from "@kyneta/react"
import { CounterDoc } from "./schema.js"

// ─────────────────────────────────────────────────────────────────────────
// Sync indicator
// ─────────────────────────────────────────────────────────────────────────

function SyncIndicator({ doc }: { doc: object }) {
  const readyStates = useSyncStatus(doc)
  const synced = readyStates.some(s => s.status === "synced")

  return (
    <span
      className="sync-indicator"
      title={synced ? "Connected" : "Connecting..."}
    >
      {synced ? "✅" : "⏳"}
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
