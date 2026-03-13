/**
 * Vite Plugin for Kyneta
 *
 * Transforms TypeScript files containing Kyneta builder calls into
 * delta-driven DOM code at build time.
 *
 * The plugin:
 * 1. Detects files that may contain Kyneta builder patterns
 * 2. Transforms builder calls into compiled DOM manipulation code in-place
 * 3. Supports hot module replacement for development
 *
 * @packageDocumentation
 */

import type { HmrContext, Plugin } from "vite"
import {
  hasBuilderCalls,
  mergeImports,
  transformSourceInPlace,
} from "../compiler/index.js"

/**
 * Options for the Kyneta Vite plugin.
 */
export interface KynetaPluginOptions {
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
 * Transform source code by replacing builder calls with compiled code in-place.
 *
 * This function:
 * 1. Finds all builder calls in the source
 * 2. Replaces each with its compiled factory function
 * 3. Merges required runtime imports
 */
function transformKynetaSource(
  code: string,
  filename: string,
  target: "dom" | "html",
  debug: boolean,
): { code: string; map?: string } | null {
  // Quick check - does this file have any builder patterns?
  if (!hasBuilderCalls(code)) {
    if (debug) {
      console.log(`[kyneta] Skipping ${filename} - no builder calls found`)
    }
    return null
  }

  if (debug) {
    console.log(`[kyneta] Transforming ${filename}`)
  }

  try {
    // Transform the source in-place using the specified target
    const result = transformSourceInPlace(code, {
      filename,
      target,
    })

    if (result.ir.length === 0) {
      // No builder calls found after full parse
      return null
    }

    // Merge required imports into the source file
    mergeImports(result.sourceFile, result.requiredImports)

    if (debug) {
      console.log(`[kyneta] Compiled ${result.ir.length} builder(s)`)
    }

    return {
      code: result.sourceFile.getFullText(),
      map: undefined, // TODO: Generate source maps
    }
  } catch (error) {
    // Log error but don't fail the build - let TypeScript handle syntax errors
    console.error(`[kyneta] Error transforming ${filename}:`, error)
    return null
  }
}

/**
 * Create a Vite plugin for Kyneta compilation.
 *
 * @param options - Plugin configuration
 * @returns Vite plugin
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from "vite"
 * import kyneta from "@kyneta/core/vite"
 *
 * export default defineConfig({
 *   plugins: [kyneta()],
 * })
 * ```
 *
 * @example
 * ```ts
 * // With options
 * import { defineConfig } from "vite"
 * import kyneta from "@kyneta/core/vite"
 *
 * export default defineConfig({
 *   plugins: [
 *     kyneta({
 *       extensions: [".ts", ".tsx"],
 *       exclude: ["node_modules", "test"],
 *       debug: true,
 *     }),
 *   ],
 * })
 * ```
 */
export default function kynetaPlugin(
  options: KynetaPluginOptions = {},
): Plugin {
  const extensions = options.extensions ?? [".ts", ".tsx"]
  const debug = options.debug ?? false
  let isDev = false

  return {
    name: "kyneta",

    // Run before esbuild strips TypeScript types.
    // The compiler needs type annotations (interface, type imports, etc.)
    // to detect reactive types like ListRef, TextRef, CounterRef.
    enforce: "pre",

    // Determine if we're in dev mode
    configResolved(config) {
      isDev = config.command === "serve"
      if (debug) {
        console.log(
          `[kyneta] Running in ${isDev ? "development" : "production"} mode`,
        )
      }
    },

    // Transform files containing Kyneta builder patterns
    transform(code, id, transformOptions) {
      // Skip if file shouldn't be transformed
      if (!shouldTransform(id, extensions, options.include, options.exclude)) {
        return null
      }

      // Auto-detect target from Vite's SSR context.
      // When the server calls vite.ssrLoadModule(), Vite passes ssr: true.
      // This means the same app.ts is compiled to HTML for the server and
      // DOM for the client — no separate files or configuration needed.
      const target = transformOptions?.ssr ? "html" : "dom"

      // Transform the source
      return transformKynetaSource(code, id, target, debug)
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

      // Check if this file has Kyneta builder calls
      // If so, we need to invalidate the module
      const checkForBuilders = async () => {
        const code = await ctx.read()
        if (hasBuilderCalls(code)) {
          if (debug) {
            console.log(`[kyneta] HMR update for ${file}`)
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
export { kynetaPlugin }

/** @deprecated Use KynetaPluginOptions instead */
export type { KynetaPluginOptions as KineticPluginOptions }
/** @deprecated Use kynetaPlugin instead */
export { kynetaPlugin as kineticPlugin }