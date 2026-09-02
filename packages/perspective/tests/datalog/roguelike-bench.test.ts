// === Roguelike Benchmark ===
//
// The workload the Grame team used to evaluate this package as a game runtime
// for Runeloop, kept here so both teams share one regression guard and one
// vocabulary.
//
// Spatial rules are expressed the standard Datalog way, over **materialized
// 4-neighbour adjacency**: an `adj(X1, Y1, X2, Y2)` fact per neighbour pair,
// roughly 12k facts for a 100x30 grid. That keeps rules pure Datalog and
// geography-agnostic, and it is exactly the shape the join index makes fast.
//
// The properties under test are as much about *composition* as speed: fire
// authored in one place and spores authored in another interact through the
// fact base with no coordinating code. That is the whole point of rules that
// merge by set union.
//
// NOTE ON CI: this package is excluded from the monorepo's test and verify
// entry points (`turbo test --filter='!@kyneta/perspective'`), so nothing here
// runs unless you invoke it directly:
//
//     cd experimental/perspective && pnpm exec vitest run
//
// Treat the timing assertions as a local smoke test, not a CI gate. They are
// set with roughly an order of magnitude of headroom so that a genuine
// algorithmic regression trips them while a loaded machine does not.

import { describe, expect, it } from "vitest"
import { zsetEmpty, zsetFromEntries } from "../../src/base/zset.js"
import {
  createEvaluator,
  evaluateUnified as evaluate,
  evaluatePositiveUnified as evaluatePositive,
} from "../../src/datalog/evaluator.js"
import type { Fact, Rule } from "../../src/datalog/types.js"
import {
  atom,
  fact,
  factKey,
  negation,
  positiveAtom,
  rule,
  varTerm,
} from "../../src/datalog/types.js"

const $ = varTerm

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

interface GridOptions {
  /** Insert a vertical wall with a single gap, to test that fire routes. */
  readonly wall?: boolean
  /** Close the wall's gap, sealing the far half off entirely. */
  readonly sealed?: boolean
  /** Scatter spore cells (every 10th cell), to test composition. */
  readonly spores?: boolean
}

interface Grid {
  readonly facts: Fact[]
  readonly wallX: number
  readonly gapY: number
  readonly floorCount: number
}

function buildGrid(w: number, h: number, opts: GridOptions = {}): Grid {
  const facts: Fact[] = []
  const wallX = Math.floor(w / 2)
  const gapY = Math.floor(h / 2)
  const isWall = (x: number, y: number): boolean =>
    opts.wall === true && x === wallX && (opts.sealed === true || y !== gapY)

  let floorCount = 0
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (!isWall(x, y)) {
        facts.push(fact("flammable", [x, y]))
        floorCount++
      }
      if (opts.spores === true && (x * h + y) % 10 === 0) {
        facts.push(fact("spores", [x, y]))
      }
      // Adjacency is symmetric and materialized in both directions. Walls are
      // not carved out of it — a wall cell simply is not `flammable`, so fire
      // cannot settle there. Geography lives in the facts, not the rules.
      if (x + 1 < w) {
        facts.push(fact("adj", [x, y, x + 1, y]))
        facts.push(fact("adj", [x + 1, y, x, y]))
      }
      if (y + 1 < h) {
        facts.push(fact("adj", [x, y, x, y + 1]))
        facts.push(fact("adj", [x, y + 1, x, y]))
      }
    }
  }

  return { facts, wallX, gapY, floorCount }
}

// ---------------------------------------------------------------------------
// The mechanics — three rules, authored as if by three unrelated content packs
// ---------------------------------------------------------------------------

/** Fire spreads to any adjacent flammable cell. Recursive. */
const fireSpread: Rule = rule(atom("lit", [$("X2"), $("Y2")]), [
  positiveAtom(atom("lit", [$("X1"), $("Y1")])),
  positiveAtom(atom("adj", [$("X1"), $("Y1"), $("X2"), $("Y2")])),
  positiveAtom(atom("flammable", [$("X2"), $("Y2")])),
])

/** Spores explode when lit. Knows nothing about how fire got there. */
const sporeBoom: Rule = rule(atom("exploded", [$("X"), $("Y")]), [
  positiveAtom(atom("lit", [$("X"), $("Y")])),
  positiveAtom(atom("spores", [$("X"), $("Y")])),
])

/** Stratified negation: floor that the fire never reached. */
const unburned: Rule = rule(atom("unburned", [$("X"), $("Y")]), [
  positiveAtom(atom("flammable", [$("X"), $("Y")])),
  negation(atom("lit", [$("X"), $("Y")])),
])

const zsetOf = (facts: readonly Fact[]) =>
  zsetFromEntries(facts.map(f => [factKey(f), { element: f, weight: 1 }]))

// ---------------------------------------------------------------------------
// Correctness
// ---------------------------------------------------------------------------

