# @kyneta/zset — Technical Reference

> **Package**: `@kyneta/zset`
> **Role**: The DBSP ℤ-set — a weighted set keyed by string identity, plus the pure algebra over it. The delta type every incremental stage in this family speaks.
> **Depends on**: *(none — zero runtime dependencies)*
> **Depended on by**: `@kyneta/datalog`, `@kyneta/perspective`
> **Canonical symbols**: `ZSet<T>`, `ZSetEntry<T>`, `zsetEmpty`, `zsetSingleton`, `zsetFromEntries`, `zsetAdd`, `zsetNegate`, `zsetIsEmpty`, `zsetSize`, `zsetGet`, `zsetHas`, `zsetPositive`, `zsetNegative`, `zsetForEach`, `zsetMap`, `zsetFilter`, `zsetElements`, `zsetKeys`
> **Key invariant(s)**: No entry ever has weight 0 — every operator prunes them, so `zsetIsEmpty(z) ⟺ z.size === 0`. The caller supplies keys; the algebra never derives one.

---

## Questions this document answers

- What exactly is a ℤ-set here, and why does the element ride with the weight? → [The type](#the-type)
- Why is it keyed by a string the caller supplies? → [Keys are the caller's obligation](#keys-are-the-callers-obligation)
- Is `zsetAdd` commutative? → [The group law holds on weights, not on elements](#the-group-law-holds-on-weights-not-on-elements)
- Is `zsetPositive` the DBSP `distinct` operator? → [`zsetPositive` is a filter](#zsetpositive-is-a-filter)
- How does this relate to `@kyneta/index`'s `ZSet`? → [The other ℤ-set](#the-other-set)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| ℤ-set | A function from keys to non-zero integers, with finite support. An abelian group under pointwise addition. | A multiset — a ℤ-set admits negative weights |
| Weight | The integer an entry carries. `+1` present, `−1` retracted, `n > 1` a multiplicity or refcount. | A count of *distinct* elements |
| Key | The string identity under which an entry is stored, supplied by the caller. | A hash — nothing here hashes anything |
| Element | The value riding alongside the weight. | The key — two different elements may not share a key |
| `distinct` | DBSP's clamp-to-1 operator. **This package does not implement it.** | `zsetPositive`, which filters and does not clamp |

## The type

Source: `src/zset.ts`.

```ts
interface ZSetEntry<T> {
  readonly element: T
  readonly weight: number
}

type ZSet<T> = ReadonlyMap<string, ZSetEntry<T>>
```

Bundling the element with its weight is a choice, not a necessity — the alternative is a weights-only map plus a side table of elements, which is what `@kyneta/index` does. Bundling wins here because in this family's hot paths the ℤ-set *is* the collection: `@kyneta/datalog`'s evaluator iterates a delta of facts and needs the key and the fact together on every entry. Splitting them would cost a second map lookup per fact in the loop that a long profiling effort brought down from 32 s to ~70 ms (`packages/datalog/TECHNICAL.md` → "Evaluator performance").

## Keys are the caller's obligation

`zsetAdd` and `zsetNegate` combine entries that already have keys. Nothing in this package derives one. That means the cancellation property — the reason to use ℤ-sets at all — holds only if **two semantically identical elements always produce the same key**.

Each consumer therefore has a blessed key function, and states it: `@kyneta/datalog` uses `factKey` (and `factsToZSet` as the blessed constructor); `@kyneta/perspective` uses `cnIdKey` for constraints, `slotId` for winners, and `fuguePairKey` for Fugue pairs.

## The group law holds on weights, not on elements

The weights form a genuine abelian group: commutative, associative, `zsetEmpty()` as identity, `zsetNegate` as inverse, and `zsetAdd(a, zsetNegate(a))` is empty.

The elements do not participate. When both operands carry the same key, `zsetAdd` keeps the element from its **second** argument, on the assumption that the second is the newer delta. That is a right-biased merge, and it means `zsetAdd(a, b)` and `zsetAdd(b, a)` are equal in every weight but may differ in an element.

This is a design decision, not a law, and code depends on it. `@kyneta/perspective`'s `kernel/incremental/evaluation.ts` combines a strategy-switch diff with the current step's fact delta using `zsetAdd`, and relies on the later value winning a collision. Anything that changes the merge rule has to audit that call site and its neighbours.

If the group law mattered more than the convenience, the fix would be the weights-only representation — which is exactly the shape `@kyneta/index` chose, and exactly the trade discussed below.

## `zsetPositive` is a filter

`zsetPositive` keeps entries whose weight is `> 0` and leaves those weights untouched. An entry at weight `3` comes back at weight `3`.

DBSP's `distinct` operator clamps positive weights to `1` and drops the rest. That is a different function, and this package does not provide it — a consumer that needs clamping writes it, as `@kyneta/datalog` does inside its evaluator (`applyDistinct`, over its dirty map).

The name is worth being careful about because `@kyneta/index` exports a function called `positive` that *does* clamp. Same word, opposite treatment of a weight above 1.

## The other ℤ-set

`@kyneta/index` (`packages/index/src/zset.ts`) has an independent implementation:

| | `@kyneta/zset` | `@kyneta/index` |
|---|---|---|
| Type | `ReadonlyMap<string, { element, weight }>` | `ReadonlyMap<string, number>` |
| Elements | bundled per entry | in a separate `values` map (`SourceEvent<V>`) |
| `positive` | filter (weights preserved) | `distinct` (clamp to 1) |
| Group law | weights only; elements right-biased | genuine abelian group |

Index's type is the weights-only projection of this one. Its choice suits its data: its keys index arbitrary keyed data — documents, rows within a document, anything a `Source` produces — where the element table is the larger structure and the delta over it is small. This package's choice suits an evaluator where the ℤ-set *is* the collection.

**Unifying them is deliberately not done.** They are not one type under two names; they are two representations picked for two data shapes, and merging them means either a second map lookup on the evaluator's hottest path or two types in one package that share a document but not code. Unification would also make a breaking change to a core-train package (`positive`) and force the question of which release train a tier-0 package rides. This section is the specification a future unification plan starts from; it is not a to-do.

## What a `ZSet` is NOT

- **Not a `Set`.** It has weights, and they can be negative.
- **Not a runtime class.** There is no `new ZSet()`. It is a `ReadonlyMap` alias with pure functions over it.
- **Not self-keying.** It never inspects an element to derive a key. See [Keys are the caller's obligation](#keys-are-the-callers-obligation).
- **Not a `distinct` implementation.** See above.

## Testing

`tests/zset.test.ts` asserts the group laws directly — identity, inverse, commutativity of weights, associativity — plus the no-zero-weight invariant at every constructor, and the re-keying behaviour of `zsetMap` including entries that cancel after a collision.

## See also

- DBSP: Budiu, McSherry, Ryzhyk, Tannen, *DBSP: Automatic Incremental View Maintenance for Rich Query Languages* (VLDB 2023).
- `packages/perspective/theory/incremental.md` §1 (ℤ-sets over constraints) and §4.1 (this type's role in the incremental pipeline).
- `packages/perspective/.plans/005-incremental-kernel-pipeline.md` § Z-Set Key Conventions — the canonical key function per element type.
