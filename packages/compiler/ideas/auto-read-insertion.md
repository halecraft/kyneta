# Auto-Read Insertion and the Ref/Value Boundary

> The compiler should manage the boundary between the reactive world and the
> value world. The developer stays in the reactive world; the compiler inserts
> reads where values are needed.

## 1. The Problem

Kyneta's reactive system is built on the CHANGEFEED protocol — a coalgebraic
interface where `ref[CHANGEFEED].current` reads the current state and
`ref[CHANGEFEED].subscribe(cb)` observes changes. Any value with `[CHANGEFEED]`
is reactive. Any value without it is inert.

The developer works with refs: schema-interpreted `Ref<S>` handles and
`LocalRef<T>` values from `state()`. Both are callable — `ref()` extracts
the current value, collapsing the stream to a single frame.

The problem is that **calling a ref destroys the reactive signal**:

    recipe.name          → TextRef           (has [CHANGEFEED])
    recipe.name()        → string            (no [CHANGEFEED])

Once the developer calls `()`, the result is a plain JavaScript value. The
compiler can no longer trace it back to a reactive source through the type
system. Reactivity becomes invisible.

This creates a cascade of failures. The developer writes:

    const nameMatch = recipe.name().toLowerCase().includes(
      filterText().toLowerCase()
    )

Both `recipe.name()` and `filterText()` are called. The result is a plain
`boolean`. The compiler, through a heuristic tree-walk (`expressionIsReactive`),
detects that reactive values were *involved* in the expression. But the
information about *which* refs were read, and *how* to re-evaluate the
expression, is lost in the emitted code. The `const` binding freezes the
boolean at its creation-time value. Reactive closures that reference
`nameMatch` read a stale snapshot forever.

## 2. Two Worlds

The system has two worlds with a hard boundary between them:

**The Ref World.** Values have `[CHANGEFEED]`. They are observable,
subscribable, and carry structured delta information. The compiler can reason
precisely about them: what kind of changes they emit, what to subscribe to,
how to incrementally maintain derived views. The ref world is the domain of
the CHANGEFEED coalgebra.

**The Value World.** Plain JavaScript values — `string`, `number`, `boolean`,
arrays, objects. No `[CHANGEFEED]`. No observation protocol. Once you're here,
you're working with snapshots. The value world is the domain of ordinary
computation.

The `()` call operator is the **observation morphism** — it crosses from the
ref world to the value world. It extracts `ref[CHANGEFEED].current`. This
crossing is irreversible: you cannot reconstruct a ref from a value.

Today, the developer is forced to cross this boundary manually and early.
They call `()` to get a string so they can call `.toLowerCase()`. They call
`()` to get a boolean so they can use `!` and `||`. Every method call, every
operator, every intermediate computation requires leaving the ref world first.

The compiler then works backwards, using heuristics to reconstruct the
reactive provenance that was lost at each `()` call. This reconstruction
is fragile, imprecise, and incomplete.

## 3. The Insight

The developer doesn't *want* to leave the ref world. They call `()` because
TypeScript requires it — `TextRef` doesn't have `.toLowerCase()`, so they
must extract the `string` first. The `()` calls are a tax imposed by the
type system, not an expression of intent.

If the type system allowed `recipe.name.toLowerCase()` directly — if refs
exposed the methods of their underlying value type — the developer would
never need to call `()` in the common case. They would stay in the ref world
naturally, and the compiler would know exactly which refs are involved in
every expression.

The key realization: **the compiler should manage the ref/value boundary, not
the developer.** The developer writes expressions over refs. The compiler
determines where reads are needed and inserts them in the emitted code.

## 4. The Design

### 4.1. Refs Expose Value-Type Methods

Through type widening, ref types gain the methods of their underlying value
type:

- A `TextRef` (wrapping `string`) gains `String` methods: `.toLowerCase()`,
  `.includes()`, `.slice()`, `.trim()`, etc.
- A `CounterRef` (wrapping `number`) gains `Number` methods: `.toFixed()`,
  `.toString()`, etc.
- A `LocalRef<T>` gains `T`'s methods for any `T`.