describe("roguelike: fire spread", () => {
  it("floods an open 100x30 grid completely", () => {
    const { facts } = buildGrid(100, 30)
    const db = evaluatePositive([fireSpread], [...facts, fact("lit", [0, 0])])

    expect(db.getRelation("lit").size).toBe(3000)
  })

  it("is blocked by a wall and routes through its gap", () => {
    const { facts, wallX, gapY, floorCount } = buildGrid(100, 30, {
      wall: true,
    })
    const db = evaluatePositive([fireSpread], [...facts, fact("lit", [0, 0])])
    const lit = db.getRelation("lit")

    // Every floor cell burns — the gap is the only way through, and it works.
    expect(lit.size).toBe(floorCount)
    expect(floorCount).toBe(2971)

    // The wall itself never catches.
    for (let y = 0; y < 30; y++) {
      if (y === gapY) continue
      expect(lit.has([wallX, y])).toBe(false)
    }

    // The far corner, reachable only through the gap, does.
    expect(lit.has([99, 29])).toBe(true)
  })

  it("is deterministic in both content and ordering", () => {
    const { facts } = buildGrid(40, 25)
    const seed = [...facts, fact("lit", [0, 0])]

    const first = evaluatePositive([fireSpread], seed)
      .getRelation("lit")
      .tuples()
    const second = evaluatePositive([fireSpread], seed)
      .getRelation("lit")
      .tuples()

    expect(second).toEqual(first)
  })
})

describe("roguelike: composition and negation", () => {
  it("explodes spores with no code shared between the two rules", () => {
    // `sporeBoom` never mentions adjacency and `fireSpread` never mentions
    // spores. They meet only through the `lit` relation.
    const { facts } = buildGrid(100, 30, { spores: true })
    const result = evaluate(
      [fireSpread, sporeBoom],
      [...facts, fact("lit", [0, 0])],
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const sporeCount = facts.filter(f => f.predicate === "spores").length
    expect(result.value.getRelation("exploded").size).toBe(sporeCount)
    expect(sporeCount).toBe(300)
  })

  it("leaves nothing unburned after a full flood", () => {
    const { facts } = buildGrid(100, 30)
    const result = evaluate(
      [fireSpread, unburned],
      [...facts, fact("lit", [0, 0])],
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.getRelation("unburned").size).toBe(0)
  })

  it("reports the cells a sealed wall protects", () => {
    // Close the gap and the far half is unreachable. This is the case that
    // makes the negation stratum earn its keep: the previous test passes
    // trivially if `unburned` always returns nothing, this one does not.
    const w = 20
    const h = 15
    const { facts, wallX } = buildGrid(w, h, { wall: true, sealed: true })
    const result = evaluate(
      [fireSpread, unburned],
      [...facts, fact("lit", [0, 0])],
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const unreachable = (w - wallX - 1) * h
    expect(result.value.getRelation("unburned").size).toBe(unreachable)
    expect(unreachable).toBe(135)

    // And the near half did burn, so the wall blocked rather than smothered.
    expect(result.value.getRelation("lit").size).toBe(wallX * h)
  })
})

// ---------------------------------------------------------------------------
// Performance
//
// Before the join index, delta-source pruning and linear Z-set construction,
// the 100x30 flood took ~32 s. These ceilings are ~7x the measured time, which
// is loose enough for a busy machine and tight enough that losing the index
// (which would cost ~500x) trips them immediately.
// ---------------------------------------------------------------------------

describe("roguelike: performance", () => {
  it("floods 100x30 in well under half a second", () => {
    const { facts } = buildGrid(100, 30)
    const seed = [...facts, fact("lit", [0, 0])]

    const started = performance.now()
    const db = evaluatePositive([fireSpread], seed)
    const elapsed = performance.now() - started

    expect(db.getRelation("lit").size).toBe(3000)
    expect(elapsed).toBeLessThan(500)
  })

  it("scales sub-quadratically in the number of facts", () => {
    // The signature of the original bug was ~32x the facts costing ~1,200x the
    // time. This asserts the shape rather than any absolute number, so it
    // means the same thing on any machine.
    const small = buildGrid(25, 30)
    const large = buildGrid(100, 30)
    expect(large.facts.length / small.facts.length).toBeGreaterThan(3.5)

    const time = (facts: Fact[]): number => {
      const seed = [...facts, fact("lit", [0, 0])]
      evaluatePositive([fireSpread], seed) // warm
      const started = performance.now()
      evaluatePositive([fireSpread], seed)
      return performance.now() - started
    }

    const ratio = time(large.facts) / Math.max(time(small.facts), 0.1)
    expect(ratio).toBeLessThan(20)
  })

  it("applies a single-fact tick to a large world in about a millisecond", () => {
    // The shape of a Runeloop tick: a few action facts in, a small delta out,
    // against a world that stays loaded between ticks.
    const { facts } = buildGrid(100, 30)
    const evaluator = createEvaluator([fireSpread, sporeBoom])

    evaluator.step(zsetOf(facts), zsetEmpty())
    evaluator.step(zsetOf([fact("lit", [0, 0])]), zsetEmpty())
    expect(evaluator.currentDatabase().getRelation("lit").size).toBe(3000)

    const ticks: number[] = []
    for (let i = 0; i < 200; i++) {
      const spore = fact("spores", [i % 100, (i * 7) % 30])
      const started = performance.now()
      evaluator.step(zsetOf([spore]), zsetEmpty())
      ticks.push(performance.now() - started)
    }

    ticks.sort((a, b) => a - b)
    const p95 = ticks[Math.floor(ticks.length * 0.95)]!

    expect(evaluator.currentDatabase().getRelation("exploded").size).toBe(200)
    expect(p95).toBeLessThan(5)
  })
})
