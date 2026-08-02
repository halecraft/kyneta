// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo React — TodoItem
//
//   A single todo row. Self-contained: it reads/sets its own `done`, binds
//   its own CRDT text via useText, and removes itself via the remove()
//   facade. The parent passes only the ref, whether to autofocus, and what
//   "Enter" should do.
//
// ═══════════════════════════════════════════════════════════════════════════

import { useText, useValue } from "@kyneta/react"
import { type Ref, type Removable, remove } from "@kyneta/schema"
import type { TodoItemSchema } from "./schema.js"

export function TodoItem({
  todoRef,
  autoFocus,
  onEnter,
}: {
  todoRef: Removable<Ref<typeof TodoItemSchema>>
  autoFocus: boolean
  onEnter: () => void
}) {
  const done = useValue(todoRef.done)

  return (
    <li>
      <input
        type="checkbox"
        checked={done}
        onChange={() => todoRef.done.set(!done)}
      />
      <input
        ref={useText(todoRef.text)}
        type="text"
        className={done ? "todo-text done" : "todo-text"}
        placeholder="What needs to be done?"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        onKeyDown={e => {
          if (e.key === "Enter") {
            e.preventDefault()
            onEnter()
          }
        }}
      />
      <button type="button" onClick={() => remove(todoRef)}>
        ×
      </button>
    </li>
  )
}
