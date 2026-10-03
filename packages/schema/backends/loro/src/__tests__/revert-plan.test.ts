// revert-plan — a Loro revert's decisions, on hand-built gathered state.

import type { ContainerID, Diff } from "loro-crdt"
import { describe, expect, it } from "vitest"
import { type LoroGathered, planLoroRevert } from "../revertible.js"

const text = "cid:root-t:Text" as ContainerID
const map = "cid:root-m:Map" as ContainerID
const tree = "cid:root-tree:Tree" as ContainerID

const part = (
  cid: ContainerID,
  diff: Diff,
  state: LoroGathered["state"],
): LoroGathered => ({ to: cid, diff, state })

describe("planLoroRevert", () => {
  it("rebases a text inverse over what changed since, by content", () => {
    // The step inserted " world" into "hello"; a peer then typed "> " first.
    const group = planLoroRevert(
      [],
      [
        part(
          text,
          { type: "text", diff: [{ retain: 5 }, { delete: 6 }] },
          { kind: "text", was: "hello world", now: "> hello world", marks: [] },
        ),
      ],
    )
    expect(group).toEqual({
      tally: { kept: 6, total: 6 },
      group: [[text, { type: "text", diff: [{ retain: 7 }, { delete: 6 }] }]],
    })
  })

  it("counts what a peer deleted of my insert as lost, and deletes the rest", () => {
    // The step typed "hello"; a peer then deleted "ll".
    const plan = planLoroRevert(
      [],
      [
        part(
          text,
          { type: "text", diff: [{ delete: 5 }] },
          { kind: "text", was: "hello", now: "heo", marks: [] },
        ),
      ],
    )
    expect(plan).toEqual({
      tally: { kept: 3, total: 5 },
      group: [[text, { type: "text", diff: [{ delete: 3 }] }]],
    })
  })

  it("keeps a restore of what a step replaced, though a peer deleted what it wrote", () => {
    // The step replaced "abc" with "xyz"; a peer then deleted "xyz".
    const plan = planLoroRevert(
      [],
      [
        part(
          text,
          { type: "text", diff: [{ delete: 3 }, { insert: "abc" }] },
          { kind: "text", was: "xyz", now: "", marks: [] },
        ),
      ],
    )
    expect(plan).toEqual({
      tally: { kept: 3, total: 6 },
      group: [[text, { type: "text", diff: [{ insert: "abc" }] }]],
    })
  })

  it("leaves out a rebase that only retains, and counts it lost", () => {
    const plan = planLoroRevert(
      [],
      [
        part(
          text,
          { type: "text", diff: [{ retain: 1 }, { delete: 2 }] },
          { kind: "text", was: "abc", now: "a", marks: [] },
        ),
      ],
    )
    expect(plan).toEqual({ tally: { kept: 0, total: 2 }, group: [] })
  })

  it("drops a format that changes nothing at the time, so it names nothing", () => {
    // "hello" was never bold; Loro reports unbolding it all the same.
    const plan = planLoroRevert(
      [],
      [
        part(
          text,
          {
            type: "text",
            diff: [
              { retain: 2, attributes: { bold: null } },
              { retain: 3, attributes: { bold: true } },
            ],
          },
          {
            kind: "text",
            was: "hello",
            now: "hello",
            marks: [{}, {}, { bold: true }, {}, {}],
          },
        ),
      ],
    )
    expect(plan).toEqual({
      tally: { kept: 2, total: 2 },
      group: [
        [
          text,
          {
            type: "text",
            diff: [{ retain: 3 }, { retain: 2, attributes: { bold: true } }],
          },
        ],
      ],
    })
  })

  it("names nothing for an empty inverse", () => {
    expect(planLoroRevert([], [])).toEqual({
      tally: { kept: 0, total: 0 },
      group: [],
    })
  })

  it("takes an inverse unchanged when what changed since is a restore of the same text", () => {
    const group = planLoroRevert(
      [],
      [
        part(
          text,
          { type: "text", diff: [{ retain: 5 }, { delete: 6 }] },
          { kind: "text", was: "hello world", now: "hello world", marks: [] },
        ),
      ],
    )
    expect(group.group).toEqual([
      [text, { type: "text", diff: [{ retain: 5 }, { delete: 6 }] }],
    ])
  })

  it("restores a map key only while it holds what the step left there", () => {
    const plan = (now: string) =>
      planLoroRevert(
        [],
        [
          part(
            map,
            { type: "map", updated: { place: "drawer" } },
            { kind: "map", was: { place: "column" }, now: { place: now } },
          ),
        ],
      )
    expect(plan("column")).toEqual({
      tally: { kept: 1, total: 1 },
      group: [[map, { type: "map", updated: { place: "drawer" } }]],
    })
    expect(plan("queue")).toEqual({ tally: { kept: 0, total: 1 }, group: [] })
  })

  it("moves a node back only while it is where the step put it, through aliases", () => {
    const move = {
      type: "tree",
      diff: [
        {
          target: "1@1",
          action: "move",
          parent: "0@1",
          index: 0,
          fractionalIndex: "80",
          oldParent: "2@1",
          oldIndex: 0,
        },
      ],
    } as Diff
    const plan = (parent: string) =>
      planLoroRevert(
        [{ from: "1@1", to: "9@1" }],
        [
          part(tree, move, {
            kind: "tree",
            nodes: {
              "1@1": { live: true, parent: parent as never, placed: "2@1" },
            },
          }),
        ],
      )
    expect(plan("2@1").tally).toEqual({ kept: 1, total: 1 })
    expect(plan("2@1").group[0]?.[1]).toMatchObject({
      diff: [{ target: "9@1", parent: "0@1" }],
    })
    expect(plan("3@1")).toEqual({ tally: { kept: 0, total: 1 }, group: [] })
  })

  it("keeps a gone container only where a restore in the group re-creates it", () => {
    const list = "cid:root-l:List" as ContainerID
    const inner = "cid:0@1:Text" as ContainerID
    const diff: Diff = { type: "text", diff: [{ insert: "xy" }] }
    // Gone for good: nothing re-creates it.
    expect(planLoroRevert([], [part(inner, diff, { kind: "gone" })])).toEqual({
      tally: { kept: 0, total: 2 },
      group: [],
    })
    // Re-created by the list item a restore inserts.
    const restore = {
      type: "list",
      diff: [{ insert: [{ id: inner, kind: () => "Text" }] }],
    } as unknown as Diff
    const plan = planLoroRevert(
      [],
      [
        part(list, restore, { kind: "list", was: [], now: [] }),
        part(inner, diff, { kind: "gone" }),
      ],
    )
    expect(plan.tally).toEqual({ kept: 3, total: 3 })
    expect(plan.group.map(([cid]) => cid)).toEqual([list, inner])
  })

  it("keeps nothing of a container that was not there at the time", () => {
    const diff: Diff = { type: "text", diff: [{ insert: "x" }] }
    expect(planLoroRevert([], [part(text, diff, { kind: "unknown" })])).toEqual(
      { tally: { kept: 0, total: 1 }, group: [] },
    )
  })

  it("counts a counter as one unit, always kept", () => {
    const counter = "cid:root-c:Counter" as ContainerID
    const diff = { type: "counter", increment: -2 } as Diff
    expect(
      planLoroRevert([], [part(counter, diff, { kind: "other" })]),
    ).toEqual({ tally: { kept: 1, total: 1 }, group: [[counter, diff]] })
  })
})
