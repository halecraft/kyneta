// @kyneta/zset — the DBSP ℤ-set type and its algebra.
//
// One module, re-exported whole. The type and its operators are inseparable:
// the no-zero-weight invariant every operator preserves is what makes
// `zsetIsEmpty` equivalent to `size === 0`, and that is relied on throughout.

export type { ZSet, ZSetEntry } from "./zset.js"
export {
  zsetAdd,
  zsetElements,
  zsetEmpty,
  zsetFilter,
  zsetForEach,
  zsetFromEntries,
  zsetGet,
  zsetHas,
  zsetIsEmpty,
  zsetKeys,
  zsetMap,
  zsetNegate,
  zsetNegative,
  zsetPositive,
  zsetSingleton,
  zsetSize,
} from "./zset.js"
