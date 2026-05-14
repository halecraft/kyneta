# @kyneta/changefeed

The universal reactive contract for Kyneta — a Moore machine identified by `[CHANGEFEED]`.

## Overview

A **changefeed** is a reactive value with a current state and a stream of future changes. You read `.current` to see what's there now; you `.subscribe()` to learn what changes next.

The protocol is expressed through a single well-known symbol: `CHANGEFEED` (`Symbol.for("kyneta:changefeed")`). Any object carrying this symbol participates in the reactive protocol — schema-interpreted refs, local state, peer lifecycle feeds, or anything else.

This package contains the **contract only** — zero dependencies, no schema, no interpreters, no paths. Schema-specific extensions (`Op`, `TreeChangefeedProtocol`, tree observation) live in `@kyneta/schema`, which depends on this package.

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

// A Changefeed that is also callable — feed() returns feed.current.
type CallableChangefeed<S, C extends ChangeBase = ChangeBase> =
  Changefeed<S, C> & (() => S)
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
feed.current          // live value
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
| `ChangefeedProtocol<S, C>` | `TreeChangefeedProtocol<S, C>` (adds `subscribeTree`) |
| `Changefeed<S, C>` | `HasTreeChangefeed<S, C>` |
| `hasChangefeed()` | `hasTreeChangefeed()`, `getOrCreateChangefeed()` |
| `createChangefeed()`, `createCallable()` | `expandMapOpsToLeaves()` |

Consumers import the contract from `@kyneta/changefeed` directly — schema does **not** re-export contract symbols. The import path tells the truth about the dependency.

## Relationship to `@kyneta/cast`

The Kyneta compiler detects `[CHANGEFEED]` structurally on types for automatic reactive subscription. `HasChangefeed<S, C>` is the type-level marker the compiler looks for. The Cast runtime uses `hasChangefeed()` at runtime to discover reactive values and subscribe to their change streams.

## License

MIT