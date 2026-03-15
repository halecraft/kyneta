/**
 * Vite Integration Test
 *
 * Validates the full pipeline: source code with builder patterns →
 * Vite build with the Kyneta unplugin adapter → compiled output
 * contains DOM runtime calls and no raw builder syntax.
 *
 * Unlike the unit tests in `vite/plugin.test.ts` (which call `transform()`
 * directly), these tests run a real Vite build with inline config.
 *
 * Uses temporary files on disk as entry points (rather than virtual modules)
 * because Vite's library-mode entry resolution requires real file paths.
 */

import { describe, expect, it, afterAll } from "vitest"
import { build, type Plugin, type Rollup } from "vite"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import vitePlugin from "../adapters/vite.js"
import {
  BUILDER_SOURCE_EXPORTED,
  MULTI_BUILDER_SOURCE_EXPORTED,
  NO_BUILDER_SOURCE_EXPORTED,
  BUILDER_SOURCE,
} from "./fixtures.js"

type RollupOutput = Rollup.RollupOutput
type OutputChunk = Rollup.OutputChunk

/** Narrow the plugin return (Vite 6 may return Plugin | Plugin[]) */
function getPlugin(options?: Record<string, unknown>): Plugin {
  const result = vitePlugin(options)
  if (Array.isArray(result)) return result[0]!
  return result
}

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tempDir = mkdtempSync(join(tmpdir(), "kyneta-vite-test-"))

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

let fileCounter = 0

/**
 * Write source to a temporary .ts file and return its absolute path.
 */
function writeTempEntry(source: string): string {
  const filename = `entry_${fileCounter++}.ts`
  const filepath = join(tempDir, filename)
  writeFileSync(filepath, source, "utf-8")
  return filepath
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a Vite build with the Kyneta plugin and return the compiled JS output.
 *
 * Writes the source to a temp file, uses Vite's library mode with that
 * file as the entry point, and returns the compiled chunk code.
 */
async function buildWithVite(
  source: string,
  pluginOptions?: Parameters<typeof vitePlugin>[0],
): Promise<string> {
  const entryPath = writeTempEntry(source)

  const result = await build({
    // Suppress Vite's console output during tests
    logLevel: "silent",

    // Set root to the temp dir so Vite can resolve the entry
    root: tempDir,

    plugins: [
      // The Kyneta plugin under test
      vitePlugin(pluginOptions),
    ],

    build: {
      // Library mode so Vite doesn't inject HTML boilerplate
      lib: {
        entry: entryPath,
        formats: ["es"],
        fileName: "out",
      },
      // Don't write to disk
      write: false,
      // Don't minify — we want to inspect the compiled output
      minify: false,
      // Externalize runtime imports that the compiler injects
      rollupOptions: {
        external: [
          /^@kyneta\//,
          /^node:/,
        ],
      },
    },
  })

  // `build()` returns RollupOutput or RollupOutput[] when write: false
  const output = Array.isArray(result) ? result[0] : result
  const chunk = (output as RollupOutput).output.find(
    (o): o is OutputChunk => o.type === "chunk",
  )

  if (!chunk) {
    throw new Error("Vite build produced no output chunk")
  }

  return chunk.code
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("unplugin — Vite integration", () => {
  it("transforms builder patterns through the Vite pipeline", async () => {
    const code = await buildWithVite(BUILDER_SOURCE_EXPORTED)

    // Compiled output should contain DOM runtime calls
    expect(code).toContain("document.createElement")

    // Original builder syntax should be gone
    expect(code).not.toContain("div(() =>")
    expect(code).not.toContain('h1("Hello")')
    expect(code).not.toContain('p("World")')
  })

  it("transforms multiple builder patterns", async () => {
    const code = await buildWithVite(MULTI_BUILDER_SOURCE_EXPORTED)

    expect(code).toContain("document.createElement")
    expect(code).not.toContain("div(() =>")

    // Both exported assignments should survive tree-shaking
    expect(code).toContain("header")
    expect(code).toContain("footer")

    // Multiple createElement calls expected
    const count = (code.match(/document\.createElement/g) || []).length
    expect(count).toBeGreaterThanOrEqual(2)
  })

  it("skips files without builder patterns", async () => {
    const code = await buildWithVite(NO_BUILDER_SOURCE_EXPORTED)

    // The original code should pass through
    expect(code).toContain("greet")
    // No DOM compilation artifacts should appear
    expect(code).not.toContain("document.createElement")
  })

  it("respects the target option", async () => {
    // When target is "html", the compiler should produce SSR output
    // (HTML string concatenation) instead of DOM createElement calls
    const code = await buildWithVite(BUILDER_SOURCE_EXPORTED, { target: "html" })

    // SSR output uses string concatenation for HTML
    expect(code).toContain("<div>")
    expect(code).toContain("<h1>")
    // Should NOT contain DOM calls
    expect(code).not.toContain("document.createElement")
  })

  it("registers as enforce: pre", () => {
    // Verify the plugin metadata
    const plugin = getPlugin()
    expect(plugin.name).toBe("kyneta")
    expect(plugin.enforce).toBe("pre")
  })

  it("exposes Vite-specific hooks", () => {
    const plugin = getPlugin()
    // The Vite adapter should have these hooks from the vite: escape hatch
    expect(plugin.configResolved).toBeDefined()
    expect(plugin.handleHotUpdate).toBeDefined()
    expect(plugin.transform).toBeDefined()
  })
})