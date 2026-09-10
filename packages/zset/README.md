# @kyneta/zset

The DBSP ℤ-set — a weighted set keyed by string identity, and the algebra over it.

## Overview

A **ℤ-set** maps elements to integer weights. Weight `+1` means present, `−1` means retracted, and `0` is not stored at all. Adding two ℤ-sets adds their weights pointwise, so a `+1` and a `−1` for the same key cancel and disappear.

That one property is why incremental systems reach for it: a change is a ℤ-set, two consecutive changes compose by addition, and "inserted then removed" needs no special case — it sums to nothing.

```ts
import { zsetAdd, zsetFromEntries, zsetSingleton, zsetElements } from "@kyneta/zset"

const inserted = zsetSingleton("alice", { name: "Alice" })
const retracted = zsetSingleton("bob", { name: "Bob" }, -1)

const delta = zsetAdd(inserted, retracted)
zsetElements(delta) // [{ name: "Alice" }, { name: "Bob" }] — weights say which is which
```

This package is the type and the operators. It has no dependencies and no runtime beyond pure functions over a `ReadonlyMap`.

## Install

```sh
pnpm add @kyneta/zset
```

## The type

```ts
interface ZSetEntry<T> {
  readonly element: T
  readonly weight: number
}

type ZSet<T> = ReadonlyMap<string, ZSetEntry<T>>
```

The element rides alongside its weight, under a key **you** supply. The algebra never derives a key — it only combines entries that already have them. Correctness therefore rests on one caller obligation: **two semantically identical elements must always produce the same key**, or a `+1` and a `−1` will not cancel.

**Invariant:** no entry ever has weight `0`. Every operator prunes them, which is what makes `zsetIsEmpty(z)` the same question as `z.size === 0`.

## API

| Function | Meaning |
|---|---|
| `zsetEmpty()` | The empty ℤ-set. A shared singleton — safe, because it is readonly. |
| `zsetSingleton(key, element, weight = 1)` | One entry. Weight `0` gives the empty ℤ-set. |
| `zsetFromEntries(entries)` | Build from `[key, {element, weight}]` pairs, summing duplicate keys and pruning zeros. |
| `zsetAdd(a, b)` | Pointwise sum. See the note below on which element survives a collision. |
| `zsetNegate(a)` | Flip every weight. `zsetAdd(a, zsetNegate(a))` is empty. |
| `zsetIsEmpty(z)` / `zsetSize(z)` | Emptiness and entry count. |
| `zsetGet(z, key)` / `zsetHas(z, key)` | Entry lookup. |
| `zsetPositive(z)` / `zsetNegative(z)` | **Filters.** Keep entries with weight `> 0` (or `< 0`), weights untouched. |
| `zsetForEach(z, fn)` | Iterate entries with their keys. |
| `zsetMap(z, keyFn, mapFn)` | Transform elements and re-key. Entries that collide are summed and may cancel. |
| `zsetFilter(z, pred)` | Keep entries matching a predicate. |
| `zsetElements(z)` / `zsetKeys(z)` | Elements or keys as arrays. |

## Two things that surprise people

**`zsetPositive` is a filter, not DBSP's `distinct`.** It keeps the entries whose weight is above zero and leaves those weights alone — an entry at weight `3` stays at `3`. DBSP's `distinct` clamps to `1`. If you want clamping, write it; this package deliberately does not use the name `distinct` for anything else.

**`zsetAdd` is a group on weights only.** Weights are commutative, associative, have an identity and an inverse — a genuine abelian group. The *elements* are not: when both operands carry the same key, the element from the **second** argument wins. That is a deliberate choice, on the assumption that the second argument is the newer delta, and it is not an algebraic law. Code that relies on it should say so.

## Related

`@kyneta/index` has its own ℤ-set, `ReadonlyMap<string, number>` — the weights-only projection of this one, keeping elements in a separate table. Its `positive` means `distinct`. The two are deliberately not unified; see this package's `TECHNICAL.md`.

## License

MIT
