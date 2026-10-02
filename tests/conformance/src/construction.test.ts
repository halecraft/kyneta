// construction — the functions that make a document from a factory, on every
// substrate.
//
// A factory holds what varies by backend: an empty replica, and how a replica
// gains a schema. Making a document from nothing, from an entirety, or from a
// replica in hand is composition over that, defined once in `@kyneta/schema`.
// This runs the compositions against every profile, so a backend whose
// `upgrade` or `resetFromEntirety` breaks them fails here.

import {
  batch,
  createRef,
  createSubstrate,
  DocumentClosedError,
  reaches,
  replicaFromEntirety,
  substrateFromEntirety,
  upgradeReplica,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { PROFILES } from "./profiles.js"

for (const profile of PROFILES) {
  describe(`construction (${profile.name})`, () => {
    const bound = profile.bind()
    const factory = bound.factory({
      peerId: "construction",
      binding: bound.identityBinding,
    })

    /** A substrate made with `createSubstrate`, and written to. */
    const written = () => {
      const substrate = createSubstrate(factory, bound.schema)
      batch(createRef(bound.schema, substrate), (d: any) => {
        d.a.set("one")
        d.peers.set("alice", 1)
      })
      return substrate
    }

    it("a substrate rebuilt from an entirety reads what its source read", () => {
      const source = written()
      const copy = substrateFromEntirety(
        factory,
        source.exportEntirety(),
        bound.schema,
      )
      const doc: any = createRef(bound.schema, copy)
      expect(doc.a()).toBe("one")
      expect(doc.peers()).toEqual({ alice: 1 })
    })

    it("a replica from an entirety holds what its source holds", () => {
      const source = written()
      const replica = replicaFromEntirety(
        factory.replica,
        source.exportEntirety(),
      )
      if (factory.replica.historyFree) {
        // An install counter does not compare across replicas: the digest
        // answers whether they hold the same state.
        expect(replica.digest()).toBe(source.digest())
      } else {
        expect(reaches(replica.version(), source.version())).toBe(true)
      }
    })

    it("upgradeReplica closes the replica, and the substrate stays usable", () => {
      const replica = factory.replica.createEmpty()
      const substrate = upgradeReplica(factory, replica, bound.schema)
      expect(() => replica.version()).toThrow(DocumentClosedError)
      const doc: any = createRef(bound.schema, substrate)
      doc.a.set("after")
      expect(doc.a()).toBe("after")
      expect(() => substrate.exportEntirety()).not.toThrow()
    })
  })
}
