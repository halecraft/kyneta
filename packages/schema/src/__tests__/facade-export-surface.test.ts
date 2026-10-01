// facade-export-surface — guards the change() → batch() rename (jj:rkwspltk).
//
// Pins that `batch` is the public mutation-facade verb and `change` is exported
// nowhere, across both schema entrypoints. Catches a half-applied rename and an
// accidental re-introduction of the old name.

import { describe, expect, it } from "vitest"
import * as basic from "../basic/index.js"
import * as schema from "../index.js"

describe("facade export surface: batch, not change", () => {
  it("@kyneta/schema exports batch (function) and not change", () => {
    expect(typeof schema.batch).toBe("function")
    expect("change" in schema).toBe(false)
  })

  it("@kyneta/schema/basic exports batch (function) and not change", () => {
    expect(typeof basic.batch).toBe("function")
    expect("change" in basic).toBe(false)
  })

  it("the companions keep their names", () => {
    expect(typeof schema.applyChanges).toBe("function")
    expect(typeof schema.remove).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Notification-engine internals stay internal
// ---------------------------------------------------------------------------

describe("the ref construction's internals are not public", () => {
  // A document's refs are one fixed construction: there are no layers to
  // compose, and nothing of the construction is exported.
  it("the layers and the notification engine are exported nowhere", () => {
    for (const name of [
      "attachChangefeed",
      "withChangefeed",
      "observation",
      "readable",
      "writable",
      "planDelivery",
      "createRefAt",
      "createRootRef",
    ]) {
      expect(name in schema).toBe(false)
      expect(name in basic).toBe(false)
    }
  })

  // Kept deliberately, so a future reader counting usages does not "clean up"
  // what is really an extension point.
  //
  // POPULATED is a protocol symbol: removing it would foreclose implementing
  // the populated protocol outside this package, even though nothing does today.
  // The other three have live external importers — `populated` broadly,
  // `populatedFeed` in @kyneta/exchange's doc-status, and
  // `expandProductMapChanges` in both CRDT change-mapping bridges.
  it("the populated protocol and the map-op expander stay public", () => {
    expect(schema.POPULATED).toBeDefined()
    expect(typeof schema.populated).toBe("function")
    expect(typeof schema.populatedFeed).toBe("function")
    expect(typeof schema.expandProductMapChanges).toBe("function")
  })
})
