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
//     useSyncState  — observe per-peer sync state
//     change        — transact mutations on the document ref
//
// ═══════════════════════════════════════════════════════════════════════════

import { useDocument, useSyncState, useText, useValue } from "@kyneta/react"
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { TodoDoc } from "./schema.js"

// ─────────────────────────────────────────────────────────────────────────
// Sync indicator — shows connection state
// ─────────────────────────────────────────────────────────────────────────

function SyncIndicator({ doc }: { doc: object }) {
  const peerStates = useSyncState(doc)
  const synced = peerStates.some(s => s.state === "synced")

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
  shouldFocus,
  onFocused,
  onEnter,
  onToggle,
  onRemove,
}: {
  todoRef: any
  shouldFocus: boolean
  onFocused: () => void
  onEnter: () => void
  onToggle: () => void
  onRemove: () => void
}) {
  const done = useValue(todoRef.done) as boolean
  const bindText = useText(todoRef.text)
  const inputEl = useRef<HTMLInputElement | null>(null)

  // Compose useText's ref callback with our own node capture, so the same
  // element both drives the CRDT binding and can be focused imperatively.
  // Mirrors bindText's identity (it's stable while the text ref is), so we
  // add no extra attach/detach churn.
  const setInput = useCallback(
    (el: HTMLInputElement | null) => {
      inputEl.current = el
      bindText(el)
    },
    [bindText],
  )

  // Focus this row's input when it's the freshly-created todo.
  useEffect(() => {
    if (!shouldFocus) return
    inputEl.current?.focus()
    onFocused()
  }, [shouldFocus, onFocused])

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return
    e.preventDefault()
    // Empty field — nothing to submit; just leave the input.
    if (e.currentTarget.value.trim() === "") {
      e.currentTarget.blur()
      return
    }
    // Submit: create the next todo and focus it, for rapid entry.
    onEnter()
  }

  return (
    <li>
      <input type="checkbox" checked={done} onChange={onToggle} />
      <input
        ref={setInput}
        type="text"
        className={done ? "todo-text done" : "todo-text"}
        placeholder="What needs to be done?"
        onKeyDown={handleKeyDown}
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

  // Index of the todo whose input should grab focus once it renders.
  // Set when a todo is created (button or Enter), cleared after focusing.
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const clearFocus = useCallback(() => setFocusIndex(null), [])

  // ─── Mutations ─────────────────────────────────────────────────────

  const addTodo = useCallback(() => {
    // Push a new todo with empty text. The text field is a CRDT — the user
    // types into the <input> bound via useText, which applies character-level
    // edits directly to the CRDT. The new item is appended, so it lands at
    // the current end index; focus it so typing can start immediately.
    setFocusIndex(todos.length)
    doc.todos.push({ text: "", done: false })
  }, [doc, todos.length])

  const toggleTodo = (index: number) => {
    // Single mutation (read + set) — write directly, like addTodo/removeTodo.
    const todo = doc.todos.at(index)
    if (todo) todo.done.set(!todo.done())
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
            shouldFocus={index === focusIndex}
            onFocused={clearFocus}
            onEnter={addTodo}
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
