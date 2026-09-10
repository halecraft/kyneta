// === A worked example of a foreign relation ===
//
// `dist(X, Y, D)`: the number of steps from the nearest origin, over `adj`,
// never entering a `blocked` tile. The kind of relation a game engine
// measures outside Datalog: a breadth-first search is not a rule.
//
// Shared by the differential sweep in `evaluator.test.ts` and the bench in
// `roguelike-bench.test.ts`, and written the way a host function should be:
// it reads adjacency through `Relation.candidates` with a probe, an indexed
// lookup, not a scan of the whole relation per tile.
//
// Not a test file: vitest only collects `*.test.ts`.

import type {
  FactTuple,
  ForeignRelation,
  Probe,
  Value,
} from "../../src/index.js"
import { serializeTuple, valuesEqual } from "../../src/index.js"

/** Positions of `adj(X1, Y1, X2, Y2)` known when probing from a tile. */
const FROM_TILE = 0b0011

export const DISTANCE_FIELD: ForeignRelation = {
  predicate: "dist",
  inputs: ["origin", "adj", "blocked"],
  version: "1",

  compute(read) {
    const adj = read.getRelation("adj")
    const blocked = read.getRelation("blocked")

    const out: FactTuple[] = []
    const seen = new Set<string>()
    const queue: [Value, Value, number][] = []
    for (const [x, y] of read.getRelation("origin").tuples()) {
      const key = serializeTuple([x!, y!])
      if (seen.has(key)) continue
      seen.add(key)
      queue.push([x!, y!, 0])
    }

    // An origin's own tile is measured even when blocked, so that whatever
    // stands there can read its own distance; nothing steps through it.
    for (let head = 0; head < queue.length; head++) {
      const [x, y, d] = queue[head]!
      out.push([x, y, d])

      const probe: Probe = {
        mask: FROM_TILE,
        key: serializeTuple([x, y], FROM_TILE),
      }
      for (const { tuple } of adj.candidates(probe, false)) {
        // Candidates are a superset; confirm the probed positions.
        if (!valuesEqual(tuple[0]!, x) || !valuesEqual(tuple[1]!, y)) continue
        const nx = tuple[2]!
        const ny = tuple[3]!
        const key = serializeTuple([nx, ny])
        if (seen.has(key)) continue
        seen.add(key)
        if (blocked.has([nx, ny])) continue
        queue.push([nx, ny, d + 1])
      }
    }
    return out
  },
}

/** A distance field that also counts how often it was asked to run. */
export function countingDistanceField(): ForeignRelation & {
  readonly runs: { count: number; lastChanged: ReadonlySet<string> }
} {
  const runs = {
    count: 0,
    lastChanged: new Set<string>() as ReadonlySet<string>,
  }
  return {
    ...DISTANCE_FIELD,
    runs,
    compute(read, changed) {
      runs.count++
      runs.lastChanged = changed
      return DISTANCE_FIELD.compute(read, changed)
    },
  }
}
