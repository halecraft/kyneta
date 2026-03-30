// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo React — App
//
//   The main application component using @kyneta/react hooks.
//
//   All imports come from @kyneta/react:
//     useDocument  — get (or create) a document from the Exchange
//     useValue     — subscribe to a ref's plain snapshot
//     useSyncStatus — observe sync connection state
//     change       — transact mutations on the document ref
//
//   Architecture:
//     App acquires the document via useDocument (from ExchangeProvider).
//     useValue(doc) returns a plain snapshot that re-renders on any
//     descendant change. Mutations use change(doc, d => { ... }) where
//     d is the writable ref inside the transaction.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useDocument, useValue, useSyncStatus, change } from "@kyneta/react"
import { TodoDoc } from "./schema.js"

// ─────────────────────────────────────────────────────────────────────────
// Sync indicator — shows connection state
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
// App — the collaborative todo component
// ─────────────────────────────────────────────────────────────────────────

export function App() {
  const doc = useDocument("todos", TodoDoc)
  const { todos } = useValue(doc) as {
    todos: readonly { text: string; done: boolean }[]
  }

  // ─── Mutations ─────────────────────────────────────────────────────

  const addTodo = (text: string) => {
    doc.todos.push({ text, done: false })
  }

  const toggleTodo = (index: number) => {
    change(doc, d => {
      const todo = d.todos.at(index)
      if (todo) todo.done.set(!todo.done())
    })
  }

  const removeTodo = (index: number) => {
    doc.todos.delete(index, 1)
  }

  // ─── Render ────────────────────────────────────────────────────────

  return (
    <div className="app">
      <h1>
        Collaborative Todos <SyncIndicator doc={doc} />
      </h1>

      <form
        onSubmit={e => {
          e.preventDefault()
          const form = e.currentTarget
          const input = form.elements.namedItem("text") as HTMLInputElement
          const text = input.value.trim()
          if (!text) return
          addTodo(text)
          form.reset()
        }}
      >
        <input name="text" type="text" placeholder="What needs to be done?" />
        <button type="submit">Add</button>
      </form>

      <ul>
        {todos.map((todo, index) => (
          <li key={index}>
            <input
              type="checkbox"
              checked={todo.done}
              onChange={() => toggleTodo(index)}
            />
            <span className={todo.done ? "done" : ""}>{todo.text}</span>
            <button type="button" onClick={() => removeTodo(index)}>
              ×
            </button>
          </li>
        ))}
      </ul>

      {todos.length === 0 && (
        <p className="empty-state">No todos yet. Add one above!</p>
      )}

      <p className="hint">
        Open this page in another tab to see real-time sync!
      </p>
    </div>
  )
}
