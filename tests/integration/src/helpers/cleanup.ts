// cleanup — lifecycle harness used in `afterEach` to shut down resources.
//
// Each test file constructs one `TestLifecycle` and registers its own
// `afterEach`. Helpers (e.g. `createConnectedPair`) accept the lifecycle
// and register their exchanges/servers/tmpdirs into it, so cleanup is
// centralized regardless of where the resource was created.
//
// Three categories of resource, with different lifetimes:
//
// - exchanges + servers: per-phase. A multi-phase test (e.g. SQLite
//   restart) tears these down between phases via `cleanupTransient()`.
// - tmpdirs: per-test. Carry across phases (state on disk is exactly
//   what the test is verifying), torn down only at end of test.
//
// `cleanup()` does both.

import * as fs from "node:fs"
import type { Exchange } from "@kyneta/exchange"
import type { TestServer } from "./node-ws-server.js"

export interface TestLifecycle {
  registerExchange(ex: Exchange): Exchange
  registerServer(s: TestServer): TestServer
  registerTmpdir(d: string): string
  /** Shut down exchanges + servers but keep tmpdirs. For inter-phase teardown. */
  cleanupTransient(): Promise<void>
  /** Full cleanup: transient + remove tmpdirs. */
  cleanup(): Promise<void>
}

export function createTestLifecycle(): TestLifecycle {
  const exchanges: Exchange[] = []
  const servers: TestServer[] = []
  const tmpdirs: string[] = []

  async function cleanupTransient(): Promise<void> {
    for (const ex of exchanges) {
      try {
        await ex.shutdown()
      } catch {
        // ignore — best-effort
      }
    }
    exchanges.length = 0

    for (const s of servers) {
      try {
        s.shutdown()
      } catch {
        // ignore
      }
    }
    servers.length = 0
  }

  return {
    registerExchange(ex) {
      exchanges.push(ex)
      return ex
    },
    registerServer(s) {
      servers.push(s)
      return s
    },
    registerTmpdir(d) {
      tmpdirs.push(d)
      return d
    },
    cleanupTransient,
    async cleanup() {
      await cleanupTransient()
      for (const dir of tmpdirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
      tmpdirs.length = 0
    },
  }
}
