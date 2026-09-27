// A PeerID past 2^53, beyond what a JS number holds exactly, survives updates
// and versions. Loro's PeerID is a u64, carried as a decimal string.
//
// Choosing the wide id also pins the width: with 64 bits, all 64 ids fall at
// or below 2^53 with probability ~2^-704.

import {
  createDocAs,
  exportEntirety,
  exportSince,
  merge,
  Schema,
  unwrap,
  version,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { loro, loroPeerId } from "../bind-loro.js"

const TextDoc = Schema.struct({ title: Schema.text() })

const PEER_IDS = Array.from({ length: 64 }, (_, i) => `peer-${i}`)

describe("a PeerID wider than 53 bits", () => {
  it("round-trips through updates and versions", () => {
    const wide = PEER_IDS.find(id => BigInt(loroPeerId(id)) > 2n ** 53n)
    if (wide === undefined) throw new Error("no id in the list exceeds 2^53")
    const bound = loro.bind(TextDoc)

    const a = createDocAs(wide, bound)
    a.title.insert(0, "hello")
    const b = createDocAs("peer-other", bound, exportEntirety(a))
    expect(unwrap(a).peerIdStr).toBe(loroPeerId(wide))

    a.title.insert(5, " world")
    b.title.insert(0, ">")
    const fromA = exportSince(a, version(b))
    const fromB = exportSince(b, version(a))
    if (fromA === null || fromB === null) throw new Error("delta unavailable")
    merge(b, fromA)
    merge(a, fromB)

    expect(a.title()).toBe(">hello world")
    expect(b.title()).toBe(a.title())
    expect(unwrap(b).oplogVersion().toJSON().has(loroPeerId(wide))).toBe(true)

    const factory = bound.factory({
      peerId: "peer-reader",
      binding: bound.identityBinding,
    })
    const parsed = factory.parseVersion(version(b).serialize())
    expect(parsed.compare(version(a))).toBe("equal")
    expect(parsed.compare(version(b))).toBe("equal")
  })
})
