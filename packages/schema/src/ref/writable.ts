// writable — the types of a ref's writes: the mutation surface of each kind.
//
// Types only. The write members themselves live on each ref's prototype
// (`write.ts`), and `SchemaRef` (`schema-ref.ts`) puts these surfaces
// together with the read surfaces into a ref's type.

// ---------------------------------------------------------------------------
// Ref types — mutation-only interfaces
// ---------------------------------------------------------------------------
// These describe only the mutation surface. Reading is `Readable<S>`
// (`readable.ts`); `SchemaRef<S, N>` intersects the two.

// Every member declares its `this`: it lives on a prototype shared by every
// ref of its schema node, and reads the ref's state through `this`. So
// calling a member taken off its ref is a type error; passing one as a
// callback is caught when it runs.

export interface ScalarRef<T = unknown> {
  set(this: ScalarRef<T>, value: T): void
}

export interface TextRef {
  insert(this: TextRef, index: number, content: string): void
  delete(this: TextRef, index: number, length: number): void
  update(this: TextRef, content: string): void
}

export interface RichTextRef {
  insert(
    this: RichTextRef,
    index: number,
    content: string,
    marks?: Record<string, unknown>,
  ): void
  delete(this: RichTextRef, index: number, length: number): void
  update(this: RichTextRef, content: string): void
  mark(
    this: RichTextRef,
    start: number,
    end: number,
    key: string,
    value: unknown,
  ): void
  unmark(this: RichTextRef, start: number, end: number, key: string): void
}

export interface CounterRef {
  increment(this: CounterRef, n?: number): void
  decrement(this: CounterRef, n?: number): void
}

/**
 * Mutation-only interface for sequence refs.
 *
 * Navigation (`.at()`, `.length`, `[Symbol.iterator]`) lives in
 * `NavigableSequenceRef`. Reading (call
 * signature, `.get()`) lives in `ReadableSequenceRef`. This interface
 * provides only mutation: `.push()`, `.insert()`, `.delete()`.
 *
 * No type parameter — mutation methods take plain values (`unknown`),
 * not child refs. The unified `Ref<S>` type intersects this with
 * `ReadableSequenceRef<Ref<I>, Plain<I>>` to get the full surface.
 */
export interface SequenceRef {
  push(this: SequenceRef, ...items: unknown[]): void
  insert(this: SequenceRef, index: number, ...items: unknown[]): void
  delete(this: SequenceRef, index: number, count?: number): void
}

/**
 * Mutation-only interface for product refs.
 * Enables atomic replacement of an entire struct subtree in one change.
 */
export interface ProductRef<T = unknown> {
  set(this: ProductRef<T>, value: T): void
}

/**
 * Mutation-only interface for map refs. Reading is `ReadableMapRef`.
 */
export interface WritableMapRef<V = unknown> {
  set(this: WritableMapRef<V>, key: string, value: V): void
  delete(this: WritableMapRef<V>, key: string): void
  clear(this: WritableMapRef<V>): void
}

/**
 * Mutation-only interface for set refs.
 *
 * Sets are value-addressed — there is no `set(key, value)`. `add` is
 * idempotent (no-op for an existing member, by content equality).
 * `delete` returns the membership-before-delete (matches native
 * `Set.prototype.delete` semantics).
 *
 * Reading is `ReadableSetRef`.
 */
export interface WritableSetRef<V = unknown> {
  add(this: WritableSetRef<V>, value: V): void
  delete(this: WritableSetRef<V>, value: V): boolean
  clear(this: WritableSetRef<V>): void
}

/**
 * Mutation-only interface for tree refs.
 *
 * `.create({ parent, index, data })` allocates a new node id via the
 * substrate's `[TREE_NODE_ALLOCATE]` hook, returns the id synchronously,
 * and dispatches a `TreeInstruction.create`. Optional initial `data` is
 * dispatched as a write at the node's path.
 *
 * `.delete(id)` enumerates the subtree via `subtreeIds` and records one
 * `TreeInstruction.delete` per descendant in a single `TreeChange`.
 *
 * `.move(id, opts)` records a `TreeInstruction.move`. Concurrent-move
 * correctness is the substrate's responsibility (Loro implements
 * Kleppmann-style `tree-move`).
 *
 * Reading is `ReadableTreeRef`.
 */
export interface WritableTreeRef<V = unknown> {
  create(
    this: WritableTreeRef<V>,
    opts?: {
      parent?: string | null
      index?: number
      data?: Partial<V>
    },
  ): string
  delete(this: WritableTreeRef<V>, id: string): void
  move(
    this: WritableTreeRef<V>,
    id: string,
    opts: { parent: string | null; index: number },
  ): void
}
