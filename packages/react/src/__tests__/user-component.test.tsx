import { deleted, remove, Schema } from "@kyneta/schema"
import { batch, createDoc } from "@kyneta/schema/basic"
import { act, render, screen } from "@testing-library/react"
import React, { useMemo } from "react"
import { describe, expect, it, vi } from "vitest"
import { useValue } from "../use-value.js"

const TodoDoc = Schema.product({
  todos: Schema.sequence(
    Schema.product({
      id: Schema.text(),
      text: Schema.text(),
      done: Schema.scalar<boolean>(false),
    }),
  ),
})

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))

function TodoItem({
  todoRef,
  onRemove,
}: {
  todoRef: any
  onRemove: () => void
}) {
  return (
    <li>
      <span data-testid="todo-id">{todoRef.id()}</span>
      <button data-testid="remove-btn" onClick={onRemove}>
        X
      </button>
    </li>
  )
}

function App() {
  const doc = useMemo(() => {
    const doc = createDoc(TodoDoc)
    batch(doc, (d: any) => {
      d.todos.push({ id: "t1", text: "", done: false })
    })
    return doc
  }, [])

  const todoRef = doc.todos.at(0)
  const todoDeleted = useValue(deleted(todoRef))

  return (
    <ul data-testid="list">
      {todoRef && !todoDeleted ? (
        <TodoItem
          todoRef={todoRef}
          onRemove={() => {
            batch(doc, () => {
              remove(todoRef)
            })
          }}
        />
      ) : null}
    </ul>
  )
}

describe("User Component", () => {
  it("renders and handles deletion without crashing", async () => {
    render(<App />)

    expect(screen.getByTestId("todo-id").textContent).toBe("t1")

    act(() => {
      screen.getByTestId("remove-btn").click()
    })
    await tick()

    expect(screen.queryByTestId("todo-id")).toBeNull()
  })
})
