// run — every case, printed as one table per group.
//
// `pnpm bench` from `tests/bench`, after `pnpm build` at the root: the cases
// import each package's built `dist`. `--rows N` sizes the records (default
// 10000), `--tokens N` the streams (default 200). `--group NAME` runs one group
// in this process; without it, each group runs in a child process of its own,
// because heap an earlier group retained slows a later one (Yjs "merge, no
// read" measured 51.8 ms after the other groups, 10.5 ms alone).

import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  localStreaming,
  mapWrites,
  navigation,
  reads,
  remoteStreaming,
} from "./cases.ts"
import type { Result } from "./measure.ts"

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

const rows = Number(flag("rows") ?? 10_000)
const tokens = Number(flag("tokens") ?? 200)

const groups: Readonly<Record<string, () => Result[]>> = {
  read: () => reads(rows),
  navigate: () => navigation(rows),
  write: () => mapWrites(rows),
  "local-stream": () => localStreaming(rows, tokens),
  "remote-stream": () => remoteStreaming(rows, tokens),
}

const only = flag("group")
if (only === undefined) {
  for (const name of Object.keys(groups)) {
    const child = spawnSync(
      process.execPath,
      [
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        "--group",
        name,
        "--rows",
        String(rows),
        "--tokens",
        String(tokens),
      ],
      { stdio: "inherit" },
    )
    if (child.status !== 0) process.exit(child.status ?? 1)
  }
} else {
  const run = groups[only]
  if (run === undefined) {
    throw new Error(
      `Unknown group "${only}". Groups: ${Object.keys(groups).join(", ")}.`,
    )
  }
  print(run())
}

function print(results: readonly Result[]): void {
  const group = results[0]?.group ?? ""
  const substrates = [...new Set(results.map(r => r.substrate))]
  const metrics = [...new Set(results.map(r => r.metric))]
  console.log(`\n### ${group}\n`)
  console.log(`| metric | ${substrates.join(" | ")} |`)
  console.log(`|---|${substrates.map(() => "---:").join("|")}|`)
  for (const metric of metrics) {
    const cells = substrates.map(substrate => {
      const r = results.find(
        x => x.metric === metric && x.substrate === substrate,
      )
      return r === undefined ? "" : `${format(r.value)} ${r.unit}`
    })
    console.log(`| ${metric} | ${cells.join(" | ")} |`)
  }
}

function format(value: number): string {
  if (Math.abs(value) >= 100) return value.toFixed(0)
  if (Math.abs(value) >= 10) return value.toFixed(1)
  return value.toFixed(2)
}