This is a type-level-only change. At runtime, the ref object is unchanged —
it doesn't actually have these methods. But the compiler transforms the code
before it runs, so the runtime type mismatch is invisible to the developer.

For schema refs (`TextRef`, `CounterRef`), the widening uses TypeScript
**module augmentation** — declared in `@kyneta/core`, not in `@kyneta/schema`.
The schema package is unaware of and unaffected by this. The augmentation is
opt-in via a `/// <reference>` directive, following the same pattern as the
existing element factory types.

For `LocalRef<T>`, the widening uses TypeScript **intersection types**:
`LocalRef<T>` becomes `T & { (): T, set(value: T): void, [CHANGEFEED], ... }`.
The `T &` prefix gives the type all of `T`'s methods.

### 4.2. The Compiler Inserts Reads

When the compiler encounters a changefeed-typed sub-expression in a value
context — as the receiver of a value-type method, as an operand in an
arithmetic or logical expression, as an argument to a function expecting a
plain type — it inserts the `()` call in the emitted code.

The developer writes:

    recipe.name.toLowerCase().includes(filterText.toLowerCase())

The compiler emits:

    recipe.name().toLowerCase().includes(filterText().toLowerCase())

The developer writes `recipe.name` (ref world). The compiler emits
`recipe.name()` (value world, with the read). The developer never explicitly
crosses the boundary; the compiler does it for them.

### 4.3. Explicit `()` Is the Snapshot Opt-Out

If the developer *does* write `recipe.name()` with an explicit call, the
result is a plain `string`. The compiler recognizes this as an intentional
snapshot — the developer deliberately crossed the boundary. No auto-read
insertion. No reactive tracking on the result.

This means the `()` call operator serves double duty:

- **Without `()`:** the expression stays in the ref world. The compiler
  manages the reads and tracks the reactive dependencies.
- **With `()`:** the developer explicitly leaves the ref world. The result
  is a snapshot — a frozen value at the point of evaluation.

No new syntax. No new keywords. No new functions. The distinction between
"reactive" and "snapshot" is expressed through the presence or absence of
`()`, which is already the established convention for reading refs.

### 4.4. The Compiler Tracks Changefeed Sources

Because the compiler inserts the reads, it knows exactly which refs were read
in every expression. This replaces the heuristic `expressionIsReactive` with
a structural analysis:

- Walk the expression AST.
- At each sub-expression, check `isChangefeedType(type)`.
- If a changefeed appears in value context, record it as a **dependency**
  and insert the `()` read in the emitted source.
- If a changefeed appears as an explicit `()` call in the developer's source,
  the result is not a changefeed — it's a snapshot. No dependency.

The result: precise subscription targets and self-contained re-evaluation
expressions, derived from the type system rather than from heuristic pattern
matching.

### 4.5. Bindings Are Derivations by Default

When the developer writes:

    const nameMatch = recipe.name.toLowerCase().includes(filterText.toLowerCase())

The compiler analyzes the right-hand side, discovers changefeed sources
(`recipe.name`, `filterText`), and records that `nameMatch` is a **derived
reactive binding** — its value depends on those sources.

The `const` declaration is emitted normally for the initial render (a
snapshot at creation time). But when `nameMatch` appears inside a reactive
closure — a `conditionalRegion`'s condition, a `valueRegion`'s getter — the
compiler does not reference the `const nameMatch` binding. Instead, it
**inlines the source expression** with its auto-inserted reads:

    recipe.name().toLowerCase().includes(filterText().toLowerCase())

The binding exists for readability and for the initial render. The reactive
closure is self-contained — it re-reads from the live refs every time it is
invoked by a subscription callback.

## 5. The Theory

### 5.1. Observation Morphism

In coalgebra theory, an observation morphism `obs: F-coalgebra → Value`
extracts the current state. The `()` call on a ref is this morphism:
`obs(ref) = ref[CHANGEFEED].current`.

Auto-read insertion means the **compiler** applies the observation morphism,
not the developer. The developer works with the coalgebra directly; the
compiler inserts observations where the surrounding context requires a value.

