# Learnings: @kyneta/zset

## Our ℤ-set is a group on weights only

`zsetAdd`'s doc comment says "Commutative: `add(a, b)` has the same **weights** as `add(b, a)`". The emphasis is load-bearing and easy to read past.

When both operands carry the same key, the element from the second argument wins. So the weights form a genuine abelian group, and the elements ride along under a right-biased merge that has no algebraic justification — it is a guess that the second argument is the newer delta, and in this codebase's call sites it is.

This was found while comparing this package against `@kyneta/index`'s ℤ-set for a possible unification. Index's is weights-only, so it *is* a genuine abelian group with nothing bolted on. Ours is the one with a hidden last-writer-wins in it.

**Why it matters:** anyone reasoning about `zsetAdd` algebraically — proving a pipeline stage commutes, say — is entitled to assume commutativity and will be right about the weights and wrong about the elements. `@kyneta/perspective`'s `kernel/incremental/evaluation.ts` depends on the bias when it combines a strategy-switch diff with a fact delta.

**Why it has not been fixed:** removing the bias means the weights-only representation, which costs a second map lookup per fact in `@kyneta/datalog`'s hottest loop — the one a long profiling effort took from 32 s to ~70 ms. The trade is real and the current choice is defensible. It just needs to be written down rather than discovered.

## The same word means opposite things in two packages

`zsetPositive` here filters: entries with weight `> 0` survive with their weights intact. `positive` in `@kyneta/index` is DBSP `distinct`: positive weights are clamped to `1`.

Both are correct for their package. Neither name says which one it is. The convention adopted at the split is that **`distinct` is reserved for the clamp** and must not be used for anything else in this package — so that if the two ever converge, the vocabulary is already unambiguous.
