// @kyneta/reactive — fine-grained reactive computations over the changefeed.
//
// Tree/point auto-tracked reactivity: `reactive(thunk)` captures exactly the
// nodes the thunk reads (via @kyneta/schema's read tracking) and re-runs when
// they change, coalescing bursts on a microtask. The relational/set sibling is
// @kyneta/index (ℤ-set IVM); a reactive thunk can read an index Collection
// since both are HasChangefeed.

export type { DepDiff } from "./diff.js"
export { diffDeps } from "./diff.js"
export type { Reactive } from "./reactive.js"
export { computed, reactive, track } from "./reactive.js"
