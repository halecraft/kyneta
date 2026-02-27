/**
 * Transform Orchestration for Kinetic Compiler
 *
 * This module is the "imperative shell" that orchestrates the compilation process.
 * It coordinates between analysis (AST → IR) and code generation (IR → output).
 *
 * Responsibilities:
 * - Load and parse source files with ts-morph
 * - Call analysis to produce IR
 * - Select appropriate code generator (DOM or HTML)
 * - Handle source maps
 * - Report errors with source locations
 *
 * @packageDocumentation
 */

import { Project, type SourceFile } from "ts-morph"
import { CompilerError, KineticErrorCode } from "../errors.js"
import { analyzeBuilder, findBuilderCalls } from "./analyze.js"
import { generateElementFactory } from "./codegen/dom.js"
import { generateEscapeHelper, generateHTML } from "./codegen/html.js"
import type { BuilderNode } from "./ir.js"

// =============================================================================
// Types
// =============================================================================

/**
 * Compilation target.
 */
export type CompileTarget = "dom" | "html"

/**
 * Options for transformation.
 */
export interface TransformOptions {
  /**
   * The compilation target.
   * - "dom": Generate DOM manipulation code (for client)
   * - "html": Generate HTML string code (for SSR)
   * @default "dom"
   */
  target?: CompileTarget

  /**
   * Source file path (for error reporting and source maps).
   */
  filename?: string

  /**
   * Enable source map generation.
   * @default false
   */
  sourcemap?: boolean

  /**
   * Include hydration markers in HTML output.
   * @default true
   */
  hydratable?: boolean
}

/**
 * Result of transformation.
 */
export interface TransformResult {
  /**
   * The transformed code.
   */
  code: string

  /**
   * Source map (if requested).
   */
  map?: string

  /**
   * The IR nodes that were generated (for debugging/testing).
   */
  ir: BuilderNode[]
}

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
 */
