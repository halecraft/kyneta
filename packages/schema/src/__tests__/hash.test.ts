// peerNumber — the persistence commitment behind every Yjs clientID and Loro
// PeerID. A stored peer id maps to the same number on every run, so these fixed
// vectors fail before a change to the hash, the width, the reservation or the
// byte encoding can give stored peers a new identity.

import { peerNumber } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
// reservePeerNumber is internal — imported from source, NOT the public barrel.
import { reservePeerNumber } from "../hash.js"

const LOW_53 = 2n ** 53n - 1n

const PEER_IDS = Array.from({ length: 64 }, (_, i) => `peer-${i}`)

describe("peerNumber", () => {
  it("is FNV-1a-64 of the UTF-8 bytes (published vector for 'a')", () => {
    expect(peerNumber("a", 64)).toBe(0xaf63dc4c8601ec8cn)
    expect(peerNumber("a", 53)).toBe(0xaf63dc4c8601ec8cn & LOW_53)
  })

  it("hashes UTF-8 bytes, not UTF-16 code units", () => {
    // Over the one UTF-16 code unit 0xe9 the hash would be 0xaf64644c8602d3a4.
    expect(peerNumber("\u00e9", 64)).toBe(0x0ac21707b7181e01n)
    expect(peerNumber("\u00e9", 53)).toBe(0x0ac21707b7181e01n & LOW_53)
  })

  it("the 53-bit number is a non-zero prefix of the 64-bit one", () => {
    for (const id of PEER_IDS) {
      const n53 = peerNumber(id, 53)
      expect(n53).not.toBe(0n)
      expect(n53 < 2n ** 53n).toBe(true)
      expect(n53).toBe(peerNumber(id, 64) & LOW_53)
    }
  })
})

describe("reservePeerNumber", () => {
  it("sets bit 0 when the low 53 bits are all zero", () => {
    expect(reservePeerNumber(2n ** 53n * 5n)).toBe(2n ** 53n * 5n + 1n)
  })

  it("leaves a hash with any low bit set unchanged", () => {
    expect(reservePeerNumber(2n ** 53n * 5n + 2n ** 52n)).toBe(
      2n ** 53n * 5n + 2n ** 52n,
    )
    expect(reservePeerNumber(0xaf63dc4c8601ec8cn)).toBe(0xaf63dc4c8601ec8cn)
  })
})
