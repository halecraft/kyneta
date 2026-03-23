/**
 * Universal Transform Integration Test
 *
 * Tests the unplugin factory's `transform.handler` code path, which is
 * the transform used by all non-Vite bundlers (Bun, Farm, Rollup,
 * Rolldown, esbuild, webpack, Rspack).
 *
 * Unlike the Vite integration test (which runs a full `vite.build()`),
 * these tests invoke the factory directly and call the transform handler
 * to validate the universal code path in isolation.
 */

import { describe, expect, it } from "vitest"
import { unpluginFactory } from "../index.js"
import {
  BUILDER_SOURCE,
  MULTI_BUILDER_SOURCE,
  NO_BUILDER_SOURCE,
} from "./fixtures.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a plugin instance from the factory and extract the universal
 * transform handler (the one used by non-Vite bundlers).
 */
function createTransformHandler(
  options?: Parameters<typeof unpluginFactory>[0],
) {
  const meta = { framework: "rollup" as const }
  const plugin = unpluginFactory(options, meta as any)

  // The factory returns a single plugin object (not an array)
  if (Array.isArray(plugin)) {
    throw new Error("Expected single plugin, got array")
  }

  const transform = plugin.transform
  if (!transform || typeof transform === "function") {
    throw new Error("Expected transform to be an object with filter + handler")
  }

  return {
    handler: transform.handler as (
      code: string,
      id: string,
    ) => { code: string; map?: string } | null | undefined,
    filter: transform.filter,
    plugin,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("unplugin — universal transform", () => {
  describe("factory basics", () => {
    it("produces a plugin named 'kyneta'", () => {
      const { plugin } = createTransformHandler()
      expect(plugin.name).toBe("kyneta")
    })

    it("sets enforce: pre", () => {
      const { plugin } = createTransformHandler()
      expect(plugin.enforce).toBe("pre")
    })

    it("has a transform filter matching .ts/.tsx", () => {
      const { filter } = createTransformHandler()
      expect(filter).toBeDefined()

      const idFilter = filter?.id as RegExp
      expect(idFilter).toBeInstanceOf(RegExp)
      expect(idFilter.test("app.ts")).toBe(true)
      expect(idFilter.test("app.tsx")).toBe(true)
      expect(idFilter.test("app.js")).toBe(false)
      expect(idFilter.test("app.css")).toBe(false)
    })
  })

  describe("builder transformation", () => {
    it("transforms a single builder pattern", () => {
      const { handler } = createTransformHandler()
      const result = handler(BUILDER_SOURCE, "/src/app.ts")

      expect(result).not.toBeNull()
      expect(result?.code).toContain("document.createElement")
      expect(result?.code).not.toContain("div(() =>")
      expect(result?.code).not.toContain('h1("Hello")')
      expect(result?.code).not.toContain('p("World")')
    })

    it("transforms multiple builder patterns", () => {
      const { handler } = createTransformHandler()
      const result = handler(MULTI_BUILDER_SOURCE, "/src/app.ts")

      expect(result).not.toBeNull()
      expect(result?.code).toContain("document.createElement")
      expect(result?.code).not.toContain("div(() =>")

      // Both variable assignments should survive
      expect(result?.code).toContain("header")
      expect(result?.code).toContain("footer")

      const count = (result?.code.match(/document\.createElement/g) || [])
        .length
      expect(count).toBeGreaterThanOrEqual(2)
    })

    it("returns null for source without builder patterns", () => {
      const { handler } = createTransformHandler()
      const result = handler(NO_BUILDER_SOURCE, "/src/utils.ts")

      expect(result).toBeNull()
    })
  })

  describe("target option", () => {
    it("defaults to DOM target", () => {
      const { handler } = createTransformHandler()
      const result = handler(BUILDER_SOURCE, "/src/app.ts")

      expect(result).not.toBeNull()
      expect(result?.code).toContain("document.createElement")
    })

    it("produces HTML output when target is 'html'", () => {
      const { handler } = createTransformHandler({ target: "html" })
      const result = handler(BUILDER_SOURCE, "/src/app.ts")

      expect(result).not.toBeNull()
      // SSR output uses string concatenation for HTML
      expect(result?.code).toContain("<div>")
      expect(result?.code).toContain("<h1>")
      // Should NOT contain DOM calls
      expect(result?.code).not.toContain("document.createElement")
    })
  })

  describe("file filtering (shouldTransform)", () => {
    it("skips node_modules by default", () => {
      const { handler } = createTransformHandler()
      const result = handler(
        BUILDER_SOURCE,
        "/path/to/node_modules/pkg/file.ts",
      )
      expect(result).toBeNull()
    })

    it("skips files not matching extensions", () => {
      const { handler } = createTransformHandler()

      expect(handler(BUILDER_SOURCE, "/src/app.js")).toBeNull()
      expect(handler(BUILDER_SOURCE, "/src/app.css")).toBeNull()
    })

    it("respects custom extensions", () => {
      const { handler } = createTransformHandler({
        extensions: [".kyneta.ts"],
      })

      // Default .ts should be skipped
      expect(handler(BUILDER_SOURCE, "/src/app.ts")).toBeNull()

      // Custom extension should work
      const result = handler(BUILDER_SOURCE, "/src/app.kyneta.ts")
      expect(result).not.toBeNull()
      expect(result?.code).toContain("document.createElement")
    })

    it("respects include patterns", () => {
      const { handler } = createTransformHandler({
        include: ["src/components"],
      })

      // File in included directory — should transform
      const result = handler(
        BUILDER_SOURCE,
        "/project/src/components/Button.ts",
      )
      expect(result).not.toBeNull()

      // File outside included directory — should skip
      expect(handler(BUILDER_SOURCE, "/project/lib/utils.ts")).toBeNull()
    })

    it("respects exclude patterns", () => {
      const { handler } = createTransformHandler({
        exclude: ["node_modules", "generated"],
      })

      expect(handler(BUILDER_SOURCE, "/project/generated/code.ts")).toBeNull()

      const result = handler(BUILDER_SOURCE, "/project/src/app.ts")
      expect(result).not.toBeNull()
    })
  })

  describe("error handling", () => {
    it("does not crash on syntax errors", () => {
      const { handler } = createTransformHandler()

      const badSource = `
        div(() => {
          h1("Unclosed
        })
      `

      const result = handler(badSource, "/src/broken.ts")
      // Should return null or a result, but not throw
      expect(result === null || typeof result?.code === "string").toBe(true)
    })
  })
})
