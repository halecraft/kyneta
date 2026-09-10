// === The one place the two packages meet at the type level ===
//
// `@kyneta/datalog` declares its own `ValueRef` — `{ peer: string; counter: number }`
// — and the kernel declares `CnId` with the same shape. Neither imports the other.
// The spec's `ref(CnId)` value (theory/unified-engine.md §3) is therefore a Datalog
// `Value` by structure alone, which is what let the evaluator become its own package
// without giving up a compiler-checked value domain.
//
// That works only while the field names agree. Rename `peer` or `counter` on either
// side and this file stops compiling — which is the entire point of it.
//
// Note what is *not* tested here: dereferencing. `ref` is the spec's bridge for
// nesting a subtree under a map slot, and the skeleton builder does not follow one
// yet. The seat is reserved; the feature is not built.

import type { Value } from "@kyneta/datalog"
import { compareValues, serializeValue } from "@kyneta/datalog"
import { describe, expect, it } from "vitest"
import { createCnId } from "../../src/kernel/cnid.js"
import type { CnId } from "../../src/kernel/types.js"

describe("CnId satisfies the Datalog value domain", () => {
  it("a { ref: CnId } is a Value with no cast", () => {
    const id: CnId = createCnId("alice", 3)
    // No `as`, no conversion: if this assignment needs one, the contract is broken.
    const value: Value = { ref: id }
    expect(value).toEqual({ ref: { peer: "alice", counter: 3 } })
  })

  it("serializes to the frozen ref key format", () => {
    const value: Value = { ref: createCnId("alice", 3) }
    // `r:` is the type tag that keeps a ref from colliding with the string
    // "alice:3". The format is pinned by @kyneta/datalog's own types test; this
    // asserts the kernel's CnId reaches it unchanged.
    expect(serializeValue(value)).toBe("r:alice:3")
  })

  it("orders refs by peer, then numerically by counter", () => {
    // Ordering is the engine's choice, not the spec's — §3 mandates only that
    // int and float stay distinct. It matters because a rule can compare two
    // refs with a guard, and the counter is compared as a *number*: flattening
    // a ref to the string "alice:10" would sort it before "alice:3".
    const lo: Value = { ref: createCnId("alice", 3) }
    const hi: Value = { ref: createCnId("alice", 10) }
    const other: Value = { ref: createCnId("bob", 1) }

    expect(compareValues(lo, hi)).toBeLessThan(0)
    expect(compareValues(hi, lo)).toBeGreaterThan(0)
    expect(compareValues(lo, lo)).toBe(0)
    expect(compareValues(hi, other)).toBeLessThan(0)

    // The serialized keys, by contrast, are identities and not ordered: sorting
    // them lexicographically does put counter 10 first. Nothing may rely on it.
    expect([hi, lo].map(serializeValue).sort()).toEqual([
      "r:alice:10",
      "r:alice:3",
    ])
  })
})
