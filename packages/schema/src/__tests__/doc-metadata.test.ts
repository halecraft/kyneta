// doc-metadata.test.ts — the two schema-compatibility laws, as a truth table.
//
// These are the cheapest tests in the codebase and among the most load-bearing:
// four call sites across @kyneta/exchange decide whether a document may be
// interpreted or synced by asking one of these two functions, and the two
// answers are deliberately different.

import { describe, expect, it } from "vitest"
import type { DocMetadata, ReadCapability, ReplicaType } from "../index.js"
import {
  mismatchForInterpretation,
  mismatchForSync,
  SYNC_AUTHORITATIVE,
  SYNC_COLLABORATIVE,
} from "../index.js"

const PLAIN: ReplicaType = ["plain", 1, 0]

/** A document written at `schemaHash`, in the plain format, authoritative. */
function doc(schemaHash: string, over: Partial<DocMetadata> = {}): DocMetadata {
  return {
    replicaType: PLAIN,
    syncMode: SYNC_AUTHORITATIVE,
    schemaHash,
    ...over,
  }
}

/** A peer whose schema is at `hashes[0]` and can also read `hashes[1..]`. */
function reader(
  hashes: readonly string[],
  over: Partial<DocMetadata> = {},
): ReadCapability {
  return { ...doc(hashes[0] as string, over), supportedHashes: [...hashes] }
}

describe("the shared axes — same law for both questions", () => {
  it("names replicaType when the format differs", () => {
    const m = mismatchForInterpretation(
      reader(["h1"]),
      doc("h1", {
        replicaType: ["loro", 1, 0],
      }),
    )
    expect(m?.axis).toBe("replicaType")
  })

  it("tolerates a minor-version drift, rejects a major one", () => {
    const minor = mismatchForInterpretation(
      reader(["h1"]),
      doc("h1", { replicaType: ["plain", 1, 7] }),
    )
    expect(minor).toBeUndefined()

    const major = mismatchForInterpretation(
      reader(["h1"]),
      doc("h1", { replicaType: ["plain", 2, 0] }),
    )
    expect(major?.axis).toBe("replicaType")
  })

  it("compares all three syncMode fields, not just writerModel", () => {
    // SYNC_AUTHORITATIVE and this differ only in `durability`. This is exactly
    // the pair that `replicaKey` bucketing in @kyneta/exchange collapses into
    // one key, which is why that lookup needs verifying against this law.
    const m = mismatchForInterpretation(
      reader(["h1"]),
      doc("h1", {
        syncMode: { ...SYNC_AUTHORITATIVE, durability: "transient" },
      }),
    )
    expect(m?.axis).toBe("syncMode")
  })

  it("reports replicaType first when several axes disagree", () => {
    // Order matters for the human reading the error: if the bytes cannot be
    // decoded at all, a schema-hash complaint points at the wrong problem.
    const m = mismatchForInterpretation(
      reader(["h1"]),
      doc("h2", { replicaType: ["loro", 1, 0], syncMode: SYNC_COLLABORATIVE }),
    )
    expect(m?.axis).toBe("replicaType")
  })
})

describe("interpretation — directional membership", () => {
  it("a newer reader can take on an older document", () => {
    // V2 migrated from V1, so its supportedHashes reaches back to h1.
    expect(
      mismatchForInterpretation(reader(["h2", "h1"]), doc("h1")),
    ).toBeUndefined()
  })

  it("an older reader cannot take on a newer document", () => {
    // The asymmetry is the point: migration chains are walked backwards only.
    const m = mismatchForInterpretation(reader(["h1"]), doc("h2"))
    expect(m?.axis).toBe("schemaHash")
    expect(m?.local).toBe("h1")
    expect(m?.remote).toBe("h2")
  })

  it("a schema with no migrations reads its own shape", () => {
    // The set always contains the schema's own hash, so a schema that has
    // never migrated degrades to plain equality. The refusal half of this is
    // covered by the previous test.
    expect(mismatchForInterpretation(reader(["h1"]), doc("h1"))).toBeUndefined()
  })
})

describe("sync — symmetric intersection", () => {
  it("is symmetric where interpretation is not", () => {
    const older = reader(["h1"])
    const newer = reader(["h2", "h1"])
    expect(mismatchForSync(older, newer)).toBeUndefined()
    expect(mismatchForSync(newer, older)).toBeUndefined()
  })

  it("fails when the two ranges are disjoint", () => {
    expect(mismatchForSync(reader(["h1"]), reader(["h2"]))?.axis).toBe(
      "schemaHash",
    )
  })
})

describe("the two laws diverge, and must keep diverging", () => {
  it("divergent migration branches can sync but cannot interpret each other", () => {
    // Two peers that both migrated from h1, differently. They share h1, so ops
    // can flow. But neither has ever heard of the other's current shape, so
    // neither can interpret the other's documents.
    //
    // This is the single reason there are two functions rather than one. If
    // anyone ever merges them, this test is what should stop them.
    const a = reader(["h2a", "h1"])
    const bDoc = doc("h2b")
    const b = reader(["h2b", "h1"])

    expect(mismatchForSync(a, b)).toBeUndefined()
    expect(mismatchForInterpretation(a, bDoc)?.axis).toBe("schemaHash")
  })
})

describe("the direction of the interpretation law is compiler-enforced", () => {
  it("rejects a document where a reader is required", () => {
    // Swapping these two arguments would not fail at runtime — it would
    // quietly ask the opposite question, "can the document's shape read my
    // schema?", and answer it wrongly. What prevents that is `supportedHashes`
    // being *required* on ReadCapability and absent from DocMetadata.
    //
    // Which means making that field optional would silently disarm the guard
    // while every other test in this file still passed. This is the test that
    // would notice.
    // Never invoked — the assertion is that this does not compile.
    const swapped = () =>
      // @ts-expect-error — a document is not a read capability
      mismatchForInterpretation(doc("h1"), reader(["h1"]))
    expect(typeof swapped).toBe("function")
  })
})
