// import-plan — the pure decisions behind taking in an offer: `planImport`
// (what to do with it) and `reportImport` (what doing it achieved).
//
// The Synchronizer gathers the facts, runs the plan, does the one thing it
// names, and reports. Both decisions are functions of plain values, so every
// row is tested here without standing up a Synchronizer.

import {
  DEFAULT_LINEAGE,
  ephemeralReplicaFactory,
  PlainVersion,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import {
  type ImportFacts,
  planImport,
  reportImport,
  type VersionGapResult,
} from "../synchronizer.js"

const gap: VersionGapResult = {
  kind: "gap",
  comparison: "ahead",
  parsed: new PlainVersion(3, "L"),
}

const facts = (over: Partial<ImportFacts> = {}): ImportFacts => ({
  gap,
  resetTrigger: "none",
  resetPermitted: false,
  payloadKind: "since",
  ...over,
})

describe("planImport", () => {
  it("does nothing with a version it cannot read", () => {
    expect(
      planImport(
        facts({ gap: { kind: "parse-error", error: new Error("x") } }),
      ),
    ).toBe("unreadable")
  })

  it("holds an offer at or below our version already", () => {
    expect(
      planImport(facts({ gap: { kind: "no-gap", comparison: "equal" } })),
    ).toBe("already-held")
    expect(
      planImport(facts({ gap: { kind: "no-gap", comparison: "behind" } })),
    ).toBe("already-held")
    expect(planImport(facts({ gap: { kind: "absent" } }))).toBe("already-held")
  })

  it("merges an ordinary offer, whatever its payload", () => {
    for (const payloadKind of ["since", "entirety"] as const) {
      expect(planImport(facts({ payloadKind }))).toBe("merge")
    }
  })

  it("refuses a reset the policy vetoes, whatever its payload", () => {
    for (const resetTrigger of ["lineage", "compaction"] as const) {
      for (const payloadKind of ["since", "entirety"] as const) {
        expect(
          planImport(
            facts({ resetTrigger, resetPermitted: false, payloadKind }),
          ),
        ).toBe("refused")
      }
    }
  })

  it("asks for the whole document when a permitted reset arrives as a delta", () => {
    expect(
      planImport(
        facts({
          resetTrigger: "lineage",
          resetPermitted: true,
          payloadKind: "since",
        }),
      ),
    ).toBe("ask-whole")
  })

  it("resets from a permitted whole document, for either trigger", () => {
    for (const resetTrigger of ["lineage", "compaction"] as const) {
      expect(
        planImport(
          facts({
            resetTrigger,
            resetPermitted: true,
            payloadKind: "entirety",
          }),
        ),
      ).toBe("reset")
    }
  })
})

describe("reportImport", () => {
  const at = (n: number) => new PlainVersion(n, "L")
  const genesis = new PlainVersion(0, DEFAULT_LINEAGE)
  const report = (
    plan: "ask-whole" | "reset" | "merge",
    prior: PlainVersion,
    after: PlainVersion,
    offered: PlainVersion,
    historyFree = false,
  ) => reportImport({ plan, prior, after, offered, historyFree })

  it("a merge that reaches the offer is held, and changed iff our version moved", () => {
    expect(report("merge", at(2), at(3), at(3))).toEqual({
      changed: true,
      held: true,
    })
    expect(report("merge", at(5), at(5), at(3))).toEqual({
      changed: false,
      held: true,
    })
  })

  it("a merge that leaves us short of the offer is not held", () => {
    expect(report("merge", genesis, genesis, at(3))).toEqual({
      changed: false,
      held: false,
    })
    expect(report("merge", at(1), at(2), at(3))).toEqual({
      changed: true,
      held: false,
    })
  })

  it("a reset changed the state, and is held when it reaches the offer", () => {
    expect(report("reset", at(9), at(3), at(3))).toEqual({
      changed: true,
      held: true,
    })
  })

  it("asking for the whole document changed nothing and holds nothing", () => {
    expect(report("ask-whole", at(2), at(2), at(3))).toEqual({
      changed: false,
      held: false,
    })
  })

  it("a history-free merge that moved nothing is not a change, though its counter compares concurrent with itself", () => {
    // Reported as a change, it would be relayed, and in a mesh of three the
    // relays never stop.
    const counter = (s: string) => ephemeralReplicaFactory.parseVersion(s)
    expect(counter("i:3").compare(counter("i:3"))).toBe("concurrent")
    expect(
      reportImport({
        plan: "merge",
        prior: counter("i:3"),
        after: counter("i:3"),
        offered: counter("j:9"),
        historyFree: true,
      }),
    ).toEqual({ changed: false, held: true })
  })

  it("a history-free document's merge is held, since its versions do not compare across replicas", () => {
    expect(
      report("merge", at(1), at(1), new PlainVersion(4, "M"), true),
    ).toEqual({
      changed: false,
      held: true,
    })
  })
})
