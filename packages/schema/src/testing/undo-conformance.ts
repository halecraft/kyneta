// undo-conformance — shared, re-exportable suite for `Substrate.revertible`.
//
// Every revertible substrate runs these scenarios through a minimal stack
// kept here, on the step algorithm the exchange's stack uses: a step holds
// one record, the commits one block made joined by `compose` (a commit that
// cannot join closes the step and opens the next), with their footprints'
// union. Undo plans the top step's record, settles it (`settleStep`),
// applies it, and pushes the redo as the step to redo, under the same
// footprint; a step nothing of which stands is dropped and the next tried.
// Every revert's remap rewrites the records left behind. The stack checks the
// footprint contract on every commit and every revert: a commit's footprint
// covers what its ops wrote, and a revert writes only inside the footprint
// of the record it reverts.
// Each scenario runs twice: live, and with every record encoded and decoded
// and the peer rebuilt from its whole state between the edits and the undo,
// as a reload does.
//
// Scenarios that need a second peer run only where the env can sync two
// (the CRDT backends); a plain document has one writer.

import { describe, expect, it } from "vitest"
import type { Op } from "../changefeed.js"
import { batch } from "../facade/batch.js"
import { subscribe } from "../facade/observe.js"
import {
  type Footprint,
  footprintOf,
  footprintsOverlap,
  footprintUnion,
} from "../footprint.js"
import { Schema } from "../schema.js"
import type {
  Revertible,
  RevertibleCommit,
  RevertPlan,
  Substrate,
  Version,
} from "../substrate.js"
import { EMPTY_TALLY, howMuchStands, settleStep } from "../undo-step.js"

// ---------------------------------------------------------------------------
// Fixture and env
// ---------------------------------------------------------------------------

/** The document every scenario edits. */
export const UndoFixture = Schema.struct({
  title: Schema.text(),
  body: Schema.richText({ bold: { expand: "after" } }),
  tags: Schema.list(Schema.string()),
  cards: Schema.list(
    Schema.struct({
      name: Schema.text(),
      done: Schema.boolean(),
      notes: Schema.list(Schema.string()),
      blurb: Schema.richText({ bold: { expand: "after" } }),
    }),
  ),
  labels: Schema.record(Schema.string()),
  place: Schema.string(),
  meta: Schema.struct.json({ a: Schema.string(), b: Schema.string() }),
})

/** A document of the fixture, and the substrate under it. */
export interface UndoPeer {
  readonly doc: any
  readonly substrate: Substrate<Version>
}

export interface UndoTestEnv {
  /** A new peer. Each call is a different peer. */
  create(): UndoPeer
  /** `peer` rebuilt from its whole state, under the same identity. */
  reload(peer: UndoPeer): UndoPeer
  /** Exchange everything between two peers. Absent for a single writer. */
  readonly sync?: (a: UndoPeer, b: UndoPeer) => void
  /** Insert `text` at `index` of `title` directly on the native document,
   *  as an editor binding does. Absent where there is none. */
  readonly nativeInsert?: (peer: UndoPeer, index: number, text: string) => void
}

export interface UndoConformanceOptions {
  readonly label?: string
}

// ---------------------------------------------------------------------------
// A minimal stack
// ---------------------------------------------------------------------------

function revertibleOf(peer: UndoPeer): Revertible {
  const revertible = peer.substrate.revertible
  if (revertible === undefined) throw new Error("substrate is not revertible")
  return revertible
}

/** A step: one record, and the footprint of the commits it joins. */
interface Entry {
  readonly record: unknown
  readonly footprint: Footprint
}

/** Whether `outer` covers every path of `inner`. */
function covers(outer: Footprint, inner: Footprint): boolean {
  return (
    JSON.stringify(footprintUnion(outer, inner)) ===
    JSON.stringify(footprintUnion(outer))
  )
}

