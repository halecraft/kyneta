# Collaborative Todo (React)

A collaborative todo app where **every todo item's text is a CRDT** — two users can edit the same todo simultaneously and both changes merge at the character level.

Built with React, Yjs, and `useText` — kyneta's hook for binding a CRDT text field to an `<input>` or `<textarea>`.

## Quick Start

```bash
# From the kyneta root
pnpm install

# Start the server (Vite HMR + WebSocket sync, single process)
cd examples/todo-react
pnpm run dev
```

Open http://localhost:5173 in two browser tabs. Add a todo in one tab, then **edit its text in both tabs at the same time** — edits merge without conflict.

> **Note:** This example uses port 5173 (Vite's default), the same port as the Cast todo. Stop one before starting the other.

## What Makes This Different

Most todo apps use `Schema.string()` for the todo text — last-writer-wins. If two users edit the same todo simultaneously, one edit is lost.

This example uses `Schema.text()` — a character-level CRDT. Each todo's text field is bound to an `<input>` via `useText`, which handles:

- **Local edits** → diffed against the CRDT and applied as insert/delete operations
- **Remote edits** → surgically patched into the `<input>` via `setRangeText`, preserving the local user's cursor position
- **Concurrent edits** → merged by the CRDT engine (Yjs) at the character level
- **IME composition** → safely deferred until the composition commits
- **Echo suppression** → local mutations don't bounce back through the changefeed

```tsx
// The key pattern: useText returns a ref callback for the <input>
function TodoItem({ todoRef }) {
  const textInputRef = useText(todoRef.text)
  return <input ref={textInputRef} type="text" />
}
```

## What's Here

```
todo-react/
├── index.html         # HTML shell
├── vite.config.ts     # @vitejs/plugin-react
├── src/
│   ├── schema.ts      # Schema.text() + yjs.bind
│   ├── app.tsx        # React components with useText
│   ├── main.tsx       # Client (ExchangeProvider + mount)
│   └── server.ts      # Server (Vite middleware + Exchange + ws)
├── style.css
├── package.json
├── tsconfig.json
└── README.md
```

## The Schema

```ts
import { Schema } from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"

export const TodoSchema = Schema.struct({
  todos: Schema.list(
    Schema.struct({
      text: Schema.text(),    // ← CRDT text, not Schema.string()
      done: Schema.boolean(),
    }),
  ),
})

export const TodoDoc = yjs.bind(TodoSchema)
```

## The Component

```tsx
import { useDocument, useValue, useText, change } from "@kyneta/react"

function TodoItem({ todoRef, onToggle, onRemove }) {
  const done = useValue(todoRef.done)
  const textInputRef = useText(todoRef.text)

  return (
    <li>
      <input type="checkbox" checked={done} onChange={onToggle} />
      <input ref={textInputRef} type="text" className={done ? "done" : ""} />
      <button onClick={onRemove}>×</button>
    </li>
  )
}

function App() {
  const doc = useDocument("todos", TodoDoc)
  const { todos } = useValue(doc)

  return (
    <ul>
      {todos.map((_, index) => (
        <TodoItem
          key={index}
          todoRef={doc.todos.at(index)}
          onToggle={() => change(doc, d => {
            const todo = d.todos.at(index)
            if (todo) todo.done.set(!todo.done())
          })}
          onRemove={() => doc.todos.delete(index, 1)}
        />
      ))}
    </ul>
  )
}
```

Key details:

- `useText(todoRef.text)` returns a React ref callback — pass it as `ref` on the `<input>`
- The `<input>` is **uncontrolled** — `useText` manages its value imperatively, not through React state
- `useValue(todoRef.done)` subscribes only to the `done` field — text changes don't re-render
- Adding a todo pushes `{ text: "", done: false }` — the user types into the CRDT-bound input

## Architecture

```
Browser Tab A                          Browser Tab B
┌─────────────────────┐                ┌─────────────────────┐
│  <input>            │                │  <input>            │
│    ↕ useText()      │                │    ↕ useText()      │
│  Yjs Y.Text         │                │  Yjs Y.Text         │
│    ↕ changefeed     │                │    ↕ changefeed     │
│  Exchange           │                │  Exchange           │
│    ↕ WebSocket      │                │    ↕ WebSocket      │
└─────────┬───────────┘                └─────────┬───────────┘
          │                                      │
          └──────────┐    ┌──────────────────────┘
                     ↓    ↓
              ┌──────────────────┐
              │  Server Exchange │
              │  (sync hub)     │
              └──────────────────┘
```

When Alice types in Tab A:
1. `input` event fires → `diffText` computes the delta → `change(ref, fn, { origin: "local" })` applies it to Yjs
2. Yjs changefeed fires with `origin: "local"` → `attach()` skips it (echo suppression)
3. Exchange sends the Yjs update to the server via WebSocket
4. Server relays to Tab B's Exchange
5. Tab B's Yjs applies the remote update → changefeed fires (no origin)
6. `attach()` applies surgical `setRangeText` patches → Bob's cursor stays in place

## What Changed From `Schema.string()`

| Concern | `Schema.string()` (LWW) | `Schema.text()` (CRDT) |
|---------|--------------------------|------------------------|
| **Concurrent edits** | Last write wins — one edit is lost | Character-level merge — both edits preserved |
| **UI binding** | Controlled input with `value` + `onChange` | Uncontrolled input with `useText` ref callback |
| **Re-renders** | Every keystroke triggers React re-render | Zero re-renders — `useText` is imperative |
| **Cursor** | React re-render can reset cursor position | Cursor preserved through remote edits via `transformIndex` |
| **IME** | Must handle carefully in controlled inputs | Built-in composition handling in `useText` |

## The One-Line Substrate Swap

This example uses Yjs:

```ts
import { yjs } from "@kyneta/yjs-schema"
export const TodoDoc = yjs.bind(TodoSchema)
```

Swap to Loro:

```ts
import { loro } from "@kyneta/loro-schema"
export const TodoDoc = loro.bind(TodoSchema)
```

Same schema. Same `useText`. Same sync protocol. The Exchange doesn't know or care which CRDT engine is underneath.