This is analogous to how a lazy language inserts `force` at demand points —
the programmer works with thunks, and the evaluator forces them when values
are needed. Here, the programmer works with refs, and the compiler forces
(reads) them when values are needed.

### 5.2. Lifting

In DBSP, lifting (`↑Q`) takes a pure function `Q: A → B` and produces a
stream operator `↑Q: Stream[A] → Stream[B]` by applying `Q` pointwise.

Auto-read insertion is the mechanism by which the compiler **lifts** the
developer's expression. The developer writes:

    recipe.name.toLowerCase().includes(filterText.toLowerCase())

This is `Q(a, b) = a.toLowerCase().includes(b.toLowerCase())` where `a` and
`b` are values. The compiler lifts it to `↑Q(stream_a, stream_b)` — a
derived stream that re-evaluates `Q` whenever `a` or `b` change.

The lifting is implicit. The developer writes `Q` over what look like values
(because the types are widened). The compiler produces `↑Q` by tracking the
changefeed sources and emitting re-evaluation closures.

### 5.3. Why `expressionIsReactive` Is Unsound

The existing `expressionIsReactive` function answers a boolean question:
"does this expression transitively touch a changefeed?" It walks the AST,
checking sub-expressions, arguments, callees, and properties.

This is a **reachability** analysis — can we reach a changefeed type from any
sub-expression? Reachability is necessary but not sufficient. The compiler
needs:

1. **Which** changefeeds are involved (for subscriptions).
2. **How** to re-evaluate the expression (for closure bodies).
3. **Whether** the developer intended reactive tracking or a snapshot.

`expressionIsReactive` answers none of these. It produces a boolean that says
"something reactive is in here," but doesn't say what, where, or how.
Downstream code then uses `extractDependencies` (a separate tree walk) to
partially recover the "which" information, and uses the raw source text for
"how" — but the raw source text references `const` bindings that snapshot
the values, so re-evaluation reads stale data.

Auto-read insertion replaces this with a single unified analysis that answers
all three questions in one pass, grounded in the type system rather than in
heuristic AST pattern matching.

### 5.4. Ref Methods vs. Value Methods

A ref has two kinds of methods:

- **Ref methods:** defined on the ref's own interface. `TextRef.insert()`,
  `LocalRef.set()`, `ListRef.push()`. These mutate the ref or interact with
  the reactive protocol.
- **Value methods:** inherited from the value type via augmentation.
  `String.toLowerCase()`, `Number.toFixed()`, `Array.map()`. These operate
  on the ref's current value.

When the compiler sees a method call on a ref, it must distinguish these.
The rule: if the method is defined on the ref's own interface (the changefeed
type itself), it's a ref method — do not insert a read. If the method comes
from the value type augmentation, it's a value method — insert a read on the
receiver.

This distinction is checkable at the type level. The compiler can inspect
whether a property is declared on the `HasChangefeed` / `TextRef` /
`LocalRef` interface vs. on the `String` / `Number` / `Boolean` interface.

## 6. Ergonomics

### 6.1. What the Developer Writes

Before (current style):

    const filterText = state("")
    const veggieOnly = state(false)

    for (const recipe of doc.recipes) {
      const nameMatch = recipe.name().toLowerCase().includes(
        filterText().toLowerCase()
      )
      const veggieMatch = !veggieOnly() || recipe.vegetarian()

      if (nameMatch && veggieMatch) {
        RecipeCard({ recipe })
      }
    }

After (auto-read style):

    const filterText = state("")
    const veggieOnly = state(false)

    for (const recipe of doc.recipes) {
      const nameMatch = recipe.name.toLowerCase().includes(
        filterText.toLowerCase()
      )
      const veggieMatch = !veggieOnly || recipe.vegetarian

      if (nameMatch && veggieMatch) {
        RecipeCard({ recipe })
      }
    }

The difference: no `()` calls. The code reads like plain JavaScript
operating on plain values. The developer doesn't need to think about
refs, observation morphisms, or reactive tracking. They write natural
expressions, and the compiler ensures everything stays reactive.