/** A peer with an undo stack over its own commits. */
class Stack {
  peer: UndoPeer
  undos: Entry[] = []
  redos: Entry[] = []
  /** The steps the running block made, the last one open. */
  #open: Entry[] | undefined
  #stop: () => void

  constructor(
    private readonly env: UndoTestEnv,
    peer: UndoPeer,
  ) {
    this.peer = peer
    this.#stop = this.#listen()
  }

  #listen(): () => void {
    const revertible = revertibleOf(this.peer)
    return revertible.subscribeCommits((commit: RevertibleCommit<unknown>) => {
      expect(
        covers(commit.footprint, footprintOf(UndoFixture, commit.ops)),
      ).toBe(true)
      const open = this.#open
      if (open === undefined) return
      const last = open.at(-1)
      const joined =
        last === undefined
          ? null
          : revertible.compose(last.record, commit.record)
      if (last === undefined || joined === null) {
        open.push({ record: commit.record, footprint: commit.footprint })
        return
      }
      open[open.length - 1] = {
        record: joined,
        footprint: footprintUnion(last.footprint, commit.footprint),
      }
    })
  }

  get doc(): any {
    return this.peer.doc
  }

  /** Run `fn` as one step, or several where a commit cannot join. */
  step(fn: (d: any) => void): void {
    this.#open = []
    try {
      fn(this.doc)
    } finally {
      const steps = this.#open
      this.#open = undefined
      if (steps.length > 0) {
        this.undos.push(...steps)
        this.redos = []
      }
    }
  }

  /** The plan of the step `undo` takes first. */
  plan(): RevertPlan<unknown> {
    const top = this.undos.at(-1)
    if (top === undefined) throw new Error("nothing to undo")
    return revertibleOf(this.peer).plan(top.record)
  }

  #move(from: Entry[], to: Entry[]): boolean {
    const revertible = revertibleOf(this.peer)
    for (let entry = from.pop(); entry !== undefined; entry = from.pop()) {
      const plan = revertible.plan(entry.record)
      if (settleStep([plan.tally], false) === "dropped") continue
      const { redo, remap } = this.#apply(plan, entry)
      for (const list of [this.undos, this.redos]) {
        list.splice(
          0,
          list.length,
          ...list.map(e => ({
            ...e,
            record: revertible.rewrite(e.record, remap),
          })),
        )
      }
      to.push({ record: redo, footprint: entry.footprint })
      return true
    }
    return false
  }

  /** Apply `plan`, checking that what the revert wrote lies inside its
   *  footprint, and that a record that names nothing writes nothing. */
  #apply(plan: RevertPlan<unknown>, entry: Entry) {
    if (plan.apply === undefined) throw new Error("a standing plan applies")
    const delivered: Op[] = []
    const stop = subscribe(this.doc, changeset => {
      delivered.push(...changeset.changes)
    })
    let result: ReturnType<typeof plan.apply>
    try {
      result = plan.apply({})
    } finally {
      stop()
    }
    if (plan.tally.total === 0) expect(delivered).toEqual([])
    else expect(delivered.length).toBeGreaterThan(0)
    expect(covers(entry.footprint, footprintOf(UndoFixture, delivered))).toBe(
      true,
    )
    return result
  }

  undo(): boolean {
    return this.#move(this.undos, this.redos)
  }

  redo(): boolean {
    return this.#move(this.redos, this.undos)
  }

  /** Encode every record, rebuild the peer from its whole state, decode. */
  reload(): void {
    const { codec } = revertibleOf(this.peer)
    const bytes = (steps: Entry[]) =>
      steps.map(e => ({ ...e, record: codec.encode(e.record) }))
    const undos = bytes(this.undos)
    const redos = bytes(this.redos)
    this.#stop()
    this.peer = this.env.reload(this.peer)
    const next = revertibleOf(this.peer).codec
    const back = (steps: { record: Uint8Array; footprint: Footprint }[]) =>
      steps.map(e => ({ ...e, record: next.decode(e.record) }))
    this.undos = back(undos)
    this.redos = back(redos)
    this.#stop = this.#listen()
  }
}

