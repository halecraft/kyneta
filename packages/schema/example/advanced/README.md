# @kyneta/schema — Advanced: Under the Hood

> **Looking to get started?** See [`example/basic/`](../basic/) instead.
> This example is for developers who want to see what `createDoc` does.

This example builds a document by hand over a substrate, shows how its refs
are made, writes a custom interpreter for the schema catamorphism, and replays
ops between documents.

## Architecture

Two things are open to you:

- **`createRef(schema, substrate)`** makes a document's root ref over any
  `Substrate`. `createDoc` from `@kyneta/schema/basic` is this over a plain
  substrate.
- **`interpret(schema, interpreter, ctx)`** folds a schema with your own
  `Interpreter`: one case per kind, children as thunks a case may force or
  not. Materializing, zeroing and validating are interpreters.

Refs themselves are one fixed construction. A ref is its state (its context,
its path, its parent, and a few slots filled on first use), bound to a
function whose prototype carries everything the ref does. There is one
prototype per schema node and position, so two items of one list share one.
A method needs its ref: pass `(v) => ref.set(v)`, not `ref.set`.

```ts
const substrate = plainSubstrateFactory.create(ProjectSchema)
const doc: Ref<typeof ProjectSchema> = createRef(ProjectSchema, substrate)

const leaves = createInterpreter<void, string[]>(
  (_ctx, path) => [path.format()],
  {
    product: (_ctx, _path, _schema, fields) =>
      Object.values(fields).flatMap(field => field()),
    sequence: (_ctx, _path, _schema, item) => item(0),
    map: (_ctx, _path, _schema, item) => item("*"),
  },
)
interpret(ProjectSchema, leaves, undefined) // ["name", "stars", "tasks[0].title", …]
```

## Running

```sh
# From packages/schema/
bun run example/advanced/main.ts
```

## What This Example Covers

1. **The Schema** — same `ProjectSchema` as the basic example
2. **Constructing createDoc by Hand** — `plainSubstrateFactory` → `createRef`
3. **Quick Mutations** — a brief recap
4. **How a Ref Is Made** — state on the ref, behaviour on a shared prototype
5. **Your Own Interpreter** — a fold that lists every leaf's path
6. **Referential Identity** — `doc.name === doc.name`, `doc() === doc()` until a write, shared subtrees, namespace isolation
7. **Symbol-Keyed Hooks** — `CALL`, `TRANSACT`, `CHANGEFEED`
8. **Pure State Transitions** — `stepText`, `stepSequence`, `stepIncrement`
9. **A Replica That Receives Ops** — `applyChanges` from elsewhere, and `RRef<S>` for code that only reads
10. **The Round-Trip at the Algebra Level** — `batch` captures ops, `applyChanges` replays them
11. **Final Snapshot**

## Symbol-Keyed Hooks

| Symbol | Module | Purpose |
|---|---|---|
| `CALL` (`kyneta:call`) | `ref/read.ts` | What calling a ref does: `ref()` is `ref[CALL]()` |
| `TRANSACT` (`kyneta:transact`) | `ref/write.ts` | Context discovery: a ref's `WritableContext` |
| `CHANGEFEED` (`kyneta:changefeed`) | `@kyneta/changefeed` | Observation: every ref's feed, made on first access |
