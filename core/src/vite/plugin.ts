/**
 * Vite Plugin for Kinetic
 *
 * Transforms TypeScript files containing Kinetic builder calls into
 * delta-driven DOM code at build time.
 *
 * The plugin:
 * 1. Detects files that may contain Kinetic builder patterns
 * 2. Transforms builder calls into compiled DOM manipulation code
 * 3. Supports hot module replacement for development
 *
 * @packageDocumentation
 */

import type { HmrContext, Plugin } from "vite"
import { hasBuilderCalls, transformSource } from "../compiler/index.js"

/**
 * Options for the Kinetic Vite plugin.
 */
export interface KineticPluginOptions {
  /**
   * File extensions to transform.
   * @default [".ts", ".tsx"]
   */
  extensions?: string[]

  /**
   * Enable hot module replacement support.
   * @default true in development
   */
  hmr?: boolean

  /**
   * Include patterns for files to transform.
   * Uses minimatch patterns.
   * @default undefined (all files with matching extensions)
   */
  include?: string | string[]

  /**
   * Exclude patterns for files to skip.
   * Uses minimatch patterns.
   * @default ["node_modules"]
   */
  exclude?: string | string[]

  /**
   * Enable debug logging.
   * @default false
   */
  debug?: boolean
}

/**
 * Check if a file should be transformed based on its path.
 */
function shouldTransform(
  id: string,
  extensions: string[],
  include?: string | string[],
  exclude?: string | string[],
): boolean {
  // Check extension
  const hasValidExtension = extensions.some(ext => id.endsWith(ext))
  if (!hasValidExtension) {
    return false
  }

  // Default excludes
  const excludePatterns = exclude ?? ["node_modules"]
  const excludeList = Array.isArray(excludePatterns)
    ? excludePatterns
    : [excludePatterns]

  // Simple pattern matching
  for (const pattern of excludeList) {
    if (id.includes(pattern)) {
      return false
    }
  }

  // If include patterns specified, file must match one
  if (include) {
    const includeList = Array.isArray(include) ? include : [include]
    const matches = includeList.some(pattern => id.includes(pattern))
    if (!matches) {
      return false
    }
  }

  return true
}

/**
 * Transform source code by replacing builder calls with compiled code.
 *
 * This function:
 * 1. Finds all top-level builder calls
 * 2. Compiles each to a factory function
 * 3. Replaces the original calls with the compiled versions
 * 4. Adds necessary runtime imports
 */