// ---------------------------------------------------------------------------
// One batch against separate commits
// ---------------------------------------------------------------------------

const card = (name: string, notes: string[] = []) => ({
  name,
  done: false,
  notes,
  blurb: [],
})

/** Writes made once as one batch and once as one commit each, in one step:
 *  undo and redo must give the same document either way. */
interface Scenario {
  readonly name: string
  readonly setup: (d: any) => void
  readonly edit: (d: any) => void
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "type then delete own text",
    setup: d => d.title.insert(0, "ab"),
    edit: d => {
      d.title.insert(1, "xyz")
      d.title.delete(2, 1)
    },
  },
  {
    name: "delete then retype at the same place",
    setup: d => d.title.insert(0, "abc"),
    edit: d => {
      d.title.delete(1, 1)
      d.title.insert(1, "X")
    },
  },
  {
    name: "set a value twice",
    setup: d => d.place.set("a"),
    edit: d => {
      d.place.set("b")
      d.place.set("c")
    },
  },
  {
    name: "set a key then delete it",
    setup: d => d.labels.set("j", "v"),
    edit: d => {
      d.labels.set("k", "v")
      d.labels.delete("k")
    },
  },
  {
    name: "add an item then delete it",
    setup: d => d.cards.push(card("a")),
    edit: d => {
      d.cards.push(card("b"))
      d.cards.delete(1, 1)
    },
  },
  {
    name: "add an item then write inside it",
    setup: d => d.cards.push(card("a")),
    edit: d => {
      d.cards.push(card("b"))
      d.cards.at(1).name.insert(1, "!")
      d.cards.at(1).done.set(true)
      d.cards.at(1).notes.push("n")
    },
  },
  {
    name: "write inside an item then delete it",
    setup: d => d.cards.push(card("a", ["n"]), card("b")),
    edit: d => {
      d.cards.at(0).name.insert(1, "!")
      d.cards.at(0).done.set(true)
      d.cards.at(0).notes.push("m")
      d.cards.delete(0, 1)
    },
  },
  {
    name: "delete an item then add a new one",
    setup: d => d.cards.push(card("a"), card("b")),
    edit: d => {
      d.cards.delete(0, 1)
      d.cards.insert(0, card("c"))
    },
  },
  {
    name: "delete list items right to left",
    setup: d => d.tags.push("a", "b", "c", "d"),
    edit: d => {
      d.tags.delete(3, 1)
      d.tags.delete(2, 1)
      d.tags.delete(1, 1)
    },
  },
  {
    name: "delete list items left to right",
    setup: d => d.tags.push("a", "b", "c", "d"),
    edit: d => {
      d.tags.delete(1, 1)
      d.tags.delete(1, 1)
      d.tags.delete(1, 1)
    },
  },
  {
    name: "insert between two items, then delete the first",
    setup: d => d.tags.push("a", "b"),
    edit: d => {
      d.tags.insert(1, "x")
      d.tags.delete(0, 1)
    },
  },
  {
    name: "backspace text",
    setup: d => d.title.insert(0, "hello"),
    edit: d => {
      d.title.delete(4, 1)
      d.title.delete(3, 1)
      d.title.delete(2, 1)
    },
  },
  {
    name: "add to a list inside an item, then delete the item",
    setup: d => d.cards.push(card("a", ["n"]), card("b")),
    edit: d => {
      d.cards.at(0).notes.push("m")
      d.cards.delete(0, 1)
    },
  },
  {
    name: "mark text, then delete it",
    setup: d => d.body.insert(0, "hello world"),
    edit: d => {
      d.body.mark(0, 5, "bold", true)
      d.body.delete(0, 5)
    },
  },
  {
    name: "insert text, then mark it",
    setup: d => d.body.insert(0, "world"),
    edit: d => {
      d.body.insert(0, "hello ")
      d.body.mark(0, 5, "bold", true)
    },
  },
  {
    name: "mark text inside an item, then delete the item",
    setup: d => {
      d.cards.push(card("a"), card("b"))
      d.cards.at(0).blurb.insert(0, "hello")
    },
    edit: d => {
      d.cards.at(0).blurb.mark(0, 5, "bold", true)
      d.cards.delete(0, 1)
    },
  },
]

