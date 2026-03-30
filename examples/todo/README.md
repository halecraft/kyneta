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
│   ├── app.ts           # 123 lines — @kyneta/cast view (compiled by unplugin)
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

### 3. Render with @kyneta/cast

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

Everything else — schema, Exchange, transport, @kyneta/cast view — stays the same.

## How It Works

1. **On server start**: `Bun.build()` compiles `src/main.ts` (and its imports) with the @kyneta/cast unplugin → `dist/`
1. **Browser loads**: `index.html` → bundled JS + WASM (loro-crdt)
1. **WebSocket connects**: Client Exchange ↔ Server Exchange via the three-message sync protocol (discover → interest → offer)
1. **Changes sync**: Any `change(doc, ...)` call automatically propagates to all connected clients via the Exchange's changefeed → synchronizer wiring

## Why Is This Interesting?

This isn't just a todo app. You write ~200 lines of TypeScript and get real-time collaborative sync, compiled reactive UI, and a swappable CRDT engine — with nothing between the data change and the DOM update.

### The compiled output is as fast as hand-written DOM code

You write a `for...of` loop over a CRDT list:

```ts
for (const todo of doc.todos) {
  li(() => {
    input({ type: "checkbox", checked: todo.done })
    span(todo.text)
  })
}
```

The compiler detects that `doc.todos` is a CRDT list and `todo.done` / `todo.text` are reactive fields. It extracts the entire static shell into a single HTML template string (one `innerHTML` parse, one `cloneNode` at mount — no `createElement` chains), then emits the reactive parts as direct DOM assignments:

```js
(v) => { _input2.checked = v; }   // checkbox toggle — one property write
(v) => { _text4.textContent = String(v); }  // text update — one text node write
```

That's it. That's the hot path. When a checkbox toggles on another tab, the CRDT delta arrives and one `checked = v` fires. When a todo is added remotely, one `insertBefore` fires. No virtual DOM, no diffing, no reconciliation — the CRDT already knows what changed, and the compiler wires that knowledge straight to the DOM.

### One schema declaration, one object that does everything

You declare the document shape once:

```ts
export const TodoSchema = LoroSchema.doc({
  todos: Schema.list(
    Schema.struct({
      text: Schema.string(),
      done: Schema.boolean()
    })
  ),
})
```

From that single declaration, `interpret()` builds a `Ref` — one object you use for everything:

```ts
doc.todos()              // read — snapshot the whole list as a plain JS array
doc.todos.at(0).text()   // navigate + read — drill into a single field
doc.todos.push(...)      // write — append to the CRDT list
doc.todos.at(0).done.set(true)  // write — set a nested field

change(doc, d => {       // transact — batch multiple writes into one changefeed notification
  d.todos.push({ text: "new", done: false })
  d.todos.at(0).done.set(true)
})

subscribe(doc.todos, (changeset) => { ... })  // observe — react to changes from any source
```

No separate read model and write model. No action creators and reducers. No manual subscription wiring. The ref *is* the reading API, the mutation API, and the observation API — and the compiler hooks into its observation protocol automatically.

### The CRDT engine is a one-line swap

The todo currently runs on **Yjs**. To switch to **Loro**, change one import and swap "bindLoro" for "bindYjs":

```diff
- import { bindYjs } from "@kyneta/yjs-schema"
+ import { bindLoro } from "@kyneta/loro-schema"
```

The Exchange, the wire protocol, the @kyneta/cast view, the server — none of them know or care. The `Substrate` interface abstracts the CRDT behind `exportSnapshot()`, `importDelta()`, and `version()`. Two completely different CRDT engines, same sync protocol, same compiled UI.

### The sync layer is pluggable end-to-end

The Exchange handles sync through pluggable **network adapters** and pluggable **storage adapters** — same five-message protocol (`establish`, `discover`, `interest`, `offer`) regardless of what's underneath. This todo uses WebSocket, but the adapter could be SSE, WebRTC, or HTTP polling without changing a line of application code.

The synchronizer itself is a pure **TEA (Elm Architecture) state machine**: immutable model in, commands out, no I/O. Multi-hop relay — server receives a change from Tab A, forwards to Tab B — falls out naturally from this design, because the state machine doesn't know or care where messages came from.

### 200 lines on top of 40,000

The application code is ~200 lines of TypeScript. Beneath it: ~10,800 lines of schema algebra, ~7,400 lines of compiler, ~8,200 lines of @kyneta/cast runtime, ~3,600 lines of Exchange, ~2,800 lines of WebSocket transport, ~1,900 lines of wire protocol, ~5,250 lines of CRDT substrate adapters. Verified by 4,300+ tests.

The built output ships at **58 KB** (brotli). That includes the full Yjs CRDT engine, the schema interpreter, the @kyneta/cast runtime, the Exchange, and the WebSocket transport.

## What's NOT Here (Intentionally)

This example focuses on the essentials. For more advanced patterns, see the other examples:

- ❌ Persistence — in-memory only; restart clears all todos
- ❌ SSR — see `examples/recipe-book` for @kyneta/cast SSR with Vite
- ❌ Authentication — no auth; all clients share one document
- ❌ Hot module reloading — restart the server to see changes
- ❌ React — see the todo-react example (shares this schema + server)
