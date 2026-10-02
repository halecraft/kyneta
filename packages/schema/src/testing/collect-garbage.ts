// collect-garbage — force a full collection from a test, and let what it
// freed be seen.
//
// Node only. `--expose-gc` is turned on at run time, so no test runner needs
// a flag: `vm.runInNewContext("gc")` reads the `gc` the flag installs on a
// fresh context, which works inside a vitest worker too.

import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"

let gc: (() => void) | undefined

function forceGc(): void {
  if (gc === undefined) {
    setFlagsFromString("--expose-gc")
    gc = runInNewContext("gc") as () => void
  }
  gc()
}

/**
 * Collect, then let the finalizers run. A `WeakRef` made in this job is kept
 * until it ends, and a finalizer runs in a task of its own, so each round
 * yields first.
 */
export async function collectGarbage(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
    forceGc()
  }
  await new Promise(resolve => setTimeout(resolve, 0))
}
