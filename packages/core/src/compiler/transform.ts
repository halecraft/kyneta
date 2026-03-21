/**
 * Transform Orchestration for Kyneta Compiler
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

import { type CallExpression, type SourceFile } from "ts-morph"
import { CompilerError, KynetaErrorCode } from "../errors.js"
import {
  generateElementFactory,
  generateElementFactoryWithResult,
} from "./codegen/dom.js"
import {
  generateEscapeHelper,
  generateHTML,
  generateRenderFunction,
} from "./codegen/html.js"
import {
  dissolveConditionals,
  filterTargetBlocks,
} from "./ir-transforms.js"
import {
  analyzeAllBuilders,
  isInputTextRegionAttribute,
  isTextRegionContent,
  parseSource,
  resetProject,
} from "@kyneta/compiler"
import type { BuilderNode, ChildNode } from "@kyneta/compiler"

// =============================================================================
// Types
// =============================================================================

/**
 * Compilation target for the web rendering package.
 *
 * - "dom": Generate DOM manipulation code (for client)
 * - "html": Generate HTML string code (for SSR)
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

/**
 * Result of in-place transformation.
 */
export interface TransformInPlaceResult {
  /**
   * The mutated source file (call getFullText() to get the code).
   */
  sourceFile: SourceFile

  /**
   * The IR nodes that were generated.
   */
  ir: BuilderNode[]

  /**
   * The imports required by the generated code.
   */
  requiredImports: {
    runtime: Set<string>
  }
}

// =============================================================================
// Project Management (delegated to @kyneta/compiler)
// =============================================================================
// getProject, resetProject, parseSource, hasBuilderCalls, and analyzeAllBuilders
// are imported from @kyneta/compiler. See packages/compiler/src/project.ts.

// =============================================================================
// Import Collection (Functional Core)
// =============================================================================

/**
 * Collect required runtime imports from IR nodes.
 *
 * This is a pure function that analyzes the IR and returns the set
 * of runtime function names that need to be imported from
 * `@kyneta/core/runtime`.
 *
 * @param ir - Array of builder nodes to analyze
 * @returns Object with `runtime` import set
 */
export function collectRequiredImports(ir: BuilderNode[]): {
  runtime: Set<string>
} {
  const runtime = new Set<string>()

  function collectFromChildren(children: ChildNode[]): void {
    for (const child of children) {
      if (child.kind === "loop") {
        if (child.iterableBindingTime === "reactive") {
          runtime.add("listRegion")
        }
        // Always recurse into loop body (fixes latent bug where
        // static-loop bodies were not recursed for imports)
        collectFromChildren(child.body)
      } else if (child.kind === "conditional") {
        // Only add conditionalRegion for reactive conditionals
        if (child.subscriptionTarget !== null) {
          runtime.add("conditionalRegion")
        }
        // Always recurse into branch bodies
        for (const branch of child.branches) {
          collectFromChildren(branch.body)
        }
      } else if (child.kind === "element") {
        for (const attr of child.attributes) {
          // Reactive attributes use valueRegion (except inputTextRegion)
          if (
            attr.value.bindingTime === "reactive" &&
            attr.value.dependencies.length > 0
          ) {
            if (isInputTextRegionAttribute(attr)) {
              runtime.add("inputTextRegion")
            } else {
              runtime.add("valueRegion")
            }
          }
        }
        // Recurse into element children
        collectFromChildren(child.children)
      } else if (child.kind === "content") {
        if (isTextRegionContent(child)) {
          runtime.add("textRegion")
        } else if (child.bindingTime === "reactive" && child.dependencies.length > 0) {
          // Non-textRegion reactive content uses valueRegion
          runtime.add("valueRegion")
        }
        // Check if synthesized source contains read() call
        if (child.directReadSource) {
          runtime.add("read")
        }
      }
    }
  }

  function collectFromBuilder(node: BuilderNode): void {
    collectFromChildren(node.children)
  }

  for (const builder of ir) {
    collectFromBuilder(builder)
  }

  return { runtime }
}

/**
 * Generate import statement string from a set of import names and module specifier.
 *
 * @param imports - Set of import names
 * @param moduleSpecifier - The module to import from
 * @returns Import statement string, or empty string if no imports needed
 */
function formatImportStatement(
  imports: Set<string>,
  moduleSpecifier: string,
): string {
  if (imports.size === 0) {
    return ""
  }
  const importList = Array.from(imports).sort().join(", ")
  return `import { ${importList} } from "${moduleSpecifier}"\n`
}

