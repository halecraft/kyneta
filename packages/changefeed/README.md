# @kyneta/changefeed

The universal reactive contract for Kyneta — a Moore machine identified by `[CHANGEFEED]`.

## Overview

A **changefeed** is a reactive value with a current state and a stream of future changes. You read `.current` to see what's there now; you `.subscribe()` to learn what changes next.

`.current` keeps its identity until the state changes, and is a new value once it has. So comparing two reads with `===` tells you whether anything changed — which is what `useSyncExternalStore`, `React.memo` and every framework's equality check assume.

The protocol is expressed through a single well-known symbol: `CHANGEFEED` (`Symbol.for("kyneta:changefeed")`). Any object carrying this symbol participates in the reactive protocol — schema-interpreted refs, local state, peer lifecycle feeds, or anything else.

This package contains the **contract only** — zero dependencies, no schema, no interpreters, no paths. Schema-specific extensions (`Op`, `RecursiveChangefeedProtocol`, tree observation) live in `@kyneta/schema`, which depends on this package.

## Install

```sh
pnpm add @kyneta/changefeed
```

## API

### Types

```ts
// The universal base type for all changes — an open protocol identified by a string discriminant.
interface ChangeBase {
  readonly type: string
}

// A batch of changes with optional provenance.
interface Changeset<C = ChangeBase> {
  readonly changes: readonly C[]
  readonly origin?: string
}

// The protocol object behind [CHANGEFEED] — a Moore machine coalgebra.
interface ChangefeedProtocol<S, C extends ChangeBase = ChangeBase> {
  readonly current: S
  subscribe(callback: (changeset: Changeset<C>) => void): () => void
}

// Developer-facing type: [CHANGEFEED] marker + direct .current and .subscribe().
interface Changefeed<S, C extends ChangeBase = ChangeBase> {
  readonly [CHANGEFEED]: ChangefeedProtocol<S, C>
  readonly current: S
  subscribe(callback: (changeset: Changeset<C>) => void): () => void
}

// Marker interface — any object with [CHANGEFEED] participates in the protocol.
interface HasChangefeed<S = unknown, A extends ChangeBase = ChangeBase> {
  readonly [CHANGEFEED]: ChangefeedProtocol<S, A>
}

// A function that reads a value and carries its [CHANGEFEED].
type Feed<S, C extends ChangeBase = ChangeBase> = (() => S) & HasChangefeed<S, C>

// A Changefeed that is also callable — feed() returns feed.current.
type CallableChangefeed<S, C extends ChangeBase = ChangeBase> =
  Changefeed<S, C> & Feed<S, C>
```

### Functions

#### `createChangefeed<S, C>(getCurrent: () => S): [Changefeed<S, C>, emit]`

Create a standalone changefeed with push semantics. Returns a `[feed, emit]` tuple.

```ts
import { createChangefeed } from "@kyneta/changefeed"

let count = 0
const [feed, emit] = createChangefeed(() => count)

feed.current              // 0
feed.subscribe(cs => console.log(cs.changes))

count = 1
emit({ changes: [{ type: "increment", amount: 1 }] })
// subscriber receives the changeset
```

`feed.current` is whatever `getCurrent` returns, so keeping its identity until the state changes is up to `getCurrent`. Over mutable state, keep one snapshot:

#### `cachedSnapshot<T>(build: () => T): { get(): T; invalidate(): void }`

One snapshot of mutable state: `get()` builds it on first read and returns the same value after; `invalidate()`, called wherever the state mutates, drops it.

```ts
import { cachedSnapshot, createChangefeed } from "@kyneta/changefeed"

const items = new Map<string, number>()
const snapshot = cachedSnapshot<ReadonlyMap<string, number>>(() => new Map(items))
const [feed, emit] = createChangefeed(snapshot.get)

items.set("a", 1)
snapshot.invalidate()
emit({ changes: [{ type: "set", key: "a" }] })
```

#### `createFeed<S, C>(read: () => S, protocol: ChangefeedProtocol<S, C>): Feed<S, C>`

A function that calls `read`, carrying `protocol` under `[CHANGEFEED]`. The shape of a value you read by calling and observe through the protocol, such as `populatedFeed(ref)` in `@kyneta/schema`.

```ts
import { createFeed } from "@kyneta/changefeed"

const ready = createFeed(() => loaded, {
  get current() { return loaded },
  subscribe: callback => onLoad(() => callback({ changes: [] })),
})

ready()             // read
hasChangefeed(ready) // true
```

#### `createCallable<S, C>(feed: Changefeed<S, C>): CallableChangefeed<S, C>`

Wrap a changefeed in a callable function-object. `feed()` returns `feed.current`.

```ts
import { createChangefeed, createCallable } from "@kyneta/changefeed"

let count = 0
const [source, emit] = createChangefeed(() => count)
const feed = createCallable(source)

feed()          // 0 — callable
feed.current    // 0 — getter
feed.subscribe  // subscribe to changes
```

#### `changefeed<S, C>(source: HasChangefeed<S, C>): Changefeed<S, C>`

Project any object with `[CHANGEFEED]` into a developer-facing `Changefeed` — lifting the hidden protocol surface to direct `.current` and `.subscribe()` accessibility.

```ts
import { changefeed } from "@kyneta/changefeed"

const feed = changefeed(doc.title)
feed.current          // the current value
feed.subscribe(cb)    // subscribe to changes
```

#### `hasChangefeed(value: unknown): value is HasChangefeed`

Type guard — returns `true` if `value` has a `[CHANGEFEED]` property.

#### `staticChangefeed<S>(head: S): ChangefeedProtocol<S, never>`

Creates a protocol object that never emits changes — useful for static data sources that still need to participate in the protocol.

## Relationship to `@kyneta/schema`

`@kyneta/schema` depends on `@kyneta/changefeed` and extends the contract with tree-structured observation:

| This package (`@kyneta/changefeed`) | `@kyneta/schema` |
|---|---|
| `ChangeBase` | `TextChange`, `MapChange`, `SequenceChange`, ... |
| `Changeset<C>` | `Op<C>` (addressed delta with `Path`) |
| `ChangefeedProtocol<S, C>` | `RecursiveChangefeedProtocol<S, C>` (adds `subscribeDescendants`) |
| `Changefeed<S, C>` | `HasRecursiveChangefeed<S, C>` |
| `hasChangefeed()` | `hasRecursiveChangefeed()`, `getOrCreateChangefeed()` |
| `createChangefeed()`, `createFeed()`, `createCallable()` | `expandProductMapChanges()` (a struct's map event as field writes, for CRDT bridges) |

Consumers import the contract from `@kyneta/changefeed` directly — schema does **not** re-export contract symbols. The import path tells the truth about the dependency.

## Relationship to `@kyneta/cast`

The Kyneta compiler detects `[CHANGEFEED]` structurally on types for automatic reactive subscription. `HasChangefeed<S, C>` is the type-level marker the compiler looks for. The Cast runtime uses `hasChangefeed()` at runtime to discover reactive values and subscribe to their change streams.

## License

MIT