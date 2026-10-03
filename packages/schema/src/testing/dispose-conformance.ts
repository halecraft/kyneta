// dispose-conformance — shared, re-exportable suite for `ReplicaLike.dispose`.
//
// After `dispose`, a ref that outlives its substrate reads its last value and
// refuses everything that needs what was released: authored writes, the
// native document, the sync functions, every replica member, and whatever
// was made from the native document before the close (a position, the
// devtools history, an undo record). Every backend runs it.

import { CHANGEFEED } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import { createRef } from "../create-doc.js"
import { batch } from "../facade/batch.js"
import { subscribe } from "../facade/observe.js"
import { POSITION, type Position } from "../position.js"
import { TRANSACT } from "../ref/write.js"
import { DocumentClosedError } from "../refusal.js"
import { Schema } from "../schema.js"
import {
  createSubstrate,
  DEVTOOLS_HISTORY,
  hasDevtoolsHistory,
  type RevertibleCommit,
  type SubstrateFactory,
  type Version,
} from "../substrate.js"
import { exportEntirety, exportSince, merge, version } from "../sync.js"
import { unwrap } from "../unwrap.js"

/** The document every scenario writes: a field and a counter-free number,
 *  which every backend holds. */
export const DisposeFixture = Schema.struct({
  name: Schema.string(),
  count: Schema.number(),
})

/** A text, for the backends whose positions are made from the native
 *  document. */
const TextFixture = Schema.struct({ title: Schema.text() })

export interface DisposeTestEnv {
  readonly factory: SubstrateFactory<any>
  /** Whether a text's position resolves against the native document, and so
   *  closes with it. A plain position is an index, and needs nothing. */
  readonly nativePositions?: boolean
}

export interface DisposeConformanceOptions {
  readonly label?: string
}

/** `fn` throws `DocumentClosedError` with `reason`. */
function expectClosed(fn: () => unknown, reason: string): void {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(DocumentClosedError)
  expect((thrown as DocumentClosedError).reason).toBe(reason)
}

export function disposeConformance(
  env: DisposeTestEnv,
  options?: DisposeConformanceOptions,
): void {
  const suffix = options?.label ? ` (${options.label})` : ""
  const { factory } = env

  const written = () => {
    const substrate = createSubstrate(factory, DisposeFixture)
    const doc: any = createRef(DisposeFixture, substrate)
    batch(doc, (d: any) => {
      d.name.set("kept")
      d.count.set(3)
    })
    return { substrate, doc }
  }

  describe(`dispose conformance${suffix}`, () => {
    it("a held ref reads its last value", () => {
      const { substrate, doc } = written()
      substrate.dispose("destroyed")
      expect(doc()).toEqual({ name: "kept", count: 3 })
      expect(doc.name()).toBe("kept")
    })

    it("an authored write throws DocumentClosedError, and nothing is applied", () => {
      const { substrate, doc } = written()
      const heard: number[] = []
      subscribe(doc, changeset => heard.push(changeset.changes.length))
      substrate.dispose("destroyed")
      expectClosed(() => doc.name.set("lost"), "destroyed")
      expectClosed(
        () =>
          batch(doc, (d: any) => {
            d.count.set(4)
            d.name.set("lost")
          }),
        "destroyed",
      )
      expect(doc()).toEqual({ name: "kept", count: 3 })
      expect(heard.every(n => n === 0)).toBe(true)
    })

    it("the context's refusal reports the close, and tells its subscribers", () => {
      const { substrate, doc } = written()
      const refusal = doc[TRANSACT].refusal
      let heard = 0
      refusal[CHANGEFEED].subscribe(() => heard++)
      expect(refusal()).toBeUndefined()
      substrate.dispose("disposed")
      expect(heard).toBe(1)
      expect(refusal()).toBeInstanceOf(DocumentClosedError)
      expect(refusal()?.reason).toBe("disposed")
    })

    it("[NATIVE] and the sync functions throw DocumentClosedError", () => {
      const { substrate, doc } = written()
      const before = version(doc)
      const payload = exportEntirety(doc)
      substrate.dispose("destroyed")
      expectClosed(() => unwrap(doc), "destroyed")
      expectClosed(() => version(doc), "destroyed")
      expectClosed(() => exportEntirety(doc), "destroyed")
      expectClosed(() => exportSince(doc, before), "destroyed")
      expectClosed(() => merge(doc, payload), "destroyed")
    })

    it("every member of a disposed replica throws DocumentClosedError", () => {
      const source = written()
      const payload = source.substrate.exportEntirety()
      const replica = factory.replica.createEmpty()
      replica.merge(payload)
      const at: Version = replica.version()
      replica.dispose("destroyed")
      const members: Array<() => unknown> = [
        () => replica.version(),
        () => replica.baseVersion(),
        () => replica.digest(),
        () => replica.advance(at),
        () => replica.exportEntirety(),
        () => replica.exportSince(at),
        () => replica.merge(payload),
        () => replica.resetFromEntirety(payload),
      ]
      for (const member of members) expectClosed(member, "destroyed")
    })

    it("every replica member of a disposed substrate throws DocumentClosedError", () => {
      const { substrate } = written()
      const payload = substrate.exportEntirety()
      const at: Version = substrate.version()
      substrate.dispose("destroyed")
      const members: Array<() => unknown> = [
        () => substrate.version(),
        () => substrate.baseVersion(),
        () => substrate.digest(),
        () => substrate.advance(at),
        () => substrate.exportEntirety(),
        () => substrate.exportSince(at),
        () => substrate.merge(payload),
        () => substrate.resetFromEntirety(payload),
      ]
      for (const member of members) expectClosed(member, "destroyed")
    })

    it("the devtools history made before the close throws DocumentClosedError", () => {
      const { substrate } = written()
      if (!hasDevtoolsHistory(substrate)) return
      const history = substrate[DEVTOOLS_HISTORY]
      substrate.dispose("destroyed")
      expectClosed(() => history.summary(), "destroyed")
    })

    it("planning an undo record made before the close throws DocumentClosedError", () => {
      const { substrate, doc } = written()
      const { revertible } = substrate
      if (revertible === undefined) return
      const commits: RevertibleCommit<unknown>[] = []
      revertible.subscribeCommits(commit => commits.push(commit))
      doc.name.set("undoable")
      const [commit] = commits
      if (commit === undefined) throw new Error("expected a commit")
      substrate.dispose("destroyed")
      expectClosed(() => revertible.plan(commit.record), "destroyed")
    })

    if (env.nativePositions) {
      it("a position made before the close throws DocumentClosedError", () => {
        const substrate = createSubstrate(factory, TextFixture)
        const doc: any = createRef(TextFixture, substrate)
        doc.title.insert(0, "hello")
        const position: Position = doc.title[POSITION].createPosition(2, "left")
        expect(position.resolve()).toBe(2)
        substrate.dispose("destroyed")
        expectClosed(() => position.resolve(), "destroyed")
      })
    }

    it("dispose is idempotent, and the first reason stands", () => {
      const { substrate, doc } = written()
      substrate.dispose("destroyed")
      expect(() => substrate.dispose("disposed")).not.toThrow()
      expect(doc[TRANSACT].refusal()?.reason).toBe("destroyed")
    })
  })
}
