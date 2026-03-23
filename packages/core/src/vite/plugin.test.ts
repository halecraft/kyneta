/**
 * Vite Plugin Tests
 *
 * Tests for the Kyneta Vite plugin functionality.
 * Updated for in-place builder replacement behavior.
 */

import type { Plugin } from "vite"
import { describe, expect, it } from "vitest"
import kynetaPlugin, { type KynetaPluginOptions } from "./plugin.js"

/** Narrow the plugin return (Vite 6 may return Plugin | Plugin[]) */
function getPlugin(options?: KynetaPluginOptions): Plugin {
  const result = kynetaPlugin(options)
  if (Array.isArray(result)) return result[0]!
  return result
}

describe("Vite Plugin", () => {
  describe("plugin creation", () => {
    it("should create a plugin with default options", () => {
      const plugin = getPlugin()

      expect(plugin.name).toBe("kyneta")
      expect(plugin.transform).toBeDefined()
      expect(plugin.handleHotUpdate).toBeDefined()
    })

    it("should create a plugin with custom options", () => {
      const options: KynetaPluginOptions = {
        extensions: [".ts"],
        debug: true,
        exclude: ["node_modules", "dist"],
      }

      const plugin = getPlugin(options)
      expect(plugin.name).toBe("kyneta")
    })
  })

  describe("file filtering", () => {
    it("should transform .ts/.tsx files with builder calls", () => {
      const plugin = getPlugin()
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => { code: string } | null

      const builderCode = 'div(() => { h1("Hello") })'
      const noBuilderCode = "const x = 1\nfunction foo() { return x }"

      // Should transform .ts files with builders
      expect(transform(builderCode, "/src/app.ts")).not.toBeNull()

      // Should transform .tsx files with builders
      expect(transform(builderCode, "/src/App.tsx")).not.toBeNull()

      // Should skip files without builder calls
      expect(transform(noBuilderCode, "/src/utils.ts")).toBeNull()
    })

    it("should skip excluded files and non-matching extensions", () => {
      const plugin = getPlugin()
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => { code: string } | null

      const builderCode = 'div(() => { h1("Hello") })'

      // Should skip node_modules
      expect(
        transform(builderCode, "/path/to/node_modules/pkg/file.ts"),
      ).toBeNull()

      // Should skip .js files (not in default extensions)
      expect(transform(builderCode, "/src/file.js")).toBeNull()

      // Should skip non-code files
      expect(transform(builderCode, "/src/styles.css")).toBeNull()
    })

    it("should respect custom include/exclude patterns", () => {
      const plugin = getPlugin({
        include: ["src/components"],
        exclude: ["node_modules", "generated"],
      })
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => { code: string } | null

      const builderCode = 'div(() => { h1("Hello") })'

      // Should transform files matching include pattern
      expect(
        transform(builderCode, "/path/to/src/components/Button.ts"),
      ).not.toBeNull()

      // Should skip files not matching include pattern
      expect(transform(builderCode, "/path/to/lib/file.ts")).toBeNull()

      // Should skip files matching exclude pattern
      expect(transform(builderCode, "/path/to/generated/file.ts")).toBeNull()
    })

    it("should respect custom extensions", () => {
      const plugin = getPlugin({
        extensions: [".kinetic.ts"],
      })
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => { code: string } | null

      const builderCode = 'div(() => { h1("Hello") })'

      // Should skip standard .ts (not in custom extensions)
      expect(transform(builderCode, "/path/to/file.ts")).toBeNull()

      // Should transform custom extension
      expect(transform(builderCode, "/path/to/file.kinetic.ts")).not.toBeNull()
    })
  })

  describe("in-place replacement", () => {
    it("should replace builder calls with compiled factory functions", () => {
      const plugin = getPlugin()
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => { code: string } | null

      const source = `
        div(() => {
          h1("Title")
          p("Content")
        })
      `

      const result = transform(source, "/path/to/file.ts")

      // Should contain compiled DOM code
      expect(result?.code).toContain("document.createElement")
      // Should NOT contain original builder call syntax
      expect(result?.code).not.toContain("div(() =>")
      expect(result?.code).not.toContain("h1(")
      expect(result?.code).not.toContain("p(")
    })

    it("should preserve non-builder code", () => {
      const plugin = getPlugin()
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => { code: string } | null

      const source = `
        const greeting = "Hello"
        const count = 42

        const app = div(() => {
          h1(greeting)
        })

        function helper() {
          return count * 2
        }
      `

      const result = transform(source, "/path/to/file.ts")

      // Non-builder code should be preserved
      expect(result?.code).toContain('const greeting = "Hello"')
      expect(result?.code).toContain("const count = 42")
      expect(result?.code).toContain("function helper()")
      expect(result?.code).toContain("return count * 2")
      // Builder assignment should now have compiled code
      expect(result?.code).toContain("const app =")
      expect(result?.code).toContain("document.createElement")
    })

    it("should compile multiple builder calls in place", () => {
      const plugin = getPlugin()
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => { code: string } | null

      const source = `
        const header = div(() => {
          h1("Header")
        })

        const footer = div(() => {
          p("Footer")
        })
      `

      const result = transform(source, "/path/to/file.ts")

      // Both assignments should be preserved with compiled code
      expect(result?.code).toContain("const header =")
      expect(result?.code).toContain("const footer =")
      // Should have compiled DOM code (multiple createElement calls)
      const createElementCount = (
        result?.code.match(/document\.createElement/g) || []
      ).length
      expect(createElementCount).toBeGreaterThanOrEqual(2)
      // Should NOT contain original builder patterns
      expect(result?.code).not.toContain("div(() =>")
    })

    it("should not contain duplicate code (no append)", () => {
      const plugin = getPlugin()
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => { code: string } | null

      const source = `
        const app = div(() => {
          h1("Hello")
        })
      `

      const result = transform(source, "/path/to/file.ts")

      // Should NOT have the old "Kyneta Compiled Output" comment
      expect(result?.code).not.toContain("// === Kyneta Compiled Output ===")
      // Should have exactly one assignment to app
      const appAssignments = (result?.code.match(/const app =/g) || []).length
      expect(appAssignments).toBe(1)
    })
  })

  describe("import handling", () => {
    it("should add runtime imports when needed for list regions", () => {
      const plugin = getPlugin()
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => { code: string } | null

      // Source with a for-of loop that needs listRegion
      const source = `
        import { CHANGEFEED, type Changefeed, type HasChangefeed } from "@kyneta/schema"
        type SequenceChange<T = unknown> = { readonly type: "sequence"; readonly ops: readonly unknown[] }
        interface ListRef<T> extends HasChangefeed<T[], SequenceChange<T>> { readonly [CHANGEFEED]: Changefeed<T[], SequenceChange<T>>; readonly length: number; at(index: number): T | undefined; [Symbol.iterator](): Iterator<T> }
        declare const items: ListRef<string>

        const app = div(() => {
          for (const item of items) {
            li(item)
          }
        })
      `

      const result = transform(source, "component.ts")

      // Should have listRegion import from /runtime
      expect(result?.code).toContain("listRegion")
      expect(result?.code).toContain('@kyneta/core/runtime"')
    })

    it("should merge imports with existing kyneta imports", () => {
      const plugin = getPlugin()
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => { code: string } | null

      // Source that already has kyneta imports
      const source = `
        import { mount, Scope } from "@kyneta/core"

        div(() => {
          h1("Hello")
        })
      `

      const result = transform(source, "/path/to/file.ts")

      expect(result).not.toBeNull()

      // Original kyneta import should still be there
      expect(result?.code).toContain("mount")
      expect(result?.code).toContain("Scope")
      expect(result?.code).toContain('@kyneta/core"')
    })

    it("should not add imports for static-only builders", () => {
      const plugin = getPlugin()
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => { code: string } | null

      // Simple static builder that doesn't need runtime imports
      const source = `
        const app = div(() => {
          h1("Static Title")
          p("Static Content")
        })
      `

      const result = transform(source, "/path/to/file.ts")

      // Should not have subscribe or other runtime imports
      // (static content doesn't need subscriptions)
      expect(result?.code).not.toContain("subscribe")
      expect(result?.code).not.toContain("listRegion")
      expect(result?.code).not.toContain("conditionalRegion")
    })
  })

  describe("error handling", () => {
    it("should not crash on invalid syntax", () => {
      const plugin = getPlugin()
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => { code: string } | null

      // This has a syntax error but shouldn't crash the plugin
      const source = `
        div(() => {
          h1("Unclosed
        })
      `

      // Should return null or handle gracefully
      const result = transform(source, "/path/to/file.ts")
      // Either null (skipped) or contains the original code
      expect(result === null || typeof result?.code === "string").toBe(true)
    })
  })
})
