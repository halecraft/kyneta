/**
 * Host-agnostic transform logic for Kyneta build plugins.
 *
 * Extracted from the Vite plugin so that all bundler adapters
 * (via unplugin) share identical compilation behavior.
 *
 * @packageDocumentation
 */

import { hasBuilderCalls } from "@kyneta/compiler"
import {
  mergeImports,
  transformSourceInPlace,
} from "../compiler/transform.js"

/**
 * Transform source code by replacing builder calls with compiled code in-place.
 *
 * This function:
 * 1. Checks for builder patterns via fast regex pre-scan
 * 2. Parses and transforms each builder call into compiled DOM/HTML code
 * 3. Merges required `@kyneta/core/runtime` imports
 *
 * @param code - The source code to transform
 * @param filename - The file path (used for diagnostics and ts-morph)
 * @param target - Compile target: `"dom"` for client, `"html"` for SSR
 * @param debug - Whether to log transformation details
 * @returns The transformed code, or `null` if no builder calls were found
 */
export function transformKynetaSource(
  code: string,
  filename: string,
  target: "dom" | "html",
  debug: boolean,
): { code: string; map?: string } | null {
  // Quick check — does this file have any builder patterns?
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
    // Log error but don't fail the build — let TypeScript handle syntax errors
    console.error(`[kyneta] Error transforming ${filename}:`, error)
    return null
  }
}