/**
 * Generate imports for the runtime functions used in DOM output.
 */
function generateDOMImports(ir: BuilderNode[]): string {
  const { runtime } = collectRequiredImports(ir)
  return formatImportStatement(runtime, "@kyneta/core/runtime")
}

// =============================================================================
// Import Merging (Imperative Shell)
// =============================================================================

/**
 * Merge required imports into a source file for a specific module.
 *
 * This function modifies the source file in place:
 * - If an import for the module exists, add missing named imports to it
 * - If no such import exists, add a new import declaration at the top
 *
 * @param sourceFile - The ts-morph SourceFile to modify
 * @param requiredImports - Set of import names to ensure are present
 * @param moduleSpecifier - The module to import from
 */
function mergeImportsForModule(
  sourceFile: SourceFile,
  requiredImports: Set<string>,
  moduleSpecifier: string,
): void {
  if (requiredImports.size === 0) {
    return
  }

  // Find existing import for this module
  const existingImport = sourceFile.getImportDeclarations().find(decl => {
    return decl.getModuleSpecifierValue() === moduleSpecifier
  })

  if (existingImport) {
    // Get existing named imports
    const namedImports = existingImport.getNamedImports()
    const existingNames = new Set(namedImports.map(ni => ni.getName()))

    // Add missing imports
    for (const importName of requiredImports) {
      if (!existingNames.has(importName)) {
        existingImport.addNamedImport(importName)
      }
    }
  } else {
    // Add new import at the top of the file
    const importNames = Array.from(requiredImports).sort()
    sourceFile.insertImportDeclaration(0, {
      moduleSpecifier,
      namedImports: importNames,
    })
  }
}

/**
 * Merge required imports into a source file.
 *
 * This function modifies the source file in place, adding imports from
 * `@kyneta/core/runtime`.
 *
 * @param sourceFile - The ts-morph SourceFile to modify
 * @param requiredImports - Object with `runtime` import set
 */
export function mergeImports(
  sourceFile: SourceFile,
  requiredImports: { runtime: Set<string> },
): void {
  mergeImportsForModule(
    sourceFile,
    requiredImports.runtime,
    "@kyneta/core/runtime",
  )
}

// =============================================================================
// Shared Analysis Helper
// =============================================================================

/**
 * Find and analyze all builder calls in a source file.
 *
 * Returns `{ call, ir }` pairs so that callers needing AST references
 * (e.g., `transformSourceInPlace` for position-based replacement) can
 * use the `call` directly, while callers that only need IR can map
 * to `.map(r => r.ir)`.
 *
 * @param sourceFile - The parsed source file
 * @param filename - Filename for error messages
 * @returns Array of { call, ir } pairs
 */


// =============================================================================
// In-Place Transformation (Imperative Shell)
// =============================================================================

/**
 * Transform source code in-place by replacing builder calls.
 *
 * This function:
 * 1. Parses the source into a ts-morph SourceFile
 * 2. Finds and analyzes all builder calls
 * 3. Replaces each builder call with its compiled factory code
 * 4. Returns the mutated source file and required imports
 *
 * Use this for Vite plugin / build tool integration where you want
 * to preserve the original file structure and only replace builder calls.
 *
 * @param source - TypeScript source code
 * @param options - Transform options
 * @returns Result with mutated source file, IR, and required imports
 */
