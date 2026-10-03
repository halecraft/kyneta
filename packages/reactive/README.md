# @kyneta/reactive

Derived values over Kyneta documents that keep themselves up to date.

`reactive(thunk)` runs `thunk`, records exactly which parts of which documents it read, and runs it again when one of them changes. Nothing is compared by value: a computation re-runs when something it read changed, and only then. A burst of changes — a batch, a sync merge — re-runs it once, on the next microtask.

```ts
import { reactive } from "@kyneta/reactive"
import { batch, createDoc, Schema } from "@kyneta/schema"

const doc = createDoc(
  Schema.struct({
    todos: Schema.list(Schema.struct({ text: Schema.string(), done: Schema.boolean() })),
  }),
)

const remaining = reactive(() => doc.todos().filter(t => !t.done).length)

remaining.subscribe(() => console.log("remaining:", remaining()))

batch(doc, d => d.todos.push({ text: "Write the README", done: false }))
// next microtask: "remaining: 1"
```

## API

| Export | What it does |
|--------|--------------|
| `reactive(thunk)` | A `Reactive<T>`: call it (`r()`) or read `r.current` for the value, recomputed first if something it read changed. `r.subscribe(cb)` hears each recompute; `r.version` advances with each. |
| `computed(thunk)` | The same function as `reactive`, under the name some code reads better with. |
| `track(feed)` | Read a changefeed that is not a schema ref — an `@kyneta/index` `Collection`, `exchange.peers` — as a dependency of the enclosing computation. Schema refs are tracked when you call them. |
| `diffDeps` | The pure subscription diff the runtime uses; exported for bindings. |

A `Reactive` is itself a changefeed, so one computation can read another, and `@kyneta/react`'s `useValue` and `useTracked` render one directly.

A thunk must be pure over what it captures and what it reads through Kyneta. A thunk that reads something untracked (`Date.now()`, a mutable variable) does not re-run when that changes.

See [TECHNICAL.md](./TECHNICAL.md) for how tracking, coalescing and glitch-freedom work.
