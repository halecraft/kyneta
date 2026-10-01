# The Schema Algebra

> A schema is a functor. A fold over it is an algebra. A ref is staged per
> schema node, not folded. A change is a value that moves a state.

This document describes the algebra `@kyneta/schema` is built on, as it
stands. `TECHNICAL.md` maps it to the source; this document says why the
pieces have the shape they do.

---

## 1. One schema, many walks

A document's schema is walked many ways, and each walk wants something
different at every node:

| Walk | What it builds at a node | Where |
|---|---|---|
| materialize | the plain value, from a backend's state | `interpreters/materialize.ts` |
| zero | the value before any write | `interpreters/zero.ts` |
| validate | the value checked against the schema, or the errors | `interpreters/validate.ts` |
| complete | a partial value, its absent parts filled with zeros | `complete.ts` |
| path walk | the schema and storage key at each segment of a path | `fold-path.ts` |
| describe | an ASCII picture of the schema | `describe.ts` |
| refs | a typed, navigable, writable, observable pointer | `ref/*` |
| delivery | which subscribers a change reaches | `delivery.ts` |

The first three are folds: they share one walker, `interpret`, and differ
only in what they do at each node (§3). The rest walk the schema their own
way, because they want something a fold cannot give: `complete` rebuilds only
the nodes that change, the path walk follows one path rather than the whole
tree, `describe` prints, refs are built one node at a time as a program
navigates (§4), and delivery walks a change's path, not the schema.

---

## 2. Schema as syntax

A schema is a value of a recursive grammar, the fixed point of a functor
with eleven node kinds (`[KIND]`, `schema.ts`):

```
SchemaF<A> =
  -- structural: how a document composes
  | Scalar<T>                     -- a plain value: string, number, boolean, null, undefined, bytes, any
  | Product<{ k₁: A, … }>         -- fixed fields (Schema.struct)
  | Sequence<A>                   -- an ordered list (Schema.list)
  | Map<A>                        -- string keys to A (Schema.record)
  | Sum<A, …>                     -- one of several variants (union, discriminatedUnion, nullable)
  -- first-class CRDT types: each has merge semantics of its own
  | Text | Counter | RichText
  | Set<A> | Tree<A> | Movable<A>
```

A schema carries **no runtime behaviour and no defaults**. It is syntax: a
description of structure, which the walks in §1 give meaning to.

**The kinds are closed.** Users compose schemas; they never add a `[KIND]`.
A new kind needs a case in every walk and support in every substrate, and the
closed set is what lets each walk be total.

**Composition laws are phantom.** Each kind carries the merge laws it
needs (`"lww"`, `"additive"`, `"positional-ot"`, …) under a `[LAWS]` brand
that exists only in the type. `bind(schema)` checks at compile time that a
substrate supports every law the schema uses, so a schema with a counter
cannot be bound to a substrate without additive merges. Nothing dispatches
on a law at runtime.

---

## 3. Folds

An **F-algebra** collapses one layer of structure into a result. An
`Interpreter<Ctx, A>` (`interpret.ts`) is one: a case per kind, each
receiving its node's context, path and schema, and its children:

```ts
interface Interpreter<Ctx, A> {
  scalar(ctx: Ctx, path: Path, schema: ScalarSchema): A
  product(ctx: Ctx, path: Path, schema: ProductSchema, fields: Record<string, () => A>): A
  sequence(ctx: Ctx, path: Path, schema: SequenceSchema, item: (i: number) => A): A
  map(ctx: Ctx, path: Path, schema: MapSchema, item: (k: string) => A): A
  sum(ctx: Ctx, path: Path, schema: SumSchema, variants: SumVariants<A>): A
  // … text, counter, richtext, set, tree, movable
}
```

`interpret(schema, interpreter, ctx, path?)` is the catamorphism: it applies
the interpreter at every node.

**Children are thunks.** A product's fields are `() => A`, and a sequence's
or map's items are `(i) => A` and `(k) => A`. So the fold is lazy: each case
decides which children to force, and when. A sum's case receives its
variants the same way and picks one (`dispatchSum`, the one rule for which
variant a value holds).

**The algebras.** Materializing, zeroing and validating are each an
interpreter:

