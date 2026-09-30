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
          { kind: "text", was: "hello world", now: "> hello world" },
        ),
      ],
    )
    expect(group).toEqual([
      [text, { type: "text", diff: [{ retain: 7 }, { delete: 6 }] }],
    ])
  })

  it("takes an inverse unchanged when what changed since is a restore of the same text", () => {
    const group = planLoroRevert(
      [],
      [
        part(
          text,
          { type: "text", diff: [{ retain: 5 }, { delete: 6 }] },
          { kind: "text", was: "hello world", now: "hello world" },
        ),
      ],
    )
    expect(group).toEqual([
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
    expect(plan("column")).toEqual([
      [map, { type: "map", updated: { place: "drawer" } }],
    ])
    expect(plan("queue")).toBeNull()
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
    expect(plan("2@1")?.[0]?.[1]).toMatchObject({
      diff: [{ target: "9@1", parent: "0@1" }],
    })
    expect(plan("3@1")).toBeNull()
  })

  it("passes a gone container's inverse through, and skips one not there at the time", () => {
    const diff: Diff = { type: "text", diff: [{ insert: "x" }] }
    expect(planLoroRevert([], [part(text, diff, { kind: "gone" })])).toEqual([
      [text, diff],
    ])
    expect(
      planLoroRevert([], [part(text, diff, { kind: "unknown" })]),
    ).toBeNull()
  })
})
