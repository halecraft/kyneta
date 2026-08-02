// reset-trigger — unit tests for the pure `classifyResetTrigger` classifier.
//
// This is the whole "is this offer a reset, and if so which kind?" decision
// that the Synchronizer gates on in `#executeImportDocData`. The branch it
// feeds sits in a private method that needs a full sync scenario to reach, so
// the decision is tested here as a pure function of plain values instead —
// which is why it was extracted from that method in the first place.
//
// Two properties matter beyond the individual rows:
//
//   1. The lineage trigger fires independent of payload shape. It reads only
//      the two lineage strings, so it fires on a `kind: "since"` offer just as
//      readily as on an entirety.
//   2. A transient snapshot-only document reaches NEITHER trigger. That is
//      what makes it safe for the reset path to rebuild the replica rather
//      than merge into it — see the replicate arm of `#executeImportDocData`.

import type { Durability } from "@kyneta/schema"
import { DEFAULT_LINEAGE } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { classifyResetTrigger } from "../synchronizer.js"

// The compaction trigger needs three facts beyond lineage. Default them to the
// combination that does NOT fire, so each test below varies only what it is
// about. `persistent` is the durable case (json / loro / yjs).
type CompactionFacts = {
  isEntirety: boolean
  senderAlreadySynced: boolean
  durability: Durability
}

const noCompaction: CompactionFacts = {
  isEntirety: false,
  senderAlreadySynced: false,
  durability: "persistent",
}

const classify = (
  local: string,
  remote: string,
  over: Partial<CompactionFacts> = {},
) => {
  const o = { ...noCompaction, ...over }
  return classifyResetTrigger(
    local,
    remote,
    o.isEntirety,
    o.senderAlreadySynced,
    o.durability,
  )
}

describe("classifyResetTrigger — lineage", () => {
  it("is none when both lineages match", () => {
    expect(classify("inc-a", "inc-a")).toBe("none")
  })

  it("is lineage when both are REAL and differ — no payload-kind input at all", () => {
    // Note what is NOT passed: this row leaves `isEntirety` false and still
    // classifies as a reset. That is the heuristic-bypass the identity
    // -discontinuity case requires — a writer that restarted with no store
    // must be detected even when its next offer happens to be a delta.
    expect(classify("inc-a", "inc-b")).toBe("lineage")
  })

  it("is none when local is DEFAULT_LINEAGE (normal lazy-mint/first-sync path)", () => {
    expect(classify(DEFAULT_LINEAGE, "inc-b")).toBe("none")
  })

  it("is none when remote is DEFAULT_LINEAGE", () => {
    expect(classify("inc-a", DEFAULT_LINEAGE)).toBe("none")
  })

  it("is none when both are DEFAULT_LINEAGE", () => {
    expect(classify(DEFAULT_LINEAGE, DEFAULT_LINEAGE)).toBe("none")
  })

  it("prefers lineage over compaction when both would fire", () => {
    // An identity discontinuity is the more specific diagnosis, and the two
    // arms behave identically downstream, so the order only affects the
    // reported trigger — but it should be the accurate one.
    expect(
      classify("inc-a", "inc-b", {
        isEntirety: true,
        senderAlreadySynced: true,
      }),
    ).toBe("lineage")
  })
})

describe("classifyResetTrigger — compaction", () => {
  const same = (over: Partial<typeof noCompaction>) =>
    classify(DEFAULT_LINEAGE, DEFAULT_LINEAGE, over)

  it("fires on an entirety from a peer we have already synced with", () => {
    expect(same({ isEntirety: true, senderAlreadySynced: true })).toBe(
      "compaction",
    )
  })

  it("does not fire on a since-delta — a history gap always arrives whole", () => {
    expect(same({ isEntirety: false, senderAlreadySynced: true })).toBe("none")
  })

  it("does not fire on a first entirety — that is initial sync, not a reset", () => {
    expect(same({ isEntirety: true, senderAlreadySynced: false })).toBe("none")
  })
})

describe("classifyResetTrigger — transient documents reach no trigger", () => {
  // The invariant the `ephemeral` target depends on. It holds for two
  // independent reasons living in two packages:
  //
  //   - durability excludes the compaction trigger — pinned below;
  //   - StateVersion reports DEFAULT_LINEAGE, which excludes the lineage
  //     trigger — pinned in @kyneta/schema's ephemeral-lattice suite.
  //
  // If either fact changes, the reset path would begin rebuilding a CvRDT
  // replica from a peer snapshot, silently dropping concurrent field writes
  // the sender had not seen. Both halves are asserted so that either change
  // fails loudly rather than converging wrongly.

  it("a steady-state presence push does not classify as a reset", () => {
    // The realistic shape: every ephemeral push is an entirety, and peers are
    // synced within milliseconds. Without the durability exclusion this would
    // classify as a compaction reset on every single message after the first.
    expect(
      classifyResetTrigger(
        DEFAULT_LINEAGE,
        DEFAULT_LINEAGE,
        true,
        true,
        "transient",
      ),
    ).toBe("none")
  })
})
