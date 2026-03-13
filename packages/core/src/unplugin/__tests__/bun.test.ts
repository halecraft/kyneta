/**
 * Bun Integration Test
 *
 * Validates the full pipeline: source code with builder patterns →
 * Bun.build() with the Kyneta unplugin Bun adapter → compiled output
 * contains DOM runtime calls and no raw builder syntax.
 *
 * This test requires the `bun` binary to be available on the system.
 * It shells out to Bun because `Bun.build()` is only available inside
 * the Bun runtime, not in Node.js / vitest.
 */

import { describe, expect, it } from "vitest"
import { execSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { BUILDER_SOURCE, NO_BUILDER_SOURCE_EXPORTED } from "./fixtures.js"

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Resolve to the package root (packages/core).
 * From src/unplugin/__tests__/ we go up 3 levels.
 */
const PACKAGE_ROOT = resolve(__dirname, "..", "..", "..")

// ---------------------------------------------------------------------------
// Skip if Bun is not available
// ---------------------------------------------------------------------------

function hasBun(): boolean {
  try {
    execSync("bun --version", { stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a source string through Bun.build() with the Kyneta plugin
 * and return the compiled output.
 *
 * Creates a temporary directory with the entry file and a build script,
 * runs `bun run build.ts`, and reads the output.
 */
function buildWithBun(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kyneta-bun-test-"))

  try {
    // Write the entry source file
    writeFileSync(join(dir, "entry.ts"), source, "utf-8")

    // Resolve the plugin path from the built dist artifacts.
    // We use the dist path because Bun runs in its own process and
    // cannot import TypeScript source directly from our package.
    const pluginPath = join(
      PACKAGE_ROOT,
      "dist",
      "unplugin",
      "adapters",
      "bun.js",
    )

    // Use forward slashes for the import path (works on all platforms)
    const normalizedPluginPath = pluginPath.replace(/\\/g, "/")

    const buildScript = `
import kyneta from "${normalizedPluginPath}"

const result = await Bun.build({
  entrypoints: ["./entry.ts"],
  outdir: "./out",
  plugins: [kyneta()],
  external: ["@kyneta/core/runtime", "@kyneta/schema"],
  target: "browser",
})

if (!result.success) {
  console.error("Build failed:")
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}
`
    writeFileSync(join(dir, "build.ts"), buildScript, "utf-8")

    // Run the Bun build
    execSync("bun run build.ts", {
      cwd: dir,
      stdio: "pipe",
      timeout: 15_000,
    })

    // Read the output
    const outFile = join(dir, "out", "entry.js")
    return readFileSync(outFile, "utf-8")
  } finally {
    // Clean up temp directory
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!hasBun())("unplugin — Bun integration", () => {
  it("transforms builder patterns through the Bun pipeline", () => {
    const code = buildWithBun(BUILDER_SOURCE)

    // Compiled output should contain DOM runtime calls
    expect(code).toContain("document.createElement")

    // Original builder syntax should be gone
    expect(code).not.toContain("div(() =>")
  })

  it("skips files without builder patterns", () => {
    const code = buildWithBun(NO_BUILDER_SOURCE_EXPORTED)

    // Original code should pass through (Bun tree-shakes unexported code)
    expect(code).toContain("greet")
    // No DOM compilation artifacts
    expect(code).not.toContain("document.createElement")
  })
})