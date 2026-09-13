// === Shared rule-constraint helpers for tests ===
//
// The default LWW and Fugue rules live in the constraint store, not in the
// engine. That is this package's central claim: "rules are data, not code" —
// any agent with the right capabilities can retract them and assert different
// ones, and the reality changes without the engine changing. `bootstrap.ts`
// puts them in the store when a reality is created.
//
// The consequence for tests is easy to miss: **a test that asserts what those
// rules do has to put them in the store it builds.** A store with no rule
// constraints has no resolution semantics of its own.
//
// That was missed. `kernel/pipeline.test.ts` grew 29 tests asserting LWW and
// Fugue outcomes — "higher lamport wins", "lower peer goes first" — over stores
// holding no rules at all. They passed because the §B.7 native solver supplied
// the semantics instead, so the file was testing the solver while appearing to
// test the engine. These helpers lived in `kernel/resolve.test.ts` and were
// unreachable from there, which is plausibly how the gap opened.
//
// Shared here so that the cheap thing to do is also the correct one.
//
// Not a test file: vitest only collects `*.test.ts`.

import type { Rule } from "@kyneta/datalog"
import { buildDefaultRules } from "../../src/bootstrap.js"
import { createCnId } from "../../src/kernel/cnid.js"
import { STUB_SIGNATURE } from "../../src/kernel/signature.js"
import type { PeerID, RuleConstraint } from "../../src/kernel/types.js"

/**
 * A single rule constraint, as an agent would assert it.
 *
 * `layer` follows the spec's rule layering: layer 1 is the default rule set
 * bootstrap installs, layer 2 and above are application rules asserted on top.
 */
export function makeRuleConstraint(
  peer: PeerID,
  counter: number,
  layer: number,
  datalogRule: Rule,
  lamport?: number,
): RuleConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: lamport ?? counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "rule",
    payload: {
      layer,
      head: datalogRule.head,
      body: datalogRule.body,
    },
  }
}

/**
 * The default LWW + Fugue rules as layer-1 constraints, exactly as they appear
 * in a store after reality bootstrap.
 *
 * Spread these into any store whose test asserts a resolved value or a sequence
 * order:
 *
 * ```ts
 * const store = buildStore([root, child, val, ...defaultRuleConstraints("alice", 100)])
 * ```
 *
 * `startCounter` should sit above the counters the test's other constraints use,
 * so the CnIds it generates cannot collide with them.
 */
export function defaultRuleConstraints(
  peer: PeerID,
  startCounter: number,
): RuleConstraint[] {
  const rules = buildDefaultRules()
  return rules.map((r, i) => makeRuleConstraint(peer, startCounter + i, 1, r))
}