function getProject(): Project {
  if (!sharedProject) {
    sharedProject = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        target: 99, // ESNext
        module: 99, // ESNext
        moduleResolution: 2, // NodeJs
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
export function __resetProject(): void {
  sharedProject = null
}

// =============================================================================
// Source File Handling
// =============================================================================

/**
 * Parse source code into a ts-morph SourceFile.
 */
function parseSource(source: string, filename: string): SourceFile {
  const project = getProject()

  // Remove existing file if present (for re-parsing)
  const existing = project.getSourceFile(filename)
  if (existing) {
    project.removeSourceFile(existing)
  }

  return project.createSourceFile(filename, source)
}

// =============================================================================
// Code Generation Helpers
// =============================================================================

/**
 * Generate imports for the runtime functions used in DOM output.
 */
function generateDOMImports(ir: BuilderNode[]): string {
  const imports = new Set<string>()

  function collectImportsFromChildren(
    children: (typeof ir)[0]["children"],
  ): void {
    for (const child of children) {
      if (child.kind === "list-region") {
        imports.add("__listRegion")
        collectImportsFromChildren(child.body)
      } else if (child.kind === "conditional-region") {
        if (child.subscriptionTarget) {
          imports.add("__conditionalRegion")
        } else {
          imports.add("__staticConditionalRegion")
        }
        for (const branch of child.branches) {
          collectImportsFromChildren(branch.body)
        }
      } else if (child.kind === "element") {
        // Check for bindings on elements
        for (const binding of child.bindings) {
          if (binding.bindingType === "checked") {
            imports.add("__bindChecked")
          } else {
            imports.add("__bindTextValue")
          }
        }
        // Recurse into element children
        collectImportsFromChildren(child.children)
      }
    }
  }

  function collectImports(node: BuilderNode): void {
    if (node.isReactive) {
      imports.add("__subscribe")
      imports.add("__subscribeWithValue")
    }

    collectImportsFromChildren(node.children)
  }

  for (const builder of ir) {
    collectImports(builder)
  }

  if (imports.size === 0) {
    return ""
  }

  const importList = Array.from(imports).sort().join(", ")
  return `import { ${importList} } from "@loro-extended/kinetic"\n`
}

/**
 * Generate the full transformed code for DOM target.
 */
function generateDOMOutput(
  ir: BuilderNode[],
  _options: TransformOptions,
): string {
  const lines: string[] = []

  // Add imports
  const imports = generateDOMImports(ir)
  if (imports) {
    lines.push(imports)
  }

  // Generate each builder as a function
  for (let i = 0; i < ir.length; i++) {
    const builder = ir[i]
    const varName = `element${i}`

    lines.push(`const ${varName} = ${generateElementFactory(builder)}`)
    lines.push("")
  }

  return lines.join("\n")
}

/**
 * Generate the full transformed code for HTML target.
 */
function generateHTMLOutput(
  ir: BuilderNode[],
  options: TransformOptions,
): string {
  const lines: string[] = []

  // Add escape helper
  lines.push(generateEscapeHelper())
  lines.push("")

  // Generate each builder as a render function
  for (let i = 0; i < ir.length; i++) {
    const builder = ir[i]
    const varName = `render${i}`

    const html = generateHTML(builder, {
      hydratable: options.hydratable ?? true,
    })
    lines.push(`const ${varName} = () => ${html}`)
    lines.push("")
  }

  return lines.join("\n")
}

// =============================================================================
// Main Transform Functions
// =============================================================================

/**
 * Transform source code.
 *
 * This is the main entry point for the compiler.
 *
 * @param source - TypeScript source code
 * @param options - Transform options
 * @returns Transform result with code and IR
 */
export function transformSource(
  source: string,
  options: TransformOptions = {},
): TransformResult {
  const filename = options.filename ?? "input.ts"
  const target = options.target ?? "dom"

  // Parse the source
  let sourceFile: SourceFile
  try {
    sourceFile = parseSource(source, filename)
  } catch (e) {
    throw new CompilerError(
      KineticErrorCode.COMPILER_PARSE_ERROR,
      `Failed to parse source: ${e instanceof Error ? e.message : String(e)}`,
      { file: filename, line: 1, column: 0 },
    )
  }

  // Find and analyze builder calls
  const calls = findBuilderCalls(sourceFile)
  const ir: BuilderNode[] = []

  for (const call of calls) {
    try {
      const builder = analyzeBuilder(call)
      if (builder) {
        ir.push(builder)
      }
    } catch (e) {
      const line = call.getStartLineNumber()
      const col = call.getStart() - call.getStartLinePos()
      throw new CompilerError(
        KineticErrorCode.COMPILER_TRANSFORM_ERROR,
        `Failed to analyze builder call: ${e instanceof Error ? e.message : String(e)}`,
        { file: filename, line, column: col },
      )
    }
  }

  // Generate output code
  let code: string
  if (target === "html") {
    code = generateHTMLOutput(ir, options)
  } else {
    code = generateDOMOutput(ir, options)
  }

  // TODO: Generate source maps if requested
  const map = options.sourcemap ? undefined : undefined

  return { code, ir, map }
}

/**
 * Transform a ts-morph SourceFile.
 *
 * Use this when you already have a SourceFile from a ts-morph Project.
 *
 * @param sourceFile - The source file to transform
 * @param options - Transform options
 * @returns Transform result with code and IR
 */
export function transformFile(
  sourceFile: SourceFile,
  options: TransformOptions = {},
): TransformResult {
  const filename = options.filename ?? sourceFile.getFilePath()
  const target = options.target ?? "dom"

  // Find and analyze builder calls
  const calls = findBuilderCalls(sourceFile)
  const ir: BuilderNode[] = []

  for (const call of calls) {
    try {
      const builder = analyzeBuilder(call)
      if (builder) {
        ir.push(builder)
      }
    } catch (e) {
      const line = call.getStartLineNumber()
      const col = call.getStart() - call.getStartLinePos()
      throw new CompilerError(
        KineticErrorCode.COMPILER_TRANSFORM_ERROR,
        `Failed to analyze builder call: ${e instanceof Error ? e.message : String(e)}`,
        { file: filename, line, column: col },
      )
    }
  }

  // Generate output code
  let code: string
  if (target === "html") {
    code = generateHTMLOutput(ir, options)
  } else {
    code = generateDOMOutput(ir, options)
  }

  // TODO: Generate source maps if requested
  const map = options.sourcemap ? undefined : undefined

  return { code, ir, map }
}

/**
 * Check if source code contains any kinetic builder calls.
 *
 * This is useful for the Vite plugin to quickly determine if transformation is needed.
 *
 * @param source - Source code to check
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
  }
}
