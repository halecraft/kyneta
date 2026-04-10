# Collaborative Todo (React)

The same collaborative todo app as [`examples/todo`](../todo/), rebuilt with React — proving the sync layer is framework-agnostic.

**Same schema. Same Exchange. Same sync protocol.**
**React instead of Cast. Yjs instead of Loro. Vite instead of Bun.build. Node instead of Bun.**

## Quick Start

```bash
# From the kyneta root
pnpm install

# Start the server (Vite HMR + WebSocket sync, single process)
cd examples/todo-react
pnpm run dev
```

Open http://localhost:5173 in two browser tabs and watch todos sync in real-time!

> **Note:** This example uses port 5173 (Vite's default), the same port as the Cast todo. Stop one before starting the other.

## What's Here

```
todo-react/
├── index.html         # 13  lines — HTML shell
├── vite.config.ts     #  6  lines — @vitejs/plugin-react, nothing else
├── src/
│   ├── schema.ts      # 27  lines — @kyneta/schema + yjs.bind
│   ├── app.tsx        # 122 lines — React component + @kyneta/react hooks
│   ├── main.tsx       # 39  lines — Client (ExchangeProvider + mount)
│   └── server.ts      # 102 lines — Server (Vite middleware + Exchange + ws)
├── style.css          # 78  lines — Minimal styling
├── package.json
├── tsconfig.json
└── README.md
```

## What Changed From the Cast Todo

| Concern | Cast todo | React todo |
|---------|-----------|------------|
| **UI framework** | `@kyneta/cast` (compiled builder syntax) | `react` + `@kyneta/react` hooks |
| **CRDT substrate** | Loro (WASM, ~753 KB) | Yjs (pure JS, ~58 KB) |
| **Build system** | `Bun.build` + Cast unplugin | Vite + `@vitejs/plugin-react` |
| **Runtime** | Bun | Node (via `tsx`) |
| **Server** | `Bun.serve()` + `createBunWebsocketHandlers` | `node:http` + Vite middleware + `ws` + `wrapNodeWebsocket` |
| **HMR** | None (rebuild + reload) | Vite React Fast Refresh |

| Concern | Cast todo | React todo |
|---------|-----------|------------|
| **Schema** | `Schema.struct({ todos: ... })` | Identical |
| **Binding** | `loro.bind(TodoSchema)` | `yjs.bind(TodoSchema)` |
| **Exchange** | `new Exchange({ transports: [...] })` | Identical |
| **Transport** | WebSocket | Identical |
| **Sync protocol** | discover → interest → offer | Identical |

The entire sync layer is unchanged. Only the UI framework, the CRDT substrate, and the server shell differ.

## The One-Line Substrate Swap

The Cast todo uses Loro:

```ts
import { loro } from "@kyneta/loro-schema"
export const TodoDoc = loro.bind(TodoSchema)
```

This example uses Yjs:

```ts
import { yjs } from "@kyneta/yjs-schema"
export const TodoDoc = yjs.bind(TodoSchema)
```

Same schema. Same `exchange.get("todos", TodoDoc)`. Same three-message sync protocol. The Exchange doesn't know or care which CRDT engine is underneath.

## The Core Pattern (React)

### 1. Define a Schema

```ts
import { Schema } from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"

export const TodoSchema = Schema.struct({
  todos: Schema.list(
    Schema.struct({
      text: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

export const TodoDoc = yjs.bind(TodoSchema)
```

### 2. Provide an Exchange

```tsx
import { ExchangeProvider } from "@kyneta/react"
import { WebsocketClientTransport } from "@kyneta/websocket-transport/client"

const wsAdapter = new WebsocketClientTransport({
  url: `ws://${location.host}/ws`,
})

createRoot(document.getElementById("root")!).render(
  <ExchangeProvider config={{ transports: [wsAdapter] }}>
    <App />
  </ExchangeProvider>,
)
```

### 3. Use Hooks

```tsx
import { useDocument, useValue, useSyncStatus, change } from "@kyneta/react"

function App() {
  const doc = useDocument("todos", TodoDoc)
  const { todos } = useValue(doc)

  const addTodo = (text: string) => {
    change(doc, (d) => {
      d.todos.push({ text, done: false })
    })
  }

  return (
    <ul>
      {todos.map((todo, i) => (
        <li key={i}>{todo.text}</li>
      ))}
    </ul>
  )
}
```

## Architecture: Single-Process Vite Middleware

The server combines Vite and WebSocket sync in one process on one port:

```
┌─────────────────────────────────────────────────┐
│                  node:http server                │
│                                                  │
│  ┌──────────────────┐  ┌──────────────────────┐  │
│  │  Vite middleware  │  │  ws WebSocketServer  │  │
│  │  (HMR, modules,  │  │  (path: /ws)         │  │
│  │   index.html)    │  │                      │  │
│  └──────────────────┘  └──────────┬───────────┘  │
│                                   │              │
│                        ┌──────────┴───────────┐  │
│                        │  WebsocketServer     │  │
│                        │  Adapter             │  │
│                        │  (wrapNodeWebsocket) │  │
│                        └──────────┬───────────┘  │
│                                   │              │
│                        ┌──────────┴───────────┐  │
│                        │  Exchange            │  │
│                        │  (sync hub)          │  │
│                        └──────────────────────┘  │
└─────────────────────────────────────────────────┘
```

`createViteServer()` is awaited before `httpServer.listen()`, so the server is fully ready before accepting any connections. No queuing or readiness checks needed.

### Why Node (not Bun)?

Vite's dev server internals use Node's `http`, `net`, and `stream` modules. The `tsx` runner provides TypeScript execution on Node. This is intentional — the Cast todo uses Bun, this example uses Node, demonstrating runtime agnosticism.

## The Import Story

A React developer needs two import sources:

```ts
// Everything React-related: hooks, context, re-exported schema/exchange APIs
import { ExchangeProvider, useDocument, useValue, change } from "@kyneta/react"

// The transport adapter (one per transport type)
import { WebsocketClientTransport } from "@kyneta/websocket-transport/client"
```

`@kyneta/react` re-exports `Exchange`, `change`, `Schema`, `subscribe`, and other commonly needed APIs from `@kyneta/schema` and `@kyneta/exchange`, so most application code only imports from one package.

## What's NOT Here (Intentionally)

This example focuses on the essentials. For more advanced patterns, see the other examples:

- ❌ Persistence — in-memory only; restart clears all todos
- ❌ Authentication — no auth; all clients share one document
- ❌ SSE transport — see the chat example
- ❌ Cast — see the [todo](../todo/) example (shares this schema + server pattern)
- ❌ Loro — see the [todo](../todo/) example (one-line swap: `loro.bind` ↔ `yjs.bind`)
