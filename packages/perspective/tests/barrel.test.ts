// === What this package's barrel does and does not export ===
//
// A package re-exports what it owns. Perspective owns the kernel, the native
// solvers and the bootstrap; it does *not* own the Datalog language, the
// evaluator, or the ℤ-set algebra, even though it depends on all three and its
// own types mention them.
//
// This file exists because perspective is the one package with a history of the
// opposite habit: before the split its barrel re-exported 267 names, including
// every Datalog and ℤ-set symbol, so a consumer wanting `createEvaluator` also
// received `vvMergeInto`. A convenience re-export is an easy thing to add back
// without noticing, and this is what notices.

import { describe, expect, it } from "vitest"
import * as perspective from "../src/index.js"

describe("the public barrel", () => {
  it("exports the kernel surface it owns", () => {
    for (const name of [
      "createReality",
      "solve",
      "createStore",
      "createAgent",
      "insert",
      "produceRoot",
      "produceMapChild",
      "produceSeqChild",
      "exportDelta",
      "importDelta",
      "getVersionVector",
      "buildDefaultRules",
    ]) {
      expect(perspective).toHaveProperty(name)
    }
  })

  it("does not re-export @kyneta/datalog", () => {
    // Consumers import these from the package that owns them. TypeScript
    // resolves them across packages without perspective re-exporting anything,
    // which is why `RulePayload.head: Atom` still type-checks downstream.
    for (const name of [
      "createEvaluator",
      "evaluate",
      "stratify",
      "atom",
      "rule",
      "varTerm",
      "fact",
      "Database",
      "Relation",
      "serializeValue",
      "hostErrors",
      "ok",
      "err",
    ]) {
      expect(perspective).not.toHaveProperty(name)
    }
  })

  it("does not re-export @kyneta/zset", () => {
    for (const name of ["zsetAdd", "zsetEmpty", "zsetNegate", "zsetPositive"]) {
      expect(perspective).not.toHaveProperty(name)
    }
  })
})
