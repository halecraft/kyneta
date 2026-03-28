# Collaborative Todo

A minimal collaborative todo app demonstrating the full Kyneta stack: real-time sync between browser tabs with ~200 lines of TypeScript.

**No Vite. No React. Just Bun + Kyneta.**

## Quick Start

```bash
# From the kyneta root
pnpm install

# Start the server (builds client automatically)
cd examples/todo
bun run dev
```

Open http://localhost:5173 in two browser tabs and watch todos sync in real-time!

## What's Here

```
todo/
├── public/
│   └── index.html       # 13 lines — HTML shell
├── src/
│   ├── schema.ts        # 32 lines — LoroSchema + bindLoro
│   ├── app.ts           # 123 lines — Cast view (compiled by unplugin)
│   ├── main.ts          # 43 lines — Client bootstrap (Exchange + mount)
│   ├── server.ts        # 87 lines — Bun server (Exchange + Bun.serve)
│   ├── server-node.ts   # 101 lines — Node.js variant (ws + http)
│   └── build.ts         # 37 lines — Standalone client build script
├── style.css            # 73 lines — Minimal styling
├── package.json
├── tsconfig.json
└── README.md
```

## The Core Pattern

### 1. Define a Schema

```ts
import { LoroSchema, Schema } from "@kyneta/schema"
import { bindLoro } from "@kyneta/loro-schema"

export const TodoSchema = LoroSchema.doc({
  todos: Schema.list(
    Schema.struct({
      text: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

export const TodoDoc = bindLoro(TodoSchema)
```

### 2. Create an Exchange

```ts
// Server
const serverAdapter = new WebsocketServerAdapter()
const exchange = new Exchange({
  identity: { name: "server", type: "server" },
  adapters: [serverAdapter],
})
exchange.get("todos", TodoDoc)

// Client
const wsAdapter = new WebsocketClientAdapter({ url: `ws://${location.host}/ws` })
const exchange = new Exchange({ adapters: [wsAdapter] })
const doc = exchange.get("todos", TodoDoc)
```

### 3. Render with Cast

```ts
export function createApp(doc: TodoDocRef) {
  return div({ class: "app" }, () => {
    h1("Collaborative Todos")

    ul(() => {
      for (const todo of doc.todos) {   // → listRegion (O(k) DOM ops)
        li(() => {
          input({ type: "checkbox", checked: todo.done })  // → valueRegion
          span(todo.text)                                   // → valueRegion
        })
      }
    })
  })
}
```

The Kyneta compiler transforms builder calls (`div`, `h1`, `ul`, etc.) into template-cloned DOM factories with reactive regions. No virtual DOM — changes from the CRDT list produce direct O(k) DOM mutations.

## Swap Yjs

The todo uses Loro CRDTs via `bindLoro`. To use Yjs instead, change one import and one call:

```diff
- import { bindLoro } from "@kyneta/loro-schema"
+ import { bindYjs } from "@kyneta/yjs-schema"

- export const TodoDoc = bindLoro(TodoSchema)
+ export const TodoDoc = bindYjs(TodoSchema)
```

Everything else — schema, Exchange, transport, Cast view — stays the same.

## How It Works

1. **On server start**: `Bun.build()` compiles `src/main.ts` (and its imports) with the Cast unplugin → `dist/`
2. **Browser loads**: `index.html` → bundled JS + WASM (loro-crdt)
3. **WebSocket connects**: Client Exchange ↔ Server Exchange via the three-message sync protocol (discover → interest → offer)
4. **Changes sync**: Any `change(doc, ...)` call automatically propagates to all connected clients via the Exchange's changefeed → synchronizer wiring

## What's NOT Here (Intentionally)

This example focuses on the essentials. For more advanced patterns, see the other examples:

- ❌ Persistence — in-memory only; restart clears all todos
- ❌ SSR — see `examples/recipe-book` for Cast SSR with Vite
- ❌ Authentication — no auth; all clients share one document
- ❌ Hot module reloading — restart the server to see changes
- ❌ React — see the todo-react example (shares this schema + server)
