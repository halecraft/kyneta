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
│   ├── schema.ts        # 32  lines — @kyneta/schema + loro.bind
│   ├── app.ts           # 123 lines — @kyneta/cast view (compiled by unplugin)
│   ├── main.ts          # 43  lines — Client (@kyneta/exchange + mount)
│   ├── server.ts        # 87  lines — Server (@kyneta/exchange + Bun.serve)
│   └── build.ts         # 37  lines — Build & bundle via Bun
├── style.css            # 73  lines — Minimal styling
├── package.json
├── tsconfig.json
└── README.md
```

## The Core Pattern

### 1. Define a Schema

```ts
import { Schema } from "@kyneta/schema"
import { loro } from "@kyneta/loro-schema"

export const TodoSchema = Schema.doc({
  todos: Schema.list(
    Schema.struct({
      text: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

export const TodoDoc = loro.bind(TodoSchema)
```

### 2. Create an Exchange

```ts
// Server
const wsServer = new WebsocketServerTransport()
const exchange = new Exchange({
  identity: { name: "server" },
  transports: [wsServer],
})
const doc = exchange.get("todos", TodoDoc)

// Client
const wsClient = new WebsocketClientTransport({ url: `ws://${location.host}/ws` })
const exchange = new Exchange({
  identity: { name: "client" },
  transports: [wsClient]
})
const doc = exchange.get("todos", TodoDoc)
```

### 3. Render with @kyneta/cast

```ts
export function createApp(doc: TodoDocRef) {
  return div({ class: "app" }, () => {  // `div` is a builder call
    h1("Collaborative Todos")           // `h1` is a builder call, etc.

    ul(() => {
      for (const todo of doc.todos) {   // → listRegion (O(k) DOM ops)
        li(() => {
          input({ type: "checkbox", checked: todo.done })   // → valueRegion
          span(todo.text)                                   // → valueRegion
        })
      }
    })
  })
}
```

The Kyneta compiler transforms builder calls (`div`, `h1`, `ul`, etc.) into very fast template-cloned DOM factories with reactive regions. No virtual DOM — changes from the CRDT list produce direct O(k) DOM mutations.

## Swap Yjs

The todo uses Loro CRDTs via `loro.bind`. To use Yjs instead, change one import and one call:

```diff
- import { loro } from "@kyneta/loro-schema"
+ import { yjs } from "@kyneta/yjs-schema"

- export const TodoDoc = loro.bind(TodoSchema)
+ export const TodoDoc = yjs.bind(TodoSchema)
```

Everything else — schema, Exchange, transport, @kyneta/cast view — stays the same.

## How It Works

1. **On server start**: `Bun.build()` compiles `src/main.ts` (and its imports) with the @kyneta/cast via [unplugin](https://unplugin.unjs.io/) → `dist/`
2. **Browser loads**: `index.html` → bundled JS + WASM (loro-crdt) as server-side rendered HTML
3. **WebSocket connects**: Client Exchange ↔ Server Exchange via the three-message sync protocol (discover → interest → offer)
4. **Changes sync**: Any `change(doc, ...)` call automatically propagates to all connected clients via the Exchange's changefeed → synchronizer wiring

## Why Is This Interesting?

This isn't just a todo app. You write ~200 lines of TypeScript and get server-side rendering, real-time collaborative sync, compiled reactive UI, pluggable network and stores, and a swappable CRDT engine — with nothing between the data change and the DOM update (not even a DOM diff engine).

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

The compiler detects that `doc.todos` is a CRDT list and `todo.done` / `todo.text` are reactive fields. It extracts the entire static shell into a single DOM template string (one `innerHTML` parse, one `cloneNode` at mount — no `createElement` chains), then emits the reactive parts as direct DOM assignments, and tracks reactive dependencies automatically:

```js
(v) => { _input2.checked = v; }   // checkbox toggle — one property write
(v) => { _text4.textContent = String(v); }  // text update — one text node write
```

That's it. That's the hot path. When a checkbox toggles on another tab, the CRDT delta arrives and one `checked = v` fires. When a todo is added remotely, one `insertBefore` fires. No virtual DOM, no diffing, no reconciliation — the CRDT already knows what changed, and the compiler wires that knowledge straight to the DOM.

### One schema declaration, one object that does everything

You declare the document shape once, using an ergonomic schema DSL:

```ts
export const TodoSchema = Schema.doc({
  todos: Schema.list(
    Schema.struct({
      text: Schema.string(),
      done: Schema.boolean()
    })
  ),
})
```

From that single declaration, kyneta/schema builds a tree of `Ref`s — one shape you use for everything:

```ts
doc()                    // read — snapshot the doc as a plain JS object
doc.todos()              // read — snapshot the whole list as a plain JS array
doc.todos.at(0).text()   // navigate + read — drill into a single field
doc.todos.push(...)      // write — append to the CRDT list
doc.todos.at(0).done.set(true)  // write — set a nested field

change(doc, d => {       // transact — batch multiple writes into one changefeed notification
  d.todos.push({ text: "new", done: false })
  d.todos.at(0).done.set(true)
})

subscribe(doc.todos, (changeset) => { ... })  // observe — react to changes

const typed = validate(TodoSchema, input)     // validate, similar to Zod parse
```

No separate read model and write model. No action creators and reducers. No manual subscription wiring. The ref *is* the reading API, the mutation API, and the observation API — and the kyneta/compiler hooks into its observation protocol automatically.

### The CRDT engine is a one-line swap

The todo currently runs on **Loro**. To switch to **Yjs**, change one import and swap `loro.bind` for `yjs.bind`:

```diff
- import { loro } from "@kyneta/loro-schema"
+ import { yjs } from "@kyneta/yjs-schema"
```

The @kyneta/exchange, the @kyneta/wire protocol, the @kyneta/cast view, the server — none of them know or care. The `Substrate` interface abstracts the CRDT behind `exportSnapshot()`, `importDelta()`, and `version()`. Two completely different CRDT engines, same sync protocol, same compiled UI.

### The sync layer is pluggable end-to-end

The @kyneta/exchange handles sync through pluggable **transports** and pluggable **stores** — via the same five-message protocol (`establish`, `discover`, `interest`, `offer`) regardless of what's underneath. This todo uses WebSocket, but the adapter could be SSE, WebRTC, or HTTP polling without changing a line of application code.

The synchronizer itself is a pure **TEA (Elm Architecture) state machine**: immutable model in, commands out, no I/O. Multi-hop relay — server receives a change from Tab A, forwards to Tab B — falls out naturally from this design, because the state machine doesn't know or care where messages came from.

### 200 lines on top of 40,000

The application code is ~200 lines of TypeScript. Beneath it:
- ~10,800 lines of @kyneta/schema algebra,
- ~7,400 lines of @kyneta/compiler,
- ~8,200 lines of @kyneta/cast browser runtime,
- ~3,600 lines of @kyneta/exchange state bus,
- ~2,800 lines of @kyneta/websocket-transport transport,
- ~1,900 lines of @kyneta/wire protocol,
- ~5,250 lines of @kyneta/loro or @kyneta/yjs CRDT substrate adapters.
- Verified by 4,300+ tests.

The complete built output ships at **753 KB** for Loro, or **58 KB** for Yjs (brotli compressed). That includes a full CRDT engine, the @kyneta/schema interpreter, the @kyneta/cast runtime, the @kyneta/exchange state bus, and the @kyneta/websocket-transport.

## What's NOT Here (Intentionally)

This example focuses on the essentials. For more advanced patterns, see the other examples:

- ❌ Persistence — in-memory only; restart clears all todos
- ❌ Authentication — no auth; all clients share one document
- ❌ Hot module reloading — restart the server to see changes
- ❌ React — see the [todo-react](../todo-react/) example (same schema, React hooks, Yjs substrate)
