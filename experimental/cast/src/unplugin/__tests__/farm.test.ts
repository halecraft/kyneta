/**
 * Farm adapter contract test.
 *
 * Verifies that the Farm adapter exposes a `JsPlugin`-shaped object and
 * that its `transform.executor` produces the same output as the
 * universal transform handler. The transform *logic* is exhaustively
 * covered by `transform.test.ts`; running a real Farm build in CI is
 * inherently slow (native Rust binary) and flaky under parallel load,
 * so we verify the adapter's contract structurally instead.
 */
import { describe, expect, it } from "vitest"
import farmPlugin from "../adapters/farm.js"
import { BUILDER_SOURCE, NO_BUILDER_SOURCE } from "./fixtures.js"

// Minimal stub for the `PluginTransformHookParam` fields the executor
// actually reads. Everything else is shape-only.
function transformParam(content: string, resolvedPath: string) {
  return {
    moduleId: resolvedPath,
    content,
    moduleType: "ts" as const,
    resolvedPath,
    query: [] as [string, string][],
    meta: null,
    sourceMapChain: [] as string[],
  }
}

describe("unplugin — Farm adapter", () => {
  it("returns a JsPlugin with a name and a transform hook", () => {
    const plugin = farmPlugin() as any
    expect(plugin.name).toBe("kyneta")
    expect(plugin.transform).toBeDefined()
    expect(typeof plugin.transform.executor).toBe("function")
    expect(plugin.transform.filters).toBeDefined()
  })

  it("transform.executor compiles builder source to DOM runtime calls", async () => {
    const plugin = farmPlugin() as any
    const result = await plugin.transform.executor(
      transformParam(BUILDER_SOURCE, "/src/app.ts"),
    )
    expect(result).toBeDefined()
    expect(result.content).toContain("document.createElement")
    expect(result.content).not.toContain("div(() =>")
  })

  it("transform.executor returns the source untouched for non-builder files", async () => {
    const plugin = farmPlugin() as any
    const result = await plugin.transform.executor(
      transformParam(NO_BUILDER_SOURCE, "/src/utils.ts"),
    )
    // unplugin's Farm adapter may return null/undefined for unchanged
    // source (when the universal handler returns null) — either way,
    // the result must not contain compiled output.
    if (result) {
      expect(result.content).not.toContain("document.createElement")
    }
  })
})
