// undo-conformance — shared, re-exportable suite for `Substrate.revertible`.
//
// Every revertible substrate runs these scenarios through a minimal stack
// kept here: a step is the records of the commits one block made, undo
// reverts a step's records last first and pushes what that produced as the
// step to redo, and every revert's remap rewrites the records left behind.
// Each scenario runs twice: live, and with every record encoded and decoded
// and the peer rebuilt from its whole state between the edits and the undo,
// as a reload does.
//
// Scenarios that need a second peer run only where the env can sync two
// (the CRDT backends); a plain document has one writer.

import { describe, expect, it } from "vitest"
import { batch } from "../facade/batch.js"
import { Schema } from "../schema.js"
import type {
  Remap,
  Revertible,
  RevertibleCommit,
  Substrate,
  Version,
} from "../substrate.js"

// ---------------------------------------------------------------------------
// Fixture and env
// ---------------------------------------------------------------------------

/** The document every scenario edits. */
export const UndoFixture = Schema.struct({
  title: Schema.text(),
  body: Schema.richText({ bold: { expand: "after" } }),
  tags: Schema.list(Schema.string()),
  cards: Schema.list(
    Schema.struct({ name: Schema.text(), done: Schema.boolean() }),
  ),
  labels: Schema.record(Schema.string()),
  place: Schema.string(),
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

/** A peer with an undo stack over its own commits. */
class Stack {
  peer: UndoPeer
  undos: unknown[][] = []
  redos: unknown[][] = []
  #open: unknown[] | undefined
  #stop: () => void

  constructor(
    private readonly env: UndoTestEnv,
    peer: UndoPeer,
  ) {
    this.peer = peer
    this.#stop = this.#listen()
  }

  #listen(): () => void {
    return revertibleOf(this.peer).subscribeCommits(
      (commit: RevertibleCommit<unknown>) => {
        this.#open?.push(commit.record)
      },
    )
  }

  get doc(): any {
    return this.peer.doc
  }

  /** Run `fn` as one step. */
  step(fn: (d: any) => void): void {
    this.#open = []
    try {
      fn(this.doc)
    } finally {
      const records = this.#open
      this.#open = undefined
      if (records.length > 0) {
        this.undos.push(records)
        this.redos = []
      }
    }
  }

  #move(from: unknown[][], to: unknown[][]): boolean {
    const revertible = revertibleOf(this.peer)
    for (let parts = from.pop(); parts !== undefined; parts = from.pop()) {
      // Last first. Each revert's remap reaches every record still waiting,
      // in this step as in the others, before the next one reverts.
      const waiting = [...parts]
      const done: unknown[] = []
      for (let record = waiting.pop(); record !== undefined; ) {
        const result = revertible.revert(record, {})
        if (result !== null) {
          const remap: Remap = result.remap
          const rewrite = (step: unknown[]) =>
            step.map(r => revertible.rewrite(r, remap))
          done.push(result.redo)
          waiting.splice(0, waiting.length, ...rewrite(waiting))
          done.splice(0, done.length, ...rewrite(done))
          for (const list of [this.undos, this.redos]) {
            list.splice(0, list.length, ...list.map(rewrite))
          }
        }
        record = waiting.pop()
      }
      if (done.length > 0) {
        to.push(done)
        return true
      }
    }
    return false
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
    const bytes = (steps: unknown[][]) =>
      steps.map(step => step.map(r => codec.encode(r)))
    const undos = bytes(this.undos)
    const redos = bytes(this.redos)
    this.#stop()
    this.peer = this.env.reload(this.peer)
    const next = revertibleOf(this.peer).codec
    const back = (steps: Uint8Array[][]) =>
      steps.map(step => step.map(b => next.decode(b)))
    this.undos = back(undos)
    this.redos = back(redos)
    this.#stop = this.#listen()
  }
}

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
          s.step(d => d.cards.push({ name: "hi", done: false }))
          s.step(d => d.cards.at(0).name.insert(2, " there"))
          s.step(d => d.cards.delete(0, 1))
          settle(s)
          expect(s.undo()).toBe(true)
          expect(s.doc.cards()).toEqual([{ name: "hi there", done: false }])
          settle(s)
          expect(s.undo()).toBe(true)
          expect(s.doc.cards()).toEqual([{ name: "hi", done: false }])
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

        it("authoredSince is false before a revert and true after; recovered matches revert", () => {
          const s = new Stack(env, env.create())
          s.step(d => d.title.insert(0, "abc"))
          s.step(d => d.title.delete(0, 3)) // a delete-only step
          settle(s)
          const revertible = revertibleOf(s.peer)
          const record = s.undos.at(-1)?.[0]
          const position = revertible.position()
          expect(revertible.authoredSince(position)).toBe(false)
          const result = revertible.revert(record, {})
          expect(result).not.toBeNull()
          expect(revertible.authoredSince(position)).toBe(true)
          if (result === null) return
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

        if (sync !== undefined) {
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
