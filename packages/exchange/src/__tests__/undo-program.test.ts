// undo-program — the stack's decisions, as tables over `update`.

import {
  type Edit,
  jsonRecordCodec,
  type Tally,
  WHOLE_DOCUMENT,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import type { Direction, Note, Part, Step } from "../undo/schema.js"
import {
  COMPACT_EVERY,
  type OpenPart,
  type UndoEffect,
  type UndoInput,
  type UndoModel,
  undoProgram,
} from "../undo/undo-program.js"

const GAP = 1000
const program = undoProgram(GAP)

/** Records are strings; two compose unless the later starts with "!",
 *  which stands for a foreign change between them. */
const algebra: OpenPart["algebra"] = {
  compose: (a, b) =>
    String(b).startsWith("!") ? null : `${String(a)}+${String(b)}`,
  codec: jsonRecordCodec<unknown>(),
}

const meta = {
  schemaHash: "h",
  replicaType: ["yjs", 1, 0],
  syncMode: { writerModel: "concurrent", durability: "persistent" },
  footprint: WHOLE_DOCUMENT,
} as const

function open(docId: string, record: string): OpenPart {
  return { docId, ...meta, record, algebra }
}

function part(docId: string, record = "r"): Part {
  return { docId, ...meta, record }
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
  options: { docs?: readonly string[]; whole?: boolean } = {},
): UndoInput => ({
  type: "requested",
  request: {
    direction,
    options: {},
    docs: options.docs,
    whole: options.whole ?? false,
    token,
  },
})

const gesture = (
  ...commits: (readonly [string, string])[]
): readonly UndoInput[] => [
  { type: "gesture-opened" },
  ...commits.map(
    ([docId, record]): UndoInput => ({
      type: "commit",
      via: "gesture",
      part: open(docId, record),
      edit: undefined,
    }),
  ),
  { type: "gesture-closed" },
]

const typing = (docId: string, record: string, e: Edit): UndoInput => ({
  type: "commit",
  via: "typing",
  part: open(docId, record),
  edit: e,
})

/** Each pushed step, as its parts' documents and records. */
const pushes = (effects: readonly UndoEffect[]) =>
  effects.flatMap(e =>
    e.type === "push"
      ? [e.parts.map(p => `${p.docId}:${String(p.record)}`)]
      : [],
  )

const kinds = (effects: readonly UndoEffect[]) =>
  effects.map(e => e.type).filter(t => t !== "set-timer" && t !== "compact")

const t = (kept: number, total: number): Tally => ({ kept, total })

describe("grouping", () => {
  it("a gesture is one step, with one part per document", () => {
    const { effects } = run(gesture(["a", "1"], ["b", "2"], ["a", "3"]))
    expect(pushes(effects)).toEqual([["a:1+3", "b:2"]])
  })

  it("an empty gesture writes nothing", () => {
    const { effects } = run(gesture())
    expect(pushes(effects)).toEqual([])
  })

  it("a commit that cannot join splits a gesture, which stays open", () => {
    const { effects, model } = run([
      { type: "gesture-opened" },
      { type: "commit", via: "gesture", part: open("a", "1"), edit: undefined },
      { type: "commit", via: "gesture", part: open("b", "2"), edit: undefined },
      {
        type: "commit",
        via: "gesture",
        part: open("a", "!3"),
        edit: undefined,
      },
    ])
    expect(pushes(effects)).toEqual([["a:1", "b:2"]])
    expect(model.gesture).toBe(true)
    expect(model.open?.via).toBe("gesture")
    expect(model.open?.parts.map(p => p.record)).toEqual(["!3"])
    const closed = run(
      [
        {
          type: "commit",
          via: "gesture",
          part: open("b", "4"),
          edit: undefined,
        },
        { type: "gesture-closed" },
      ],
      model,
    )
    expect(pushes(closed.effects)).toEqual([["a:!3", "b:4"]])
  })

  it("typing joins while the policy says so, and a pause closes the step", () => {
    const { effects, model } = run([
      typing("a", "1", edit(0, 0, "h")),
      typing("a", "2", edit(100, 1, "i")),
      typing("a", "3", edit(200, 2, " ")),
      // A word after a space starts a step.
      typing("a", "4", edit(300, 3, "t")),
      { type: "gap-elapsed", at: 900 },
      { type: "gap-elapsed", at: 1300 },
    ])
    expect(pushes(effects)).toEqual([["a:1+2+3"], ["a:4"]])
    expect(model.open).toBeUndefined()
  })

  it("a keystroke whose record cannot join starts a step", () => {
    const { effects, model } = run([
      typing("a", "1", edit(0, 0, "h")),
      typing("a", "!2", edit(100, 1, "i")),
      typing("a", "3", edit(200, 2, "!")),
    ])
    expect(pushes(effects)).toEqual([["a:1"]])
    expect(model.open?.parts.map(p => p.record)).toEqual(["!2+3"])
  })

  it("typing never joins a step in another document", () => {
    const { effects } = run([
      typing("a", "1", edit(0, 0, "h")),
      // The same path, where the last edit ended: in another document.
      typing("b", "2", edit(100, 1, "i")),
      { type: "gap-elapsed", at: 1100 },
    ])
    expect(pushes(effects)).toEqual([["a:1"], ["b:2"]])
  })

  it("a request writes the open step first", () => {
    const { effects } = run([
      typing("a", "1", edit(0, 0, "h")),
      request("undo", 1),
    ])
    expect(kinds(effects)).toEqual(["push", "begin"])
  })
})

describe("an undo", () => {
  const step: Step = { id: "s", parts: [part("a"), part("b")] }
  const below: Step = { id: "t", parts: [part("c")] }

  it("notes, waits for the note, plans, applies, and says what it did", () => {
    const { effects, model } = run([
      { type: "loaded", pending: undefined },
      request("undo", 7),
      { type: "began", step },
      { type: "noted" },
      { type: "planned", step, tallies: [t(2, 2), t(0, 0)] },
    ])
    expect(kinds(effects)).toEqual([
      "begin",
      "note",
      "plan",
      "apply",
      "resolve",
    ])
    expect(effects.find(e => e.type === "note")).toMatchObject({ whole: false })
    expect(effects.at(-1)).toEqual({
      type: "resolve",
      token: 7,
      result: { kind: "undone", step, stale: [], dropped: [] },
    })
    expect(model.busy).toBeUndefined()
  })

  it("undoes a step that stands in part, naming its stale parts", () => {
    const { effects } = run([
      request("undo", 1),
      { type: "began", step },
      { type: "noted" },
      { type: "planned", step, tallies: [t(1, 1), t(1, 3)] },
    ])
    expect(effects.at(-1)).toEqual({
      type: "resolve",
      token: 1,
      result: { kind: "undone", step, stale: [step.parts[1]], dropped: [] },
    })
  })

  it("drops a step nothing of which stands, and tries the next for the same documents", () => {
    const { effects } = run([
      request("undo", 1, { docs: ["a"] }),
      { type: "began", step },
      { type: "noted" },
      { type: "planned", step, tallies: [t(0, 1), t(0, 2)] },
    ])
    expect(kinds(effects)).toEqual(["begin", "note", "plan", "drop", "begin"])
    expect(effects.filter(e => e.type === "begin")).toEqual([
      { type: "begin", direction: "undo", docs: ["a"] },
      { type: "begin", direction: "undo", docs: ["a"] },
    ])
  })

  it("names the steps it dropped on the way", () => {
    const { effects } = run([
      request("undo", 1),
      { type: "began", step },
      { type: "noted" },
      { type: "planned", step, tallies: [t(0, 1), t(0, 2)] },
      { type: "began", step: below },
      { type: "noted" },
      { type: "planned", step: below, tallies: [t(1, 1)] },
    ])
    expect(effects.at(-1)).toEqual({
      type: "resolve",
      token: 1,
      result: { kind: "undone", step: below, stale: [], dropped: [step] },
    })
    const none = run([
      request("undo", 2),
      { type: "began", step },
      { type: "noted" },
      { type: "planned", step, tallies: [t(0, 1), t(0, 2)] },
      { type: "began", step: undefined },
    ])
    expect(none.effects.at(-1)).toEqual({
      type: "resolve",
      token: 2,
      result: { kind: "none", dropped: [step] },
    })
  })

  it("drops a step of a part naming nothing beside a dead part, rather than undo it", () => {
    const { effects } = run([
      request("undo", 1),
      { type: "began", step },
      { type: "noted" },
      { type: "planned", step, tallies: [t(0, 0), t(0, 2)] },
    ])
    expect(kinds(effects)).toEqual(["begin", "note", "plan", "drop", "begin"])
  })

  it("with whole, refuses a step one part of which is short, and names it", () => {
    const { effects, model } = run([
      request("undo", 4, { whole: true }),
      { type: "began", step },
      { type: "noted" },
      { type: "planned", step, tallies: [t(2, 2), t(1, 2)] },
    ])
    expect(effects.find(e => e.type === "note")).toMatchObject({ whole: true })
    expect(kinds(effects)).toEqual(["begin", "note", "plan", "drop", "resolve"])
    expect(effects.at(-1)).toEqual({
      type: "resolve",
      token: 4,
      result: { kind: "refused", step, stale: [step.parts[1]] },
    })
    expect(model.busy).toBeUndefined()
  })

  it("with whole, undoes a step every part of which stands", () => {
    const { effects } = run([
      request("undo", 4, { whole: true }),
      { type: "began", step },
      { type: "noted" },
      { type: "planned", step, tallies: [t(2, 2), t(0, 0)] },
    ])
    expect(effects.at(-2)).toMatchObject({ type: "apply", step })
    expect(effects.at(-1)).toEqual({
      type: "resolve",
      token: 4,
      result: { kind: "undone", step },
    })
  })

  it("resolves none on an empty stack, in either mode", () => {
    expect(
      run([request("redo", 3), { type: "began", step: undefined }]).effects.at(
        -1,
      ),
    ).toEqual({
      type: "resolve",
      token: 3,
      result: { kind: "none", dropped: [] },
    })
    expect(
      run([
        request("redo", 3, { whole: true }),
        { type: "began", step: undefined },
      ]).effects.at(-1),
    ).toEqual({ type: "resolve", token: 3, result: { kind: "none" } })
  })

  it("runs requests one at a time", () => {
    const { effects } = run([request("undo", 1), request("undo", 2)])
    expect(effects.filter(e => e.type === "begin")).toHaveLength(1)
  })
})

describe("recovery", () => {
  const step: Step = { id: "s", parts: [part("a")] }
  const note = (whole: boolean): Note => ({
    step: "s",
    direction: "undo",
    whole,
    positions: {},
  })

  it("recovers a noted revert before anything else", () => {
    const { effects } = run([
      { type: "loaded", pending: note(false) },
      request("undo", 1),
      { type: "recovered" },
    ])
    expect(kinds(effects)).toEqual(["recover", "begin"])
  })

  it("decides a revert that never happened as its request would have", () => {
    const applied = run([
      { type: "loaded", pending: note(false) },
      request("undo", 1),
      { type: "planned", step, tallies: [t(1, 2)] },
    ])
    expect(kinds(applied.effects)).toEqual(["recover", "apply", "begin"])
    expect(applied.effects[1]).toEqual({
      type: "apply",
      step,
      direction: "undo",
      options: {},
    })
    const refused = run([
      { type: "loaded", pending: note(true) },
      { type: "planned", step, tallies: [t(1, 2)] },
    ])
    expect(kinds(refused.effects)).toEqual(["recover", "drop"])
    expect(refused.model.busy).toBeUndefined()
  })
})

describe("compaction", () => {
  it("compacts the undo document every so many writes", () => {
    const msgs: UndoInput[] = []
    for (let i = 0; i < COMPACT_EVERY; i++) msgs.push(...gesture(["a", "r"]))
    const { effects } = run(msgs)
    expect(effects.filter(e => e.type === "compact")).toHaveLength(1)
  })
})
