// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo — App
//
//   The main application view using Cast builder syntax.
//
//   The Kyneta compiler transforms builder calls (div, h1, ul, etc.)
//   into template-cloned DOM factories with reactive regions:
//     - `doc.todos` for...of loop → listRegion (O(k) DOM mutations)
//     - `todo.text`, `todo.done` → valueRegion (reactive subscriptions)
//     - `doc.todos.length === 0` → conditionalRegion
//
//   Architecture:
//     createApp(doc) is a pure builder function. It does NOT own the
//     document lifecycle or manage transport. The caller (main.ts)
//     creates the Exchange, gets the document ref, and passes it in.
//
// ═══════════════════════════════════════════════════════════════════════════

/// <reference types="@kyneta/cast/types/elements" />
/// <reference types="@kyneta/cast/types/reactive-view" />

import { change } from "@kyneta/schema"
import type { TodoDocRef } from "./schema.js"

// ═══════════════════════════════════════════════════════════════════════════
//
//   createApp — the application factory
//
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create the collaborative todo application element.
 *
 * @param doc - The TodoDocRef (schema ref). Backed by Loro CRDT, synced
 *   via the Exchange's WebSocket transport.
 * @returns A Cast Element — `(scope: ScopeInterface) => Node`
 */
export function createApp(doc: TodoDocRef) {
  return div({ class: "app" }, () => {
    h1("Collaborative Todos")

    // ─── Add Todo Form ─────────────────────────────────────────────
    // The form uses a plain DOM input — no synced state needed for
    // the text field. On submit, we read the input value, push a new
    // todo into the CRDT list, and reset the form.
    form(
      {
        onSubmit: (e: SubmitEvent) => {
          e.preventDefault()
          const formEl = e.currentTarget as HTMLFormElement
          const inputEl = formEl.elements.namedItem("text") as HTMLInputElement
          const text = inputEl.value.trim()
          if (!text) return

          change(doc, d => {
            d.todos.push({ text, done: false })
          })
          formEl.reset()
        },
      },
      () => {
        input({
          name: "text",
          type: "text",
          placeholder: "What needs to be done?",
        })
        button({ type: "submit" }, "Add")
      },
    )

    // ─── Todo List (delta: sequence → listRegion) ──────────────────
    // for...of over doc.todos triggers the compiler's listRegion
    // codegen. Each push/insert/delete on the CRDT list produces
    // O(1) DOM mutations per operation.
    ul(() => {
      for (const todo of doc.todos) {


        li(() => {
          // Checkbox — toggles the `done` field.
          // The compiler detects todo.done has [CHANGEFEED] and wires
          // up a valueRegion so the checkbox stays in sync.
          input({
            type: "checkbox",
            checked: todo.done,
            onChange: () => {
              const idx = [...doc.todos].indexOf(todo)
              if (idx < 0) return
              change(doc, d => {
                const current = d.todos.at(idx)
                if (current) current.done.set(!current.done())
              })
            },
          })

          // Text — the todo's description.
          span({ class: todo.done ? "done" : "" }, todo.text)

          // Remove button
          button(
            {
              type: "button",
              onClick: () => {
                const idx = [...doc.todos].indexOf(todo)
                if (idx < 0) return
                change(doc, d => {
                  d.todos.delete(idx, 1)
                })
              },
            },
            "×",
          )
        })
      }
    })

    // ─── Empty State (conditional) ─────────────────────────────────
    if (doc.todos.length === 0) {
      p({ class: "empty-state" }, "No todos yet. Add one above!")
    }

    p({ class: "hint" }, "Open this page in another tab to see real-time sync!")
  })
}
