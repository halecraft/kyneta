// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo React — App
//
//   Collaborative todo list with real-time text editing.
//
//   Each todo item's text is a CRDT text field (Schema.text()) bound to
//   an <input> via useText. Two users can edit the same todo item
//   simultaneously — character-level changes merge without conflict.
//
//   Imports from @kyneta/react:
//     useDocument   — get (or create) a document from the Exchange
//     useValue      — subscribe to a ref's plain snapshot (re-renders)
//     useText       — bind a CRDT text ref to an <input> or <textarea>
//     useSyncStatus — observe sync connection state
//     change        — transact mutations on the document ref
//
// ═══════════════════════════════════════════════════════════════════════════

import {
  useDocument,
  useValue,
  useText,
  useSyncStatus,
  change,
} from "@kyneta/react"
import type { TextRefLike } from "@kyneta/react"
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
// TodoItem — a single todo with collaborative text editing
// ─────────────────────────────────────────────────────────────────────────

function TodoItem({
  todoRef,
  onToggle,
  onRemove,
}: {
  todoRef: any
  onToggle: () => void
  onRemove: () => void
}) {
  const done = useValue(todoRef.done) as boolean
  const textInputRef = useText(todoRef.text as unknown as TextRefLike)

  return (
    <li>
      <input type="checkbox" checked={done} onChange={onToggle} />
      <input
        ref={textInputRef}
        type="text"
        className={done ? "todo-text done" : "todo-text"}
        placeholder="What needs to be done?"
      />
      <button type="button" onClick={onRemove}>
        ×
      </button>
    </li>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// App — the collaborative todo list
// ─────────────────────────────────────────────────────────────────────────

export function App() {
  const doc = useDocument("todos", TodoDoc)
  const { todos } = useValue(doc) as {
    todos: readonly { text: string; done: boolean }[]
  }

  // ─── Mutations ─────────────────────────────────────────────────────

  const addTodo = () => {
    // Push a new todo with empty text. The text field is a CRDT —
    // the user types into the <input> bound via useText, which
    // applies character-level edits directly to the CRDT.
    doc.todos.push({ text: "", done: false })
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

      <div className="add-bar">
        <button type="button" onClick={addTodo}>
          + Add todo
        </button>
      </div>

      <ul>
        {todos.map((_todo, index) => (
          <TodoItem
            key={index}
            todoRef={doc.todos.at(index)}
            onToggle={() => toggleTodo(index)}
            onRemove={() => removeTodo(index)}
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