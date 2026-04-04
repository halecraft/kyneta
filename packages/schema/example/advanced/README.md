# @kyneta/schema — Advanced: The Composition Algebra

> **Looking to get started?** See [`example/basic/`](../basic/) instead.
> This example is for developers who want to understand the interpreter
> stack under the hood.

This example exercises the full composable interpreter toolkit — the
Layer 1 API exported from `@kyneta/schema`. It shows how `createDoc`
from `@kyneta/schema/basic` is built from five independent layers,
and how you can mix and match them for custom use cases.

## Architecture

The interpreter stack decomposes into **five composable layers**, each independently useful:

| Layer | What it provides | Context needed |
|---|---|---|
| `navigation` | Structural addressing — product field getters, `.at()`, `.keys()`, `.length`, sum dispatch | `RefContext { store }` |
| `readable` | Fills the `[CALL]` slot — `ref()` returns the current plain value | `RefContext { store }` |
| `caching` | Identity-preserving memoization — `doc.name === doc.name` | `RefContext { store }` |
| `writable` | Mutation methods — `.set()`, `.insert()`, `.increment()`, `.push()`, `.delete()` | `WritableContext { store, dispatch, … }` |
| `observation` | Observation protocol — `[CHANGEFEED]`, `subscribe`, `subscribeNode` | `RefContext` (works on read-only stacks too) |

The pre-built `readable` layer bundles navigation + reading + caching in one step:

```ts
// Fluent composition (what createDoc does internally):
const doc = interpret(schema, ctx)
  .with(readable)
  .with(writable)
  .with(observation)
  .done()   // → Ref<typeof schema>

// Manual composition (equivalent):
const interp = withChangefeed(withWritable(withCaching(withReadable(withNavigation(bottomInterpreter)))))
const doc = interpret(schema, interp, ctx)
```

## Running

```sh
# From packages/schema/
bun run example/advanced/main.ts
```

## What This Example Covers

1. **The Schema** — same `ProjectSchema` as the basic example
2. **Constructing createDoc by Hand** — `plainSubstrateFactory` → `substrate.context()` → `interpret` → layer composition
3. **The Five Layers** — what each adds, fluent vs manual composition
4. **Read-Only Documents** — dropping layers to get `RRef<S>` (no mutation, no observation)
5. **Referential Identity and Caching** — `doc.name === doc.name`, namespace isolation
6. **Symbol-Keyed Hooks** — `CALL`, `INVALIDATE`, `TRANSACT`, `CHANGEFEED`
7. **Pure State Transitions** — `stepText`, `stepSequence`, `stepIncrement` without interpreter machinery
8. **Composing Custom Stacks** — read-only replicas, navigate + write without reading

## Symbol-Keyed Composability Hooks

| Symbol | Module | Purpose |
|---|---|---|
| `CALL` (`kyneta:call`) | `bottom.ts` | Controls what `carrier()` does — `withReadable` fills it |
| `INVALIDATE` (`kyneta:invalidate`) | `with-caching.ts` | Change-driven cache invalidation — prepare pipeline hook |
| `TRANSACT` (`kyneta:transact`) | `writable.ts` | Context discovery — refs carry a reference to their `WritableContext` |
| `CHANGEFEED` (`kyneta:changefeed`) | `with-changefeed.ts` | Observation coalgebra — `withChangefeed` attaches it |

## Key Insight

The `@kyneta/schema/basic` API (`createDoc`, `change`, `subscribe`, etc.) is
a thin layer over this composable toolkit. Everything it does, you can do
yourself — with full control over which layers to include, what context to
provide, and how the interpreter stack is wired.