### 6.2. When the Developer Wants a Snapshot

    for (const item of doc.items) {
      const initialPrice = item.price()  // explicit () = snapshot

      span(`Changed by: ${item.price - initialPrice}`)
    }

Here, `initialPrice` uses `()` — it's a snapshot, frozen at render time.
`item.price` (without `()`) in the template literal is reactive — it will
update when the price changes. The developer controls the boundary with
a single character.

### 6.3. Mutations Are Unaffected

    button({
      onClick: () => {
        recipe.name.insert(0, "★ ")     // ref method — no auto-read
        recipe.vegetarian.set(true)      // ref method — no auto-read
        doc.favorites.increment(1)       // ref method — no auto-read
      }
    }, "Star")

The compiler distinguishes ref methods from value methods. Mutation calls
pass through unchanged.

### 6.4. Component Props

    Toolbar({ doc, filterText, veggieOnly })

Passing refs as props is unchanged. The ref itself is passed (not read).
The receiving component accesses the ref's fields, and the same auto-read
rules apply inside that component's builder body.

## 7. Relationship to Other Systems

**Solid.js** uses `createSignal()` + `createMemo()` with explicit accessor
functions. The developer calls `count()` to read. Solid's compiler tracks
signal reads inside `createEffect` and JSX expressions via runtime dynamic
tracking (an execution context that intercepts reads). Kyneta's approach is
similar in spirit but uses compile-time type analysis instead of runtime
tracking, and makes the read implicit rather than explicit.

**Svelte 5** uses `$state()` and `$derived()` runes. The compiler rewrites
`$state` declarations into reactive proxy objects. Reads and writes look
like plain variable access. This is close to Kyneta's auto-read approach,
but Svelte's mechanism is a source-level transformation of specific rune
calls, while Kyneta's is a type-directed transformation of any expression
involving `[CHANGEFEED]` types.

**Vue 3** uses `ref()` and `computed()` with `.value` access. The developer
writes `count.value` to read. The template compiler auto-unwraps refs. This
is a two-world system like Kyneta's, but the boundary crossing (`.value`) is
explicit in script and implicit in templates. Kyneta unifies both contexts —
the compiler handles the boundary everywhere.

**DBSP / Feldera** operates at the query level — full SQL or dataflow
programs over streams. The programmer writes queries over relations; the
system incrementalizes the entire query. Kyneta operates at the expression
level within a host language (TypeScript), incrementalizing individual
expressions within a larger program. The auto-read insertion is Kyneta's
mechanism for lifting host-language expressions into the incremental stream
world.

## 8. Open Questions

**Generic `ScalarRef<T>`.** Schema's `ScalarRef<T>` is generic — a
`Schema.boolean()` becomes `ScalarRef<boolean>`. TypeScript module
augmentation cannot conditionally add `extends Boolean` only when `T` is
`boolean`. Options include: relying on the compiler to handle the auto-read
without type-level widening for scalars; introducing named scalar ref types
(`BooleanRef`, `NumberRef`) in the augmentation layer; or accepting that
JavaScript operators (`!`, `&&`, `||`) already coerce any value and don't
strictly require the boolean methods.

**Side effects in expressions.** Auto-read insertion re-evaluates the
full expression on every subscription callback. If the expression has side
effects (logging, network calls), they would be duplicated. Builder bodies
are expected to be pure (side effects belong in event handlers), but this
assumption should be documented and possibly enforced.

**Chained bindings.** If `const a = reactive_expr` and `const b = a + 1`
and `const c = b > 0`, expanding `c` in a closure requires transitively
expanding `b` and then `a`. The expansion must be recursive and must
terminate (no circular bindings, which `const` guarantees). The binding
scope already tracks these chains for dependency analysis; the same
structure supports transitive source expansion.

**Performance of re-evaluation.** Inlining full expressions into closures
means re-evaluating the entire expression on any dependency change, even
if only one sub-expression's source changed. This is the "re-read"
strategy — correct but not always optimal. Future work could introduce
fine-grained memoization (caching intermediate results and invalidating
selectively), but the re-read strategy is a sound starting point that
matches `valueRegion`'s existing semantics.