export function transformSourceInPlace(
  source: string,
  options: TransformOptions = {},
): TransformInPlaceResult {
  const filename = options.filename ?? "input.ts"

  // Parse the source
  let sourceFile: SourceFile
  try {
    sourceFile = parseSource(source, filename)
  } catch (e) {
    throw new CompilerError(
      KynetaErrorCode.COMPILER_PARSE_ERROR,
      `Failed to parse source: ${e instanceof Error ? e.message : String(e)}`,
      { file: filename, line: 1, column: 0 },
    )
  }

  // Analyze all builder calls using shared helper
  const replacements = analyzeAllBuilders(sourceFile, filename)

  // Apply IR transforms: filter target blocks, dissolve conditionals
  const target = options.target ?? "dom"
  for (const r of replacements) {
    r.ir = filterTargetBlocks(r.ir, target)
    r.ir = dissolveConditionals(r.ir)
  }

  // Collect IR nodes and required imports AFTER transforms
  // (so dissolved conditionals don't produce unnecessary conditionalRegion imports)
  const ir = replacements.map(r => r.ir)
  const requiredImports = collectRequiredImports(ir)

  // Sort replacements by position descending (process back-to-front)
  // This ensures that replacing earlier nodes doesn't shift the positions
  // of later nodes that we still need to replace
  replacements.sort((a, b) => b.call.getStart() - a.call.getStart())

  // Collect all module declarations from template cloning
  const allModuleDeclarations: string[] = []

  // Running template counter shared across all builders in this file.
  // Each generateElementFactoryWithResult call starts where the previous
  // one left off, preventing duplicate _tmpl_0 declarations when a file
  // contains multiple builders (e.g., component definition + usage).
  let templateCounterOffset = 0

  for (const { call, ir: builderIr } of replacements) {
    if (target === "html") {
      const factoryCode = generateRenderFunction(builderIr, {
        hydratable: options.hydratable ?? true,
      })
      call.replaceWithText(factoryCode)
    } else {
      // Use template cloning for DOM target
      const result = generateElementFactoryWithResult(builderIr, {
        templateCounterOffset,
      })
      templateCounterOffset += result.moduleDeclarations.length
      call.replaceWithText(result.code)
      allModuleDeclarations.push(...result.moduleDeclarations)
    }
  }

  // For HTML target, inject the __escapeHtml helper into the source file.
  // The HTML codegen emits calls to __escapeHtml() in template literals.
  if (target === "html" && ir.length > 0) {
    sourceFile.insertStatements(0, generateEscapeHelper())
  }

  // For DOM target with template cloning, inject template declarations at top of file
  // This is done AFTER replacements to avoid invalidating AST references
  if (target === "dom" && allModuleDeclarations.length > 0) {
    // Insert all declarations as statements at the top
    for (const decl of allModuleDeclarations) {
      sourceFile.insertStatements(0, decl)
    }
  }

  return {
    sourceFile,
    ir,
    requiredImports,
  }
}

// =============================================================================
// Standalone Code Generation
// =============================================================================

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

  // Generate each builder as a render function with block body
  for (let i = 0; i < ir.length; i++) {
    const builder = ir[i]
    const varName = `render${i}`

    const htmlLines = generateHTML(builder, {
      hydratable: options.hydratable ?? true,
    })
    lines.push(`const ${varName} = () => { ${htmlLines.join("; ")} }`)
    lines.push("")
  }

  return lines.join("\n")
}

// =============================================================================
// Main Transform Functions
// =============================================================================

/**
 * Transform source code to standalone compiled output.
 *
 * This is the main entry point for standalone compilation (tests, CLI).
 * It generates a complete file with imports and element factories.
 *
 * For Vite/build tool integration, use `transformSourceInPlace` instead.
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

  // Parse the source and delegate to transformFile
  let sourceFile: SourceFile
  try {
    sourceFile = parseSource(source, filename)
  } catch (e) {
    throw new CompilerError(
      KynetaErrorCode.COMPILER_PARSE_ERROR,
      `Failed to parse source: ${e instanceof Error ? e.message : String(e)}`,
      { file: filename, line: 1, column: 0 },
    )
  }

  return transformFile(sourceFile, options)
}

/**
 * Transform a ts-morph SourceFile.
 *
 * Use this when you already have a SourceFile from a ts-morph Project.
 * Also used internally by `transformSource` after parsing.
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

  // Analyze all builder calls using shared helper
  const ir = analyzeAllBuilders(sourceFile, filename).map(r => r.ir)

  // Filter target blocks (client:/server:) before codegen,
  // then dissolve structurally identical conditionals into ternaries.
  const filteredIr = ir
    .map(builder => filterTargetBlocks(builder, target))
    .map(dissolveConditionals)

  // Generate output code
  let code: string
  if (target === "html") {
    code = generateHTMLOutput(filteredIr, options)
  } else {
    code = generateDOMOutput(filteredIr, options)
  }

  // TODO: Generate source maps if requested
  const map = options.sourcemap ? undefined : undefined

  return { code, ir, map }
}

/**
 * Check if source code contains any kyneta builder calls.
 *
 * This is useful for the Vite plugin to quickly determine if transformation is needed.
 *
 * @param source - Source code to check
 * @returns true if the source contains builder calls
 */
export { hasBuilderCalls, resetProject } from "@kyneta/compiler"
