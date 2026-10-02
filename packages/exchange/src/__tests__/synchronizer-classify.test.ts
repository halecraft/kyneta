// synchronizer-classify — unit tests for the pure `transitionForPeerVersion`
// decision.
//
// This is the whole of "what does a peer's version tell us about them?" — the
// step that turns a version comparison into a `synced` transition, or into
// nothing. Both the offer path and the interest path ask it, through the
// Synchronizer's `#classifyPeer`, and that method needs a doc runtime to
// reach. The decision itself takes plain values, so it is tested here without
// one — the same shape as `reset-trigger.test.ts` for `classifyResetTrigger`.
//
// The property that matters beyond the rows: `synced` means "nothing left to
// receive from this peer", and every way of getting there goes through this
// function. A peer that is ahead, or whose version we cannot read, must not
// be assumed synced — because the reconciliation latch that `whenSettled`
// reads is recorded on that transition, and assuming it early is exactly the
// bug this replaced.

import { ephemeralReplicaFactory } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import {
  compareHoldings,
  transitionForPeerVersion,
  type VersionGapResult,
} from "../synchronizer.js"

const noGap = (comparison: "behind" | "equal"): VersionGapResult => ({
  kind: "no-gap",
  comparison,
})
const gap = (comparison: "ahead" | "concurrent"): VersionGapResult => ({
  kind: "gap",
  comparison,
  parsed: {} as never, // never read by the decision
})
const parseError: VersionGapResult = {
  kind: "parse-error",
  error: new Error("unreadable"),
}

describe("transitionForPeerVersion", () => {
  it("marks a peer behind us synced, recording its version", () => {
    // The server's view of a fresh client: its genesis version is behind, so
    // after we send our offer there is nothing to receive. This is the timing
    // the old interest shortcut delivered, now as a tested decision.
    expect(
      transitionForPeerVersion(noGap("behind"), "d", "client", "g:0"),
    ).toEqual({
      type: "sync/peer-synced",
      docId: "d",
      peerId: "client",
      version: "g:0",
    })
  })

  it("marks a peer at our version synced", () => {
    // Reconnect at equal versions: no offer round trip is needed to settle.
    expect(transitionForPeerVersion(noGap("equal"), "d", "p", "v1")).toEqual({
      type: "sync/peer-synced",
      docId: "d",
      peerId: "p",
      version: "v1",
    })
  })

  it("marks a peer that sent no version synced, with an empty version", () => {
    // `InterestMsg.version` is optional and the wire decoder omits it when
    // the frame carries none. A peer that cannot state a version holds
    // nothing we need. `""` is already a value the model holds for this
    // case, and the lowest-common-version computation skips entries that do
    // not parse, so it is safe downstream.
    expect(
      transitionForPeerVersion({ kind: "absent" }, "d", "p", undefined),
    ).toEqual({
      type: "sync/peer-synced",
      docId: "d",
      peerId: "p",
      version: "",
    })
  })

  it("leaves a peer that is ahead pending — its offer is coming", () => {
    // The client's view of its authority. This is the row the bug lived on:
    // the authority's interest arrived before its offer, and the client
    // marked it synced anyway.
    expect(
      transitionForPeerVersion(gap("ahead"), "d", "auth", "a:54"),
    ).toBeNull()
  })

  it("leaves a concurrent peer pending", () => {
    expect(
      transitionForPeerVersion(gap("concurrent"), "d", "p", "v"),
    ).toBeNull()
  })

  it("leaves a peer whose version cannot be read pending", () => {
    // Not assumed either way. The caller warns; the state stays honest.
    expect(transitionForPeerVersion(parseError, "d", "p", "??")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// compareHoldings — how a peer's holding stands against ours
// ---------------------------------------------------------------------------

describe("compareHoldings", () => {
  // Ephemeral versions: an install counter can only ever say "concurrent",
  // which is the case the digest exists for.
  const ours = (digest: string | undefined) => ({
    version: ephemeralReplicaFactory.parseVersion("ours:3"),
    digest,
  })
  const theirs = (digest: string | undefined) => ({
    version: ephemeralReplicaFactory.parseVersion("theirs:5"),
    digest,
  })
  const cases: readonly [
    string,
    string | undefined,
    string | undefined,
    "equal" | "concurrent",
  ][] = [
    ["equal digests say equal, whatever the versions say", "d1", "d1", "equal"],
    ["different digests leave it to the versions", "d1", "d2", "concurrent"],
    [
      "no digest of ours leaves it to the versions",
      undefined,
      "d1",
      "concurrent",
    ],
    [
      "no digest of theirs leaves it to the versions",
      "d1",
      undefined,
      "concurrent",
    ],
    [
      "no digests at all leave it to the versions",
      undefined,
      undefined,
      "concurrent",
    ],
  ]
  for (const [name, ourDigest, theirDigest, expected] of cases) {
    it(name, () => {
      expect(compareHoldings(ours(ourDigest), theirs(theirDigest))).toBe(
        expected,
      )
    })
  }
})
