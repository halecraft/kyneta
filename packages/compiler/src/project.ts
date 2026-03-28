/**
 * ts-morph Project management for the Kyneta compiler.
 *
 * Manages the shared Project singleton, source file parsing,
 * and @kyneta/schema module resolution.
 *
 * These functions were extracted from `@kyneta/cast`'s `transform.ts`
 * because they are compiler infrastructure, not target-specific logic.
 *
 * @packageDocumentation
 */

import { Project, type SourceFile, ts } from "ts-morph"
import { analyzeBuilder, findBuilderCalls } from "./analyze.js"
import type { BuilderNode } from "./ir.js"
import { resolveReactiveImports } from "./reactive-detection.js"

// =============================================================================
// Project Management
// =============================================================================

/**
 * Shared ts-morph project for parsing.
 * Lazily initialized on first use.
 */
let sharedProject: Project | null = null

/**
 * Get or create the shared ts-morph project.
 *
 * The project uses the real filesystem so that imports from node_modules
 * resolve naturally — no type stubs needed. The Vite plugin passes the
 * file's real absolute path, enabling ts-morph's module resolution to
 * find @kyneta/schema, @kyneta/cast, etc. via pnpm workspace symlinks.
 *
 * Key configuration:
 * - moduleResolution: Bundler (100) for pnpm compatibility
 * - skipFileDependencyResolution: true — we manually resolve external
 *   packages to avoid loading all of node_modules. This is necessary
 *   because TypeScript needs the .d.ts files to properly analyze types
 *   from external packages (like detecting [CHANGEFEED] properties).
 *
 * Do NOT use tsConfigFilePath — it's 500ms+ due to loading all files.
 */
function getProject(): Project {
  if (!sharedProject) {
    sharedProject = new Project({
      useInMemoryFileSystem: false,
      skipFileDependencyResolution: true, // We manually resolve needed modules
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
      },
    })
  }
  return sharedProject
}

/**
 * Reset the shared project (for testing).
 * @internal
 */
export function resetProject(): void {
  sharedProject = null
}

// =============================================================================
// Source File Handling
// =============================================================================

/**
 * Parse source code into a ts-morph SourceFile.
 *
 * After creating the source file, this resolves any @kyneta imports
 * so that TypeScript can fully analyze changefeed types (detecting
 * [CHANGEFEED] properties, etc.).
 */
export function parseSource(source: string, filename: string): SourceFile {
  const project = getProject()

  // Remove existing file if present (for re-parsing).
  // With real filesystem, ts-morph may auto-discover files from disk,
  // so we must remove before re-creating with new source content.
  const existing = project.getSourceFile(filename)
  if (existing) {
    project.removeSourceFile(existing)
  }

  const sourceFile = project.createSourceFile(filename, source, {
    overwrite: true,
  })

  // Resolve @kyneta imports so TypeScript can analyze changefeed types
  resolveReactiveImports(project, sourceFile)

  return sourceFile
}

// =============================================================================
// Builder Detection
// =============================================================================

/**
 * Check if source code contains builder calls (e.g., `div(...)`, `h1(...)`).
 *
 * Uses a two-phase approach:
 * 1. Quick regex heuristic — fast reject for files without element-like calls
 * 2. Full ts-morph parse — confirms actual builder patterns
 *
 * False positives from the regex are OK — they just trigger a parse.
 * False negatives would silently skip compilation, so the regex is intentionally broad.
 *
 * @param source - TypeScript source code
 * @returns true if the source contains builder calls
 */
export function hasBuilderCalls(source: string): boolean {
  // Quick regex check for common element names with function syntax
  // This is a heuristic - false positives are OK (will just parse and find nothing)
  const quickCheck =
    /\b(div|span|p|h[1-6]|ul|ol|li|a|button|input|form|table|section|article|header|footer|nav|main|aside)\s*\(/
  if (!quickCheck.test(source)) {
    return false
  }

  // Full parse to confirm
  try {
    const sourceFile = parseSource(source, "check.ts")
    const calls = findBuilderCalls(sourceFile)
    return calls.length > 0
  } catch {
    return false
  } finally {
    // Remove the temporary file to prevent duplicate type declarations
    // from interfering with subsequent transformSourceInPlace calls
    // that use the same shared project.
    try {
      const project = getProject()
      const checkFile = project.getSourceFile("check.ts")
      if (checkFile) {
        project.removeSourceFile(checkFile)
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

// =============================================================================
// Builder Analysis Pipeline
// =============================================================================

/**
 * Find and analyze all builder calls in a parsed source file.
 *
 * Returns an array of `{ call, ir }` pairs — one for each builder call
 * found in the source file. The `call` is the ts-morph CallExpression node
 * (useful for in-place replacement), and `ir` is the analyzed BuilderNode.
 *
 * @param sourceFile - The parsed source file
 * @param filename - Filename for error messages
 * @returns Array of { call, ir } pairs
 */
export function analyzeAllBuilders(
  sourceFile: SourceFile,
  _filename: string,
): Array<{ call: SourceFile extends infer _ ? any : never; ir: BuilderNode }> {
  const calls = findBuilderCalls(sourceFile)
  const results: Array<{ call: any; ir: BuilderNode }> = []

  for (const call of calls) {
    const builder = analyzeBuilder(call)
    if (builder) {
      results.push({ call, ir: builder })
    }
  }

  return results
}
