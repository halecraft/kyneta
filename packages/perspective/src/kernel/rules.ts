// === Rule Extraction ===
//
// Rules are constraints. A `rule` constraint carries a Datalog rule as data —
// a head and a body — so pulling the rule set out of a store is a matter of
// filtering and reshaping, not of interpreting anything.
//
// This was the one piece of `kernel/rule-detection.ts` worth keeping. The rest
// of that module existed to recognise when the store's rules matched the known
// default LWW and Fugue patterns, so the engine could substitute hand-written
// solvers for them (spec §B.7). That dispatch is gone — see
// `.plans/008-retire-the-native-fast-path.md` — and with one evaluation path
// there is nothing left to detect. Extraction is still needed, because the
// evaluator has to be handed the rules.

import type { Rule } from "@kyneta/datalog"
import type { Constraint, RuleConstraint } from "./types.js"

/**
 * The Datalog rules carried by a set of active constraints.
 *
 * Sorted by layer — layer 1 is the default rule set bootstrap installs, layer 2
 * and above are application rules asserted on top. The evaluator's results do
 * not depend on rule order, but a stable order keeps anything downstream that
 * iterates rules deterministic across peers.
 */
export function extractRules(activeConstraints: readonly Constraint[]): Rule[] {
  const ruleConstraints: RuleConstraint[] = []

  for (const c of activeConstraints) {
    if (c.type === "rule") {
      ruleConstraints.push(c)
    }
  }

  ruleConstraints.sort((a, b) => a.payload.layer - b.payload.layer)

  return ruleConstraints.map(rc => ({
    head: rc.payload.head,
    body: rc.payload.body,
  }))
}
