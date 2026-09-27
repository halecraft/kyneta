// YjsVersion — Version over a Yjs state vector.
//
// A state vector counts the items each client has inserted. Yjs does not
// advance it for a delete, so on its own it would not order Yjs documents: a
// peer could hold another's every insert and still lack a delete. The Yjs
// substrate closes that gap by advancing the clock after every change that
// deleted without inserting (`installDeleteClock` in `substrate.ts`), so a
// state vector that reaches another's holds everything the other does, deletes
// included. That makes the version the state vector alone, and `compare`,
// `meet` and `join` the version-vector lattice.

import type { Version } from "@kyneta/schema"
import {
  base64ToUint8Array,
  DEFAULT_LINEAGE,
  uint8ArrayToBase64,
  versionVectorCompare,
  versionVectorJoin,
  versionVectorMeet,
} from "@kyneta/schema"
import { type Doc, decodeStateVector, encodeStateVector } from "yjs"

/** A Version wrapping a Yjs state vector. */
export class YjsVersion implements Version {
  /** Encoded state vector: the cursor `exportSince()` exports from. */
  readonly sv: Uint8Array

  constructor(sv: Uint8Array) {
    this.sv = sv
  }

  /**
   * Yjs is a collaborative (CRDT) substrate — lineages are never minted
   * automatically. `lineage` is always `DEFAULT_LINEAGE` for the document's
   * lifetime; new lineages require an explicit developer-invoked migration
   * primitive (T3 migrations, not implemented here).
   */
  get lineage(): string {
    return DEFAULT_LINEAGE
  }

  /** The version of a document holding nothing: the empty state vector. */
  static readonly empty: YjsVersion = new YjsVersion(
    encodeStateVector(new Map()),
  )

  /** The version of a live `Y.Doc`: its state vector. O(clients). */
  static fromDoc(doc: Doc): YjsVersion {
    return new YjsVersion(encodeStateVector(doc))
  }

  /** `base64(sv)`. */
  serialize(): string {
    return uint8ArrayToBase64(this.sv)
  }

  compare(other: Version): "behind" | "equal" | "ahead" | "concurrent" {
    return versionVectorCompare(
      this.#vector(),
      YjsVersion.#of(other, "compared").#vector(),
    )
  }

  meet(other: Version): YjsVersion {
    return YjsVersion.#fromVector(
      versionVectorMeet(this.#vector(), YjsVersion.#of(other, "met").#vector()),
    )
  }

  join(other: Version): YjsVersion {
    return YjsVersion.#fromVector(
      versionVectorJoin(
        this.#vector(),
        YjsVersion.#of(other, "joined").#vector(),
      ),
    )
  }

  /** Parse `serialize()`'s output. */
  static parse(serialized: string): YjsVersion {
    if (serialized === "") {
      throw new Error("Invalid YjsVersion value: (empty string)")
    }
    const sv = base64ToUint8Array(serialized)
    decodeStateVector(sv) // throws on bytes that are not a state vector
    return new YjsVersion(sv)
  }

  #vector(): Map<number, number> {
    return decodeStateVector(this.sv)
  }

  static #fromVector(vector: Map<number, number>): YjsVersion {
    return new YjsVersion(encodeStateVector(vector))
  }

  static #of(other: Version, how: string): YjsVersion {
    if (!(other instanceof YjsVersion)) {
      throw new Error(`YjsVersion can only be ${how} with another YjsVersion`)
    }
    return other
  }
}