- **materialize** reads a backend through a `MaterializeResolver` (leaf
  values, container lengths and keys, a tree's topology) and builds the plain
  value. Every backend shares the interpreter; each supplies only a resolver.
- **zero** builds the value before any write: each kind's structural zero.
- **validate** checks a value against the schema and collects every error.

`createInterpreter(fallback, cases)` builds one from a default and the cases
that differ.

**Decorating a fold.** `withDecay(interpreter, …)` is an interpreter over an
interpreter: a node whose schema declares `.decay()` reads as its zero once
it has gone long enough without a write, and its subtree is never walked.
It needs the schema at every node, which the fold already has; a resolver
sees only a path.

---

## 4. Refs are not a fold

A ref is a typed pointer to one place in a document: `doc.rows.at("k").title`.
Calling it reads (`ref()`), and it has the navigation, writes and
observation of its kind.

Refs were once built by a fold: a stack of interpreter layers (navigation,
reading, addressing, caching, writing, observation), each adding its members
to every node. Only one composition of the layers was ever used, and the
stack cost thousands of bytes per ref, so it was replaced
(`PLAN-2026-10-01-refs-share-their-behaviour`).

**Staging.** Everything about a ref that depends only on its schema node is
computed once per schema node and position, into a *template*
(`ref/prototype.ts`): a prototype holding every member of the kind, a
function to bind, and the ref's own properties (a product's fields, a
list's `length`). This is partial evaluation: the schema is the static
input, the document the dynamic one. Each place a program navigates to then
costs one bound function and one small state record: its context, its path,
its parent, and a few slots filled on first use (`ref/state.ts`).

**Navigation is a coalgebra.** Where a fold collapses a tree, navigation
unfolds it one step at a time: from a ref to its children (`ref.title`,
`list.at(i)`), each made only when a program asks for it. A list item's or
record entry's ref is the one its coordinate holds while something holds it,
so asking twice gives the same ref.

---

## 5. Changes

A change is a value describing a write: a text edit, a list splice, map
sets and deletes, a counter increment, a replace (`change.ts`). One
vocabulary flows both ways: inbound, a ref's write builds a change and
dispatches it; outbound, subscribers receive the changes that happened,
whoever wrote them. An op is a change with the path it was made at.

**Step.** `step(state, change)` (`step.ts`) is the pure transition: the
state after the change, the old state untouched. `stepInPlace` is its
mutating dual, over the same per-kind cores, for the store, which copies a
frozen node before changing it so every read stays valid.

**Inverses.** `invert(pre, change)` (`inverse.ts`) is the change that undoes
`change` from the state `pre` it was applied to. Every authored op is paired
with its inverse when it is applied. An aborted batch applies them last
first, so each meets the state just after its own op. Undo reverts a step's
parts last first too, rebased past what others wrote since
(`revert-step.ts`).

**Zeros are not in the schema.** A schema has no defaults. `Zero` derives
each kind's structural zero, and `completeValue` fills a partial value's
absent parts with zeros before it is stored, so every reader and every peer
sees the same value (`complete.ts`). Initial content is a write, never a
seed: a seed would be state the sync protocol cannot see.

---

## 6. Changefeeds

A changefeed is a Moore machine: a current value, and a stream of changesets
that move it. One symbol, `[CHANGEFEED]`, carries the protocol on anything
observable (`@kyneta/changefeed`): `current`, and `subscribe(callback)`.
Every ref has one, and a schema's adds `subscribeDescendants`: one changeset
per batch for everything at or below the ref.

**Delivery walks a change, not the schema.** A change at a path concerns the
subscribers on that path's ancestors, and those inside the part of the tree
the change rewrote. Delivery walks up the first and down the second, in the
order the ops were written, and gives each subscriber one changeset per
batch (`delivery.ts`). No composite subscribes to its children.

**A flag is a feed.** `populated(ref)` and `deleted(ref)` are booleans a ref
holds under a symbol; `populatedFeed(ref)` and `deletedFeed(ref)` return
the same boolean as a `Feed<boolean>`: a function that reads it and carries
its own `[CHANGEFEED]`, so it can be subscribed to or passed to a reactive
hook.

---

## 7. Namespace isolation

A ref exposes its schema's fields as properties, so a field may be named
anything: `populated`, `deleted`, `set`. Everything the framework attaches is
keyed by a symbol (`[CALL]`, `[CHANGEFEED]`, `[TRANSACT]`, `[DELETED]`,
`[POPULATED]`, `[NATIVE]`), and read through free functions (`populated(ref)`,
`batch(ref, fn)`, `subscribe(ref, cb)`, `unwrap(ref)`) rather than methods.
`Object.keys(ref)` lists a struct's fields and nothing else.

---

## 8. Types

The type of a schema's value and of its refs are computed from the schema
the way the walks compute their results, by recursion over its kinds:

- **`Plain<S>`** (`plain-types.ts`) is the type of the value: what `ref()`
  returns, readonly.
- **`Ref<S>`** (`ref/schema-ref.ts`) is the type of a ref, its children
  `Ref` again, with each substrate's native container types threaded through
  (`[NATIVE]`).
- **`RRef<S>`** is a ref's read surface alone, for code that only reads.

The composition laws (§2) are a phantom in the same types, which is how
`bind` checks them without running anything.