// ---------------------------------------------------------------------------
// Conformance suite
// ---------------------------------------------------------------------------

export function undoConformance(
  env: UndoTestEnv,
  options?: UndoConformanceOptions,
): void {
  const suffix = options?.label ? ` (${options.label})` : ""
  const { sync } = env

  describe(`undo conformance${suffix}`, () => {
    for (const reload of [false, true]) {
      const when = reload ? "after a reload" : "live"
      const settle = (stack: Stack) => {
        if (reload) stack.reload()
      }

      describe(when, () => {
        describe("a batch undoes as its commits do", () => {
          for (const scenario of SCENARIOS) {
            for (const asBatch of [true, false]) {
              const how = asBatch ? "one batch" : "separate commits"
              it(`${scenario.name}, as ${how}`, () => {
                const s = new Stack(env, env.create())
                s.step(scenario.setup)
                const before = s.doc()
                s.step(d => {
                  if (asBatch) batch(d, scenario.edit)
                  else scenario.edit(d)
                })
                const after = s.doc()
                settle(s)
                expect(s.undo()).toBe(true)
                expect(s.doc()).toEqual(before)
                settle(s)
                expect(s.redo()).toBe(true)
                expect(s.doc()).toEqual(after)
                settle(s)
                expect(s.undo()).toBe(true)
                expect(s.doc()).toEqual(before)
              })
            }
          }
        })

        it("type, delete what you typed, undo, undo returns to the start", () => {
          const s = new Stack(env, env.create())
          s.step(d => d.title.insert(0, "hello"))
          s.step(d => d.title.insert(5, " world"))
          s.step(d => d.title.delete(3, 5))
          settle(s)
          expect(s.undo()).toBe(true)
          expect(s.doc.title()).toBe("hello world")
          expect(s.undo()).toBe(true)
          expect(s.doc.title()).toBe("hello")
          expect(s.undo()).toBe(true)
          expect(s.doc.title()).toBe("")
        })

        it("type inside a list item, delete the item, undo, undo returns to the start", () => {
          const s = new Stack(env, env.create())
          s.step(d => d.cards.push(card("hi")))
          s.step(d => d.cards.at(0).name.insert(2, " there"))
          s.step(d => d.cards.delete(0, 1))
          settle(s)
          expect(s.undo()).toBe(true)
          expect(s.doc.cards()).toEqual([card("hi there")])
          settle(s)
          expect(s.undo()).toBe(true)
          expect(s.doc.cards()).toEqual([card("hi")])
        })

        it("a step that writes a card, then inserts a card before it, undoes exactly", () => {
          const s = new Stack(env, env.create())
          s.step(d => d.cards.push(card("a"), card("b"), card("c")))
          const before = s.doc.cards()
          s.step(d =>
            batch(d, (b: any) => {
              b.cards.at(1).done.set(true)
              b.cards.insert(0, card("new"))
            }),
          )
          settle(s)
          expect(s.undo()).toBe(true)
          expect(s.doc.cards()).toEqual(before)
        })

        it("a step of several commits to one text or list undoes and redoes in order", () => {
          const s = new Stack(env, env.create())
          s.step(d => {
            d.title.insert(0, "Go")
            d.tags.push("a", "b", "c", "d")
          })
          // Keystrokes, one commit each: typed, then backspaced.
          s.step(d => {
            for (const c of "more") d.title.insert(d.title().length, c)
          })
          s.step(d => {
            for (let i = 0; i < 4; i++) d.title.delete(d.title().length - 1, 1)
            for (let i = 0; i < 3; i++) d.tags.delete(1, 1)
          })
          settle(s)
          expect(s.undo()).toBe(true)
          expect(s.doc.title()).toBe("Gomore")
          expect(s.doc.tags()).toEqual(["a", "b", "c", "d"])
          settle(s)
          expect(s.undo()).toBe(true)
          expect(s.doc.title()).toBe("Go")
          settle(s)
          expect(s.redo()).toBe(true)
          expect(s.doc.title()).toBe("Gomore")
          settle(s)
          expect(s.redo()).toBe(true)
          expect(s.doc.title()).toBe("Go")
          expect(s.doc.tags()).toEqual(["a"])
          settle(s)
          expect(s.undo()).toBe(true)
          expect(s.doc.title()).toBe("Gomore")
          expect(s.doc.tags()).toEqual(["a", "b", "c", "d"])
        })

        it("undoing everything and redoing everything is exact", () => {
          const s = new Stack(env, env.create())
          s.step(d => {
            d.title.insert(0, "abc")
            d.tags.push("x", "y")
          })
          s.step(d => d.labels.set("k", "v"))
          s.step(d => d.place.set("column"))
          s.step(d => {
            d.title.delete(1, 1)
            d.tags.delete(0, 1)
            d.labels.delete("k")
          })
          s.step(d => d.body.insert(0, "bold", { bold: true }))
          const after = JSON.stringify(s.doc())
          settle(s)
          while (s.undo()) settle(s)
          expect(s.doc()).toEqual({
            title: "",
            body: [],
            tags: [],
            cards: [],
            labels: {},
            place: "",
            meta: { a: "", b: "" },
          })
          while (s.redo()) settle(s)
          expect(JSON.stringify(s.doc())).toBe(after)
        })

        it("my own later write to a key, both undone, restores the first value", () => {
          const s = new Stack(env, env.create())
          s.step(d => d.place.set("a"))
          s.step(d => d.place.set("b"))
          s.step(d => d.place.set("c"))
          settle(s)
          s.undo()
          s.undo()
          expect(s.doc.place()).toBe("a")
        })

        it("two writes inside one .json() value overlap, and undo and redo exactly", () => {
          const s = new Stack(env, env.create())
          s.step(d => d.meta.a.set("x"))
          s.step(d => d.meta.b.set("y"))
          const [first, second] = s.undos.map(e => e.footprint)
          expect(first && second && footprintsOverlap(first, second)).toBe(true)
          settle(s)
          expect(s.undo()).toBe(true)
          expect(s.doc.meta()).toEqual({ a: "x", b: "" })
          settle(s)
          expect(s.undo()).toBe(true)
          expect(s.doc.meta()).toEqual({ a: "", b: "" })
          settle(s)
          expect(s.redo()).toBe(true)
          settle(s)
          expect(s.redo()).toBe(true)
          expect(s.doc.meta()).toEqual({ a: "x", b: "y" })
        })

        it("an aborted batch records nothing", () => {
          const s = new Stack(env, env.create())
          s.step(d => {
            try {
              batch(d, (x: any) => {
                x.title.insert(0, "gone")
                throw new Error("abort")
              })
            } catch {}
          })
          expect(s.undos).toEqual([])
        })

        it("authoredSince is false before a revert and true after; recovered matches the revert", () => {
          const s = new Stack(env, env.create())
          s.step(d => d.title.insert(0, "abc"))
          s.step(d => d.title.delete(0, 3)) // a delete-only step
          settle(s)
          const revertible = revertibleOf(s.peer)
          const record = s.undos.at(-1)?.record
          const position = revertible.position()
          expect(revertible.authoredSince(position)).toBe(false)
          const plan = revertible.plan(record)
          expect(revertible.authoredSince(position)).toBe(false)
          if (plan.apply === undefined) throw new Error("the step stands")
          const result = plan.apply({})
          expect(revertible.authoredSince(position)).toBe(true)
          const recovered = revertible.recovered(record, position)
          expect(revertible.codec.encode(recovered.redo)).toEqual(
            revertible.codec.encode(result.redo),
          )
          expect([...recovered.remap]).toEqual([...result.remap])
        })

        if (env.nativeInsert !== undefined) {
          const nativeInsert = env.nativeInsert
          it("a direct write on the native document is recorded and reverted", () => {
            const s = new Stack(env, env.create())
            s.step(d => d.title.insert(0, "ac"))
            s.step(() => nativeInsert(s.peer, 1, "b"))
            expect(s.doc.title()).toBe("abc")
            settle(s)
            expect(s.undo()).toBe(true)
            expect(s.doc.title()).toBe("ac")
          })
        }

        it("a plan reads only: planning twice and applying neither changes nothing", () => {
          const s = new Stack(env, env.create())
          s.step(d => d.title.insert(0, "abc"))
          settle(s)
          const before = s.doc()
          const first = s.plan()
          const second = s.plan()
          expect(second.tally).toEqual(first.tally)
          expect(howMuchStands(first.tally)).toBe("whole")
          expect(s.doc()).toEqual(before)
        })

        if (sync !== undefined) {
          // A plain record is one unit, standing whole or not at all; a CRDT
          // record counts what it names, and can name nothing.
          for (const [name, setup, edit] of [
            [
              "set then restore a value",
              (d: any) => d.place.set("x"),
              (d: any) => {
                d.place.set("y")
                d.place.set("x")
              },
            ],
            [
              "add then delete an item",
              (d: any) => d.tags.push("a"),
              (d: any) => {
                d.tags.push("b")
                d.tags.delete(1, 1)
              },
            ],
            [
              "insert, mark, then delete text",
              (d: any) => d.body.insert(0, "hello"),
              (d: any) => {
                d.body.insert(5, " world")
                d.body.mark(5, 6, "bold", true)
                d.body.delete(5, 6)
              },
            ],
          ] as const) {
            it(`commits that cancel out compose into a record naming nothing: ${name}`, () => {
              const s = new Stack(env, env.create())
              s.step(setup)
              const before = s.doc()
              s.step(edit)
              expect(s.undos).toHaveLength(2)
              settle(s)
              expect(s.plan().tally).toEqual(EMPTY_TALLY)
              expect(s.undo()).toBe(true)
              expect(s.doc()).toEqual(before)
              expect(s.redo()).toBe(true)
              expect(s.doc()).toEqual(before)
            })
          }

          it("a record stands whole while nothing changed it", () => {
            const mine = new Stack(env, env.create())
            const peer = env.create()
            mine.step(d =>
              batch(d, (b: any) => {
                b.place.set("column")
                b.labels.set("k", "mine")
              }),
            )
            sync(mine.peer, peer)
            settle(mine)
            expect(howMuchStands(mine.plan().tally)).toBe("whole")
          })

          it("a record stands in part when a peer overwrote one of its two values, and not at all when both", () => {
            const mine = new Stack(env, env.create())
            const peer = env.create()
            mine.step(d =>
              batch(d, (b: any) => {
                b.place.set("column")
                b.labels.set("k", "mine")
              }),
            )
            sync(mine.peer, peer)
            batch(peer.doc, (d: any) => d.place.set("queue"))
            sync(mine.peer, peer)
            settle(mine)
            expect(howMuchStands(mine.plan().tally)).toBe("part")
            batch(peer.doc, (d: any) => d.labels.set("k", "theirs"))
            sync(mine.peer, peer)
            expect(howMuchStands(mine.plan().tally)).toBe("none")
            expect(mine.undo()).toBe(false)
            expect(mine.doc.place()).toBe("queue")
          })

          it("a record stands in part when a peer deleted some of my typed text, and its revert deletes the rest", () => {
            const mine = new Stack(env, env.create())
            const peer = env.create()
            mine.step(d => d.title.insert(0, "hello"))
            sync(mine.peer, peer)
            batch(peer.doc, (d: any) => d.title.delete(2, 2))
            sync(mine.peer, peer)
            settle(mine)
            expect(mine.doc.title()).toBe("heo")
            expect(howMuchStands(mine.plan().tally)).toBe("part")
            expect(mine.undo()).toBe(true)
            expect(mine.doc.title()).toBe("")
          })

          it("a peer's write to a value between two of my commits to it splits the step", () => {
            const mine = new Stack(env, env.create())
            const peer = env.create()
            sync(mine.peer, peer)
            mine.step(d => {
              d.place.set("a")
              sync(mine.peer, peer)
              batch(peer.doc, (p: any) => p.place.set("q"))
              sync(mine.peer, peer)
              d.place.set("b")
            })
            expect(mine.undos).toHaveLength(2)
            settle(mine)
            expect(mine.undo()).toBe(true)
            expect(mine.doc.place()).toBe("q")
          })

          it("undoing my insert keeps what a peer typed inside and around it", () => {
            const mine = new Stack(env, env.create())
            const peer = env.create()
            mine.step(d => d.title.insert(0, "[]"))
            sync(mine.peer, peer)
            mine.step(d => d.title.insert(1, "XYZ"))
            sync(mine.peer, peer)
            batch(peer.doc, (d: any) => {
              d.title.insert(3, "__") // [XY__Z]
              d.title.insert(0, ">") // >[XY__Z]
            })
            sync(mine.peer, peer)
            settle(mine)
            sync(mine.peer, peer)
            expect(mine.undo()).toBe(true)
            expect(mine.doc.title()).toBe(">[__]")
          })

          it("a restored deletion lands where it was, before a peer's insert at its edge", () => {
            const mine = new Stack(env, env.create())
            const peer = env.create()
            mine.step(d => d.title.insert(0, "abc"))
            sync(mine.peer, peer)
            mine.step(d => d.title.delete(1, 1))
            sync(mine.peer, peer)
            batch(peer.doc, (d: any) => {
              d.title.insert(1, "X")
              d.title.insert(0, ">")
            })
            sync(mine.peer, peer)
            settle(mine)
            sync(mine.peer, peer)
            expect(mine.undo()).toBe(true)
            expect(mine.doc.title()).toBe(">abXc")
          })

          it("a key a peer overwrote since is left alone", () => {
            const mine = new Stack(env, env.create())
            const peer = env.create()
            mine.step(d => d.place.set("drawer"))
            mine.step(d => d.labels.set("k", "mine"))
            sync(mine.peer, peer)
            mine.step(d => {
              d.place.set("column")
              d.labels.set("k", "changed")
            })
            sync(mine.peer, peer)
            batch(peer.doc, (d: any) => d.place.set("queue"))
            sync(mine.peer, peer)
            settle(mine)
            sync(mine.peer, peer)
            expect(mine.undo()).toBe(true)
            expect(mine.doc.place()).toBe("queue")
            expect(mine.doc.labels()).toEqual({ k: "mine" })
          })

          it("unmarking changes only the range I marked, not a peer's text around it", () => {
            const mine = new Stack(env, env.create())
            const peer = env.create()
            mine.step(d => d.body.insert(0, "hello world"))
            sync(mine.peer, peer)
            mine.step(d => d.body.mark(0, 5, "bold", true))
            sync(mine.peer, peer)
            batch(peer.doc, (d: any) => {
              d.body.insert(2, "XX", { bold: true })
              d.body.insert(0, "YY")
            })
            sync(mine.peer, peer)
            settle(mine)
            sync(mine.peer, peer)
            expect(mine.undo()).toBe(true)
            expect(mine.doc.body()).toEqual([
              { text: "YYhe" },
              { text: "XX", marks: { bold: true } },
              { text: "llo world" },
            ])
          })
        }
      })
    }
  })
}