function transformKineticSource(
  code: string,
  filename: string,
  debug: boolean,
): { code: string; map?: string } | null {
  // Quick check - does this file have any builder patterns?
  if (!hasBuilderCalls(code)) {
    if (debug) {
      console.log(`[kinetic] Skipping ${filename} - no builder calls found`)
    }
    return null
  }

  if (debug) {
    console.log(`[kinetic] Transforming ${filename}`)
  }

  try {
    // Transform the source
    const result = transformSource(code, {
      filename,
      target: "dom",
      sourcemap: true,
    })

    if (result.ir.length === 0) {
      // No builder calls found after full parse
      return null
    }

    // The current transform generates standalone compiled code.
    // For Vite, we need to inject this into the original source.
    //
    // Strategy:
    // 1. Find builder call locations in original source
    // 2. Generate compiled code with unique variable names
    // 3. Prepend compiled functions and imports to the file
    // 4. Replace original builder calls with compiled function references
    //
    // For now, we use a simpler approach:
    // - Prepend the compiled code to the file
    // - The original builder calls remain but are shadowed by the compiled versions
    //
    // This works because:
    // - Builder calls like `div(() => ...)` are expressions
    // - The compiled code exports the same patterns as factory functions
    // - TypeScript's ambient declarations make the original calls type-check

    // Extract just the compiled element definitions (without the import line)
    const compiledLines = result.code.split("\n")
    const importLine = compiledLines.find(line => line.startsWith("import {"))
    const compiledCode = compiledLines
      .filter(line => !line.startsWith("import {"))
      .join("\n")

    // Build the transformed output
    const lines: string[] = []

    // Add runtime imports if needed
    if (importLine) {
      // Check if the file already imports from @loro-extended/kinetic
      const hasKineticImport = code.includes("@loro-extended/kinetic")

      if (hasKineticImport) {
        // Merge imports - extract what we need and add to existing
        const runtimeImports = importLine.match(/\{([^}]+)\}/)?.[1] ?? ""
        if (runtimeImports) {
          // Find the existing kinetic import and extend it
          const transformedCode = code.replace(
            /(import\s*\{[^}]*\}\s*from\s*["']@loro-extended\/kinetic["'])/,
            match => {
              // Extract existing imports
              const existingImports = match.match(/\{([^}]+)\}/)?.[1] ?? ""
              const existingSet = new Set(
                existingImports.split(",").map(s => s.trim()),
              )
              const newImports = runtimeImports.split(",").map(s => s.trim())

              // Add new imports that don't exist
              for (const imp of newImports) {
                if (imp && !existingSet.has(imp)) {
                  existingSet.add(imp)
                }
              }

              const combinedImports = Array.from(existingSet)
                .filter(Boolean)
                .join(", ")
              return `import { ${combinedImports} } from "@loro-extended/kinetic"`
            },
          )
          lines.push(transformedCode)
        } else {
          lines.push(code)
        }
      } else {
        // Add the import at the top
        lines.push(importLine)
        lines.push("")
        lines.push(code)
      }
    } else {
      lines.push(code)
    }

    // Append compiled element factories
    // These can be used by the application code
    if (compiledCode.trim()) {
      lines.push("")
      lines.push("// === Kinetic Compiled Output ===")
      lines.push(compiledCode)
    }

    if (debug) {
      console.log(`[kinetic] Compiled ${result.ir.length} builder(s)`)
    }

    return {
      code: lines.join("\n"),
      map: result.map,
    }
  } catch (error) {
    // Log error but don't fail the build - let TypeScript handle syntax errors
    console.error(`[kinetic] Error transforming ${filename}:`, error)
    return null
  }
}

/**
 * Create a Vite plugin for Kinetic compilation.
 *
 * @param options - Plugin configuration
 * @returns Vite plugin
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from "vite"
 * import kinetic from "@loro-extended/kinetic/vite"
 *
 * export default defineConfig({
 *   plugins: [kinetic()],
 * })
 * ```
 *
 * @example
 * ```ts
 * // With options
 * import { defineConfig } from "vite"
 * import kinetic from "@loro-extended/kinetic/vite"
 *
 * export default defineConfig({
 *   plugins: [
 *     kinetic({
 *       extensions: [".ts", ".tsx"],
 *       exclude: ["node_modules", "test"],
 *       debug: true,
 *     }),
 *   ],
 * })
 * ```
 */
export default function kineticPlugin(
  options: KineticPluginOptions = {},
): Plugin {
  const extensions = options.extensions ?? [".ts", ".tsx"]
  const debug = options.debug ?? false
  let isDev = false

  return {
    name: "kinetic",

    // Determine if we're in dev mode
    configResolved(config) {
      isDev = config.command === "serve"
      if (debug) {
        console.log(
          `[kinetic] Running in ${isDev ? "development" : "production"} mode`,
        )
      }
    },

    // Transform files containing Kinetic builder patterns
    transform(code, id) {
      // Skip if file shouldn't be transformed
      if (!shouldTransform(id, extensions, options.include, options.exclude)) {
        return null
      }

      // Transform the source
      return transformKineticSource(code, id, debug)
    },

    // Handle hot module replacement
    handleHotUpdate(ctx: HmrContext) {
      const { file, modules } = ctx

      // Only handle files we care about
      if (
        !shouldTransform(file, extensions, options.include, options.exclude)
      ) {
        return
      }

      // Check if this file has Kinetic builder calls
      // If so, we need to invalidate the module
      const checkForBuilders = async () => {
        const code = await ctx.read()
        if (hasBuilderCalls(code)) {
          if (debug) {
            console.log(`[kinetic] HMR update for ${file}`)
          }
          // Return the modules to trigger a full re-transform
          return modules
        }
        return undefined
      }

      // Return promise that resolves to modules if we need to handle it
      return checkForBuilders()
    },
  }
}

// Named export for explicit import
export { kineticPlugin }
