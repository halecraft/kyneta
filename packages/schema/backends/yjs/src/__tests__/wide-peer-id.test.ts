// A clientID past 2^32, where Yjs's own random ids stop, survives updates,
// state vectors and versions. A codec that truncated it would corrupt them
// silently.
//
// Choosing the wide id also pins the width: with 53 bits, all 64 ids fall at
// or below 2^32 with probability ~2^-1344.

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
import * as Y from "yjs"
import { yjs, yjsClientId } from "../bind-yjs.js"

const TextDoc = Schema.struct({ title: Schema.text() })

const PEER_IDS = Array.from({ length: 64 }, (_, i) => `peer-${i}`)

describe("a clientID wider than 32 bits", () => {
  it("round-trips through updates, state vectors and versions", () => {
    const wide = PEER_IDS.find(id => yjsClientId(id) > 2 ** 32)
    if (wide === undefined) throw new Error("no id in the list exceeds 2^32")
    const bound = yjs.bind(TextDoc)

    const a = createDocAs(wide, bound)
    a.title.insert(0, "hello")
    const b = createDocAs("peer-other", bound, exportEntirety(a))
    expect((unwrap(a) as Y.Doc).clientID).toBe(yjsClientId(wide))

    a.title.insert(5, " world")
    b.title.insert(0, ">")
    const fromA = exportSince(a, version(b))
    const fromB = exportSince(b, version(a))
    if (fromA === null || fromB === null) throw new Error("delta unavailable")
    merge(b, fromA)
    merge(a, fromB)

    expect(a.title()).toBe(">hello world")
    expect(b.title()).toBe(a.title())
    const clocks = Y.decodeStateVector(Y.encodeStateVector(unwrap(b) as Y.Doc))
    expect(clocks.has(yjsClientId(wide))).toBe(true)

    const factory = bound.factory({
      peerId: "peer-reader",
      binding: bound.identityBinding,
    })
    const parsed = factory.parseVersion(version(b).serialize())
    expect(parsed.compare(version(a))).toBe("equal")
    expect(parsed.compare(version(b))).toBe("equal")
  })
})
