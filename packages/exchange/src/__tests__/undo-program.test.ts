// undo-program — the stack's decisions, as tables over `update`.

import type { Edit } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import type { Direction, Part } from "../undo/schema.js"
import {
  COMPACT_EVERY,
  type UndoEffect,
  type UndoInput,
  type UndoModel,
  undoProgram,
} from "../undo/undo-program.js"

const GAP = 1000
const program = undoProgram(GAP)

function part(docId: string, record = "r"): Part {
  return {
    docId,
    schemaHash: "h",
    replicaType: ["yjs", 1, 0],
    syncMode: { writerModel: "concurrent", durability: "persistent" },
    record,
  }
}

const edit = (at: number, index: number, inserted: string): Edit => ({
  path: "title",
  at,
  index,
  inserted,
  deleted: 0,
})

/** Run messages from the initial model; collect every effect. */
function run(
  msgs: readonly UndoInput[],
  from: UndoModel = program.init[0],
): { model: UndoModel; effects: UndoEffect[] } {
  let model = from
  const effects: UndoEffect[] = []
  for (const msg of msgs) {
    const [next, ...fx] = program.update(msg, model)
    model = next
    effects.push(...fx)
  }
  return { model, effects }
}

const request = (
  direction: Direction,
  token: number,
  docs?: readonly string[],
): UndoInput => ({
  type: "requested",
  request: { direction, options: {}, docs, token },
})

const pushes = (effects: readonly UndoEffect[]) =>
  effects.flatMap(e => (e.type === "push" ? [e.parts.map(p => p.record)] : []))

describe("grouping", () => {
  it("a gesture is one step, however many commits it makes", () => {
    const { effects } = run([
      { type: "gesture-opened" },
      { type: "commit", via: "gesture", part: part("a", "1"), edit: undefined },
      { type: "commit", via: "gesture", part: part("b", "2"), edit: undefined },
      { type: "gesture-closed" },
    ])
    expect(pushes(effects)).toEqual([["1", "2"]])
  })

  it("an empty gesture writes nothing", () => {
    const { effects } = run([
      { type: "gesture-opened" },
      { type: "gesture-closed" },
    ])
    expect(pushes(effects)).toEqual([])
  })

  it("typing joins while the policy says so, and a pause closes the step", () => {
    const { effects, model } = run([
      {
        type: "commit",
        via: "typing",
        part: part("a", "1"),
        edit: edit(0, 0, "h"),
      },
      {
        type: "commit",
        via: "typing",
        part: part("a", "2"),
        edit: edit(100, 1, "i"),
      },
      {
        type: "commit",
        via: "typing",
        part: part("a", "3"),
        edit: edit(200, 2, " "),
      },
      // A word after a space starts a step.
      {
        type: "commit",
        via: "typing",
        part: part("a", "4"),
        edit: edit(300, 3, "t"),
      },
      { type: "gap-elapsed", at: 900 },
      { type: "gap-elapsed", at: 1300 },
    ])
    expect(pushes(effects)).toEqual([["1", "2", "3"], ["4"]])
    expect(model.open).toBeUndefined()
  })

  it("typing never joins a step in another document", () => {
    const { effects } = run([
      {
        type: "commit",
        via: "typing",
        part: part("a", "1"),
        edit: edit(0, 0, "h"),
      },
      // The same path, where the last edit ended: in another document.
      {
        type: "commit",
        via: "typing",
        part: part("b", "2"),
        edit: edit(100, 1, "i"),
      },
      { type: "gap-elapsed", at: 1100 },
    ])
    expect(pushes(effects)).toEqual([["1"], ["2"]])
  })

  it("a request writes the open step first", () => {
    const { effects } = run([
      {
        type: "commit",
        via: "typing",
        part: part("a", "1"),
        edit: edit(0, 0, "h"),
      },
      request("undo", 1),
    ])
    const kinds = effects.map(e => e.type).filter(t => t !== "set-timer")
    expect(kinds).toEqual(["push", "begin"])
  })
})

describe("an undo", () => {
  const step = { id: "s", parts: [part("a")] }

  it("notes, waits for the note, reverts, resolves", () => {
    const { effects, model } = run([
      { type: "loaded", pending: undefined },
      request("undo", 7),
      { type: "began", step },
      { type: "noted" },
      { type: "reverted", applied: true },
    ])
    expect(effects.map(e => e.type)).toEqual([
      "begin",
      "note",
      "revert",
      "resolve",
    ])
    expect(effects.at(-1)).toEqual({ type: "resolve", token: 7, done: true })
    expect(model.busy).toBeUndefined()
  })

  it("skips a step nothing of which still stands, silently", () => {
    const { effects } = run([
      request("undo", 1),
      { type: "began", step },
      { type: "noted" },
      { type: "reverted", applied: false },
    ])
    expect(effects.map(e => e.type)).toEqual([
      "begin",
      "note",
      "revert",
      "begin",
    ])
  })

  it("takes the documents asked for, and keeps them when a step is skipped", () => {
    const begins = (effects: readonly UndoEffect[]) =>
      effects.filter(e => e.type === "begin")
    const { effects } = run([
      request("undo", 1, ["x"]),
      { type: "began", step },
      { type: "noted" },
      { type: "reverted", applied: false },
    ])
    expect(begins(effects)).toEqual([
      { type: "begin", direction: "undo", docs: ["x"] },
      { type: "begin", direction: "undo", docs: ["x"] },
    ])
  })

  it("resolves false on an empty stack", () => {
    const { effects } = run([
      request("redo", 3),
      { type: "began", step: undefined },
    ])
    expect(effects.at(-1)).toEqual({ type: "resolve", token: 3, done: false })
  })

  it("runs requests one at a time", () => {
    const { effects } = run([request("undo", 1), request("undo", 2)])
    expect(effects.filter(e => e.type === "begin")).toHaveLength(1)
  })

  it("recovers a noted revert before anything else", () => {
    const note = { step: "s", direction: "undo" as const, positions: {} }
    const { effects } = run([
      { type: "loaded", pending: note },
      request("undo", 1),
      { type: "recovered" },
    ])
    expect(effects.map(e => e.type)).toEqual(["recover", "begin"])
  })
})

describe("compaction", () => {
  it("compacts the undo document every so many writes", () => {
    const msgs: UndoInput[] = []
    for (let i = 0; i < COMPACT_EVERY; i++) {
      msgs.push(
        { type: "gesture-opened" },
        { type: "commit", via: "gesture", part: part("a"), edit: undefined },
        { type: "gesture-closed" },
      )
    }
    const { effects } = run(msgs)
    expect(effects.filter(e => e.type === "compact")).toHaveLength(1)
  })
})
