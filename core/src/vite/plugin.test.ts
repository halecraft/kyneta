/**
 * Vite Plugin Tests
 *
 * Tests for the Kinetic Vite plugin functionality.
 * Consolidated for high signal-to-maintenance ratio.
 */

import { describe, expect, it } from "vitest"
import kineticPlugin, { type KineticPluginOptions } from "./plugin.js"

describe("Vite Plugin", () => {
  describe("plugin creation", () => {
    it("should create a plugin with default options", () => {
      const plugin = kineticPlugin()

      expect(plugin.name).toBe("kinetic")
      expect(plugin.transform).toBeDefined()
      expect(plugin.handleHotUpdate).toBeDefined()
    })

    it("should create a plugin with custom options", () => {
      const options: KineticPluginOptions = {
        extensions: [".ts"],
        debug: true,
        exclude: ["node_modules", "dist"],
      }

      const plugin = kineticPlugin(options)
      expect(plugin.name).toBe("kinetic")
    })
  })

  describe("file filtering", () => {
    it("should transform .ts/.tsx files with builder calls", () => {
      const plugin = kineticPlugin()
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
      const plugin = kineticPlugin()
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
      const plugin = kineticPlugin({
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
      const plugin = kineticPlugin({
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

  describe("transform output", () => {
    it("should generate element factory functions", () => {
      const plugin = kineticPlugin()
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

      expect(result?.code).toContain("document.createElement")
      expect(result?.code).toContain("element0")
      expect(result?.code).toContain("// === Kinetic Compiled Output ===")
    })

    it("should preserve original source code", () => {
      const plugin = kineticPlugin()
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => { code: string } | null

      const source = `
        const greeting = "Hello"

        div(() => {
          h1(greeting)
        })
      `

      const result = transform(source, "/path/to/file.ts")

      // Original code should be preserved
      expect(result?.code).toContain('const greeting = "Hello"')
    })

    it("should compile multiple builder calls", () => {
      const plugin = kineticPlugin()
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

      // Should have multiple compiled elements
      expect(result?.code).toContain("element0")
      expect(result?.code).toContain("element1")
    })

    it("should not duplicate kinetic imports when merging", () => {
      const plugin = kineticPlugin()
      const transform = plugin.transform as (
        code: string,
        id: string,
      ) => { code: string } | null

      // Source that already has kinetic imports
      const source = `
        import { mount, Scope } from "@loro-extended/kinetic"

        div(() => {
          h1("Hello")
        })
      `

      const result = transform(source, "/path/to/file.ts")

      expect(result).not.toBeNull()

      // Count occurrences of the kinetic package reference
      // Should have at most 2: merged import + compiled section comment
      const importMatches = result?.code.match(/@loro-extended\/kinetic/g) || []
      expect(importMatches.length).toBeLessThanOrEqual(2)

      // Should still have the original imports preserved or merged
      expect(result?.code).toContain("mount")
      expect(result?.code).toContain("Scope")
    })
  })

  describe("error handling", () => {
    it("should not crash on invalid syntax", () => {
      const plugin = kineticPlugin()
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
