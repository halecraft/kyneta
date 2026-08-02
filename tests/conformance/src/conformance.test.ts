// Substrate-unification conformance suite.
//
// A single, table-driven "gold standard" that runs the same convergence battery
// against every substrate (json / state / loro / yjs) through the
// real Exchange sync machinery. The `PROFILES` table declares each substrate's
// axes (writerModel, durability, merge granularity, …); the harness enforces
// that the universal invariants hold everywhere and the capability-gated ones
// match each declared row. It is the executable specification of the substrate
// abstraction — a regression in any substrate's sync behavior fails here.
//
// Coverage is deliberately broader than scalars. `ConformanceSchema` carries a
// discriminated union and a nullable struct, because sums are where the five
// substrates most recently diverged: three separate bugs, one per substrate,
// were live at once and none of them failed a test. Sums reach the same
// guarantee by four different mechanisms, which is exactly the situation a
// shared assertion is worth having.

import { runSubstrateConformance } from "./harness.js"
import { PROFILES } from "./profiles.js"

for (const profile of PROFILES) {
  runSubstrateConformance(profile)
}
