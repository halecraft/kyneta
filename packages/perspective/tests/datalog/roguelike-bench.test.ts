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
// This file runs with the rest of the package under the root `turbo test`,
// or on its own:
//
//     cd packages/perspective && pnpm exec vitest run tests/datalog/roguelike-bench.test.ts
//
// Treat the timing assertions as a smoke test, not a benchmark. They are set
// with roughly an order of magnitude of headroom so that a genuine algorithmic
// regression trips them while a loaded machine does not.

import { describe, expect, it } from "vitest"
// Everything here comes through the package's root barrel on purpose: this
// file is the workload a downstream engine shares, so it exercises the
// surface that engine can reach.
import type { Fact, Rule } from "../../src/index.js"
import {
  atom,
  createEvaluator,
  evaluate,
  evaluatePositive,
  fact,
  factKey,
  factsToZSet,
  lt,
  negation,
  positiveAtom,
  rule,
  varTerm,
  zsetAdd,
} from "../../src/index.js"
import { DISTANCE_FIELD } from "./fields.js"

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
// The public surface, end to end
// ---------------------------------------------------------------------------

describe("roguelike: the long-lived evaluator through the root barrel", () => {
  it("loads a world, then ticks with a retraction and an insertion in one delta", () => {
    const { facts } = buildGrid(20, 15)
    const evaluator = createEvaluator([fireSpread, sporeBoom])
    evaluator.step(
      factsToZSet([...facts, fact("lit", [0, 0]), fact("spores", [2, 0])]),
    )
    expect(
      evaluator.currentDatabase().getRelation("exploded").has([2, 0]),
    ).toBe(true)

    // One tick: the spores move. Build the delta as new minus old.
    const delta = evaluator.step(
      zsetAdd(
        factsToZSet([fact("spores", [2, 0])], -1),
        factsToZSet([fact("spores", [1, 0])]),
      ),
    )
    const changed = [...delta.entries()]
      .map(([key, entry]) => [key, entry.weight])
      .sort()
    expect(changed).toEqual([
      [factKey(fact("exploded", [1, 0])), 1],
      [factKey(fact("exploded", [2, 0])), -1],
    ])
    const exploded = evaluator.currentDatabase().getRelation("exploded")
    expect(exploded.has([1, 0])).toBe(true)
    expect(exploded.has([2, 0])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Performance
//
// Before the join index, delta-source pruning and linear Z-set construction,
// the 100x30 flood took ~32 s; keying each fact once instead of at every
// hand-off then took it from ~67 ms to ~29 ms. These ceilings are ~7x the
// measured time, which is loose enough for a busy machine and tight enough
// that losing the index (which would cost ~500x) trips them immediately.
// ---------------------------------------------------------------------------

describe("roguelike: performance", () => {
  it("floods 100x30 in well under a quarter of a second", () => {
    const { facts } = buildGrid(100, 30)
    const seed = [...facts, fact("lit", [0, 0])]

    const started = performance.now()
    const db = evaluatePositive([fireSpread], seed)
    const elapsed = performance.now() - started

    expect(db.getRelation("lit").size).toBe(3000)
    expect(elapsed).toBeLessThan(250)
  })

  it("a full batch evaluate of the world stays around the flood's cost", () => {
    // The shape a batch-per-tick consumer pays: stratify, ingest every fact,
    // derive everything, from scratch. Fire plus spores plus the negation
    // stratum measured ~31 ms; the ceiling is ~7x that.
    const { facts } = buildGrid(100, 30, { spores: true })
    const seed = [...facts, fact("lit", [0, 0])]

    evaluate([fireSpread, sporeBoom, unburned], seed) // warm
    const started = performance.now()
    const result = evaluate([fireSpread, sporeBoom, unburned], seed)
    const elapsed = performance.now() - started

    expect(result.ok).toBe(true)
    expect(elapsed).toBeLessThan(220)
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

    evaluator.step(factsToZSet(facts))
    evaluator.step(factsToZSet([fact("lit", [0, 0])]))
    expect(evaluator.currentDatabase().getRelation("lit").size).toBe(3000)

    const ticks: number[] = []
    for (let i = 0; i < 200; i++) {
      const spore = fact("spores", [i % 100, (i * 7) % 30])
      const started = performance.now()
      evaluator.step(factsToZSet([spore]))
      ticks.push(performance.now() - started)
    }

    ticks.sort((a, b) => a - b)
    const p95 = ticks[Math.floor(ticks.length * 0.95)]!

    expect(evaluator.currentDatabase().getRelation("exploded").size).toBe(200)
    expect(p95).toBeLessThan(5)
  })

  it("a foreign distance field follows a moving player at a few milliseconds a tick", () => {
    // The workload that retires a downstream engine's settle loop: the
    // breadth-first field in `fields.ts` as a foreign stratum, with `origin`
    // and `blocked` derived below it and a hunt rule reading it above. Each
    // tick moves the player, so `origin` flips and the field is run again and
    // diffed. Measured ~8 ms p50, ~10 ms p95 on the 100x30 world; the ceiling
    // is ~10x that. This is the number the settle loop paid ~125 ms for.
    const { facts } = buildGrid(100, 30)
    for (let y = 2; y < 28; y += 4) facts.push(fact("wall", [50, y]))
    const origin = rule(atom("origin", [$("X"), $("Y")]), [
      positiveAtom(atom("player", [$("P")])),
      positiveAtom(atom("at", [$("P"), $("X"), $("Y")])),
    ])
    const blocked = rule(atom("blocked", [$("X"), $("Y")]), [
      positiveAtom(atom("wall", [$("X"), $("Y")])),
    ])
    const hunt = rule(atom("hunt", [$("M"), $("X2"), $("Y2")]), [
      positiveAtom(atom("murk", [$("M")])),
      positiveAtom(atom("at", [$("M"), $("X"), $("Y")])),
      positiveAtom(atom("dist", [$("X"), $("Y"), $("D")])),
      positiveAtom(atom("adj", [$("X"), $("Y"), $("X2"), $("Y2")])),
      positiveAtom(atom("dist", [$("X2"), $("Y2"), $("D2")])),
      lt($("D2"), $("D")),
    ])
    const evaluator = createEvaluator([origin, blocked, hunt], {
      relations: [DISTANCE_FIELD],
    })
    evaluator.step(
      factsToZSet([
        ...facts,
        fact("player", ["hero"]),
        fact("at", ["hero", 0, 0]),
        fact("murk", ["m"]),
        fact("at", ["m", 99, 29]),
      ]),
    )
    expect(evaluator.currentDatabase().getRelation("dist").size).toBe(2993)
    expect(
      evaluator.currentDatabase().getRelation("hunt").size,
    ).toBeGreaterThan(0)

    const ticks: number[] = []
    let [hx, hy] = [0, 0]
    for (let i = 1; i <= 30; i++) {
      const [nx, ny] = [i, (i * 7) % 30]
      const move = new Map([
        ...factsToZSet([fact("at", ["hero", hx, hy])], -1),
        ...factsToZSet([fact("at", ["hero", nx, ny])]),
      ])
      ;[hx, hy] = [nx, ny]
      const started = performance.now()
      evaluator.step(move)
      ticks.push(performance.now() - started)
    }

    expect(
      evaluator.currentDatabase().getRelation("dist").has([hx, hy, 0]),
    ).toBe(true)
    ticks.sort((a, b) => a - b)
    expect(ticks[Math.floor(ticks.length * 0.95)]!).toBeLessThan(100)
  })

  it("retracting into the recursive flood recomputes it in tens of milliseconds", () => {
    // The stopgap for retraction into recursion (TECHNICAL.md, "Known
    // follow-ups") derives the stratum again from scratch, so this tick costs
    // the flood rather than the change: measured ~13 ms p50, ~16 ms p95 on
    // the 100x30 world, ceiling ~7x. Plan 006.3 (per-round counts) should
    // bring it near the single-fact tick above; tighten this when it lands.
    const { facts } = buildGrid(100, 30)
    const evaluator = createEvaluator([fireSpread])
    evaluator.step(factsToZSet([...facts, fact("lit", [0, 0])]))
    expect(evaluator.currentDatabase().getRelation("lit").size).toBe(3000)

    const ticks: number[] = []
    for (let i = 0; i < 20; i++) {
      const cell = fact("flammable", [1 + ((i * 37) % 99), (i * 11) % 30])
      const started = performance.now()
      evaluator.step(factsToZSet([cell], -1)) // recomputed
      ticks.push(performance.now() - started)
      evaluator.step(factsToZSet([cell])) // incremental
    }

    expect(evaluator.currentDatabase().getRelation("lit").size).toBe(3000)
    ticks.sort((a, b) => a - b)
    expect(ticks[Math.floor(ticks.length * 0.95)]!).toBeLessThan(100)
  })
})
