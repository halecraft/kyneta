// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo React — App
//
//   Collaborative todo list with real-time text editing.
//
//   Each todo's text is a CRDT text field (Schema.text()) bound to an
//   <input> via useText — two users can edit the same todo at once and
//   character-level changes merge without conflict.
//
// ═══════════════════════════════════════════════════════════════════════════

import {
  useDocStatus,
  useDocument,
  useInitialize,
  useValue,
} from "@kyneta/react"
import { useState } from "react"
import { TodoDoc } from "./schema.js"
import { TodoItem } from "./todo-item.js"

function SyncIndicator({ doc }: { doc: object }) {
  // "pending" means some source — stored data, or a peer — has yet to report.
  // That is the question an indicator wants; `useSyncState` (the raw per-peer
  // array) is the escape hatch for multi-peer dashboards.
  const ready = useDocStatus(doc) !== "pending"

  return (
    <span className="sync-indicator" title={ready ? "Ready" : "Loading..."}>
      {ready ? "✅" : "⏳"}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// App — the collaborative todo list
// ─────────────────────────────────────────────────────────────────────────

export function App() {
  const doc = useDocument("todos", TodoDoc)

  // Give the document a title if — and only if — it does not already have one.
  // This waits for stored data to load and for peers to answer before
  // deciding, so it cannot overwrite a title that already exists. It runs at
  // most once per document, however many times this component mounts.
  const status = useInitialize(doc, d => {
    d.title.set("Collaborative Todos")
  })

  // Reactive snapshot of the list — re-renders on add/remove and drives the
  // empty-state. Text edits flow through useText, not through this snapshot.
  const todos = useValue(doc.todos)
  const title = useValue(doc.title)

  // The id of the just-created todo, so its row can autofocus on mount.
  const [newId, setNewId] = useState<string | null>(null)

  const addTodo = () => {
    const id = crypto.randomUUID()
    setNewId(id)
    doc.todos.push({ id, text: "", done: false })
  }

  return (
    <div className="app">
      <h1>
        {status === "pending" ? "Loading…" : title} <SyncIndicator doc={doc} />
      </h1>

      <div className="add-bar">
        <button type="button" onClick={addTodo}>
          + Add todo
        </button>
      </div>

      <ul>
        {/* Map the child refs (stable identity, address-table cached) so each
            row binds its own CRDT text; key by the todo's stable id. */}
        {[...doc.todos].map(todoRef => (
          <TodoItem
            key={todoRef.id()}
            todoRef={todoRef}
            autoFocus={todoRef.id() === newId}
            onEnter={addTodo}
          />
        ))}
      </ul>

      {todos.length === 0 && (
        <p className="empty-state">No todos yet. Add one above!</p>
      )}

      <p className="hint">
        Open this page in another tab to see real-time collaborative editing!
      </p>
    </div>
  )
}
