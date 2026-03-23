/**
 * Farm Integration Test
 *
 * Validates the full pipeline: source code with builder patterns →
 * Farm build with the Kyneta unplugin Farm adapter → compiled output
 * contains DOM runtime calls and no raw builder syntax.
 *
 * Requires `@farmfe/core` as a devDependency. If it is not installed
 * (e.g. in a minimal CI environment), the suite is skipped gracefully.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import farmPlugin from "../adapters/farm.js"
import {
  BUILDER_SOURCE_EXPORTED,
  MULTI_BUILDER_SOURCE_EXPORTED,
  NO_BUILDER_SOURCE_EXPORTED,
} from "./fixtures.js"

// ---------------------------------------------------------------------------
// Skip if @farmfe/core is not available
// ---------------------------------------------------------------------------

function hasFarm(): boolean {
  try {
    require.resolve("@farmfe/core")
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tempDir = mkdtempSync(join(tmpdir(), "kyneta-farm-test-"))

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

let fileCounter = 0

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a Farm build with the Kyneta plugin and return the compiled JS output.
 *
 * Writes the source to a temp file, builds it with Farm in library-browser
 * mode, and returns the output JS.
 */
async function buildWithFarm(source: string): Promise<string> {
  const entryName = `entry_${fileCounter++}`
  const entryFile = `${entryName}.ts`
  const outDir = join(tempDir, `out_${fileCounter}`)

  writeFileSync(join(tempDir, entryFile), source, "utf-8")

  const { build } = await import("@farmfe/core")

  await build({
    compilation: {
      input: { [entryName]: join(tempDir, entryFile) },
      output: {
        path: outDir,
        entryFilename: "[entryName].js",
        targetEnv: "library-browser",
      },
      minify: false,
      sourcemap: false,
      persistentCache: false,
      external: ["^@kyneta/.*"],
    },
    plugins: [farmPlugin()],
  })

  return readFileSync(join(outDir, `${entryName}.js`), "utf-8")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!hasFarm())("unplugin — Farm integration", () => {
  it("transforms builder patterns through the Farm pipeline", async () => {
    const code = await buildWithFarm(BUILDER_SOURCE_EXPORTED)

    // Compiled output should contain DOM runtime calls
    expect(code).toContain("document.createElement")

    // Original builder syntax should be gone
    expect(code).not.toContain("div(() =>")
    expect(code).not.toContain('h1("Hello")')
    expect(code).not.toContain('p("World")')
  })

  it("transforms multiple builder patterns", async () => {
    const code = await buildWithFarm(MULTI_BUILDER_SOURCE_EXPORTED)

    expect(code).toContain("document.createElement")
    expect(code).not.toContain("div(() =>")

    // Both exported assignments should survive
    expect(code).toContain("header")
    expect(code).toContain("footer")

    // Multiple createElement calls expected
    const count = (code.match(/document\.createElement/g) || []).length
    expect(count).toBeGreaterThanOrEqual(2)
  })

  it("skips files without builder patterns", async () => {
    const code = await buildWithFarm(NO_BUILDER_SOURCE_EXPORTED)

    // Original code should pass through
    expect(code).toContain("greet")
    // No DOM compilation artifacts
    expect(code).not.toContain("document.createElement")
  })
})
