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

import { type CallExpression, Project, type SourceFile, ts } from "ts-morph"
import { resolveReactiveImports } from "./reactive-detection.js"
import { CompilerError, KineticErrorCode } from "../errors.js"
import { analyzeBuilder, findBuilderCalls } from "./analyze.js"
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
  isInputTextRegionAttribute,
  isTextRegionContent,
  type CompileTarget,
} from "./ir.js"
import type { BuilderNode, ChildNode } from "./ir.js"

// =============================================================================
// Types
// =============================================================================

// CompileTarget is defined in ir.ts to avoid circular dependencies.
// Re-export it here for backwards compatibility.
export type { CompileTarget } from "./ir.js"

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
    loro: Set<string>
  }
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
 *
 * The project uses the real filesystem so that imports from node_modules
 * resolve naturally — no type stubs needed. The Vite plugin passes the
 * file's real absolute path, enabling ts-morph's module resolution to
 * find @loro-extended/change, @loro-extended/kinetic, etc. via pnpm
 * workspace symlinks.
 *
 * Key configuration:
 * - moduleResolution: Bundler (100) for pnpm compatibility
 * - skipFileDependencyResolution: true — we manually resolve external
 *   packages to avoid loading all of node_modules. This is necessary
 *   because TypeScript needs the .d.ts files to properly analyze types
 *   from external packages (like detecting [REACTIVE] properties).
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
 * After creating the source file, this resolves any @loro-extended imports
 * so that TypeScript can fully analyze external reactive types (detecting
 * [REACTIVE] properties, etc.).
 */
function parseSource(source: string, filename: string): SourceFile {
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

  // Resolve @loro-extended imports so TypeScript can analyze reactive types
  resolveReactiveImports(project, sourceFile)

  return sourceFile
}

// =============================================================================
// Import Collection (Functional Core)
// =============================================================================

/**
 * Collect required runtime imports from IR nodes.
 *
 * This is a pure function that analyzes the IR and returns the set
 * of runtime function names that need to be imported.
 *
 * Returns two sets:
 * - `runtime`: Functions from `@loro-extended/kinetic/runtime` (subscribe, listRegion, etc.)
 * - `loro`: Functions from `@loro-extended/kinetic/loro` (bindTextValue, bindChecked, etc.)
 *
 * @param ir - Array of builder nodes to analyze
 * @returns Object with `runtime` and `loro` import sets
 */
export function collectRequiredImports(ir: BuilderNode[]): {
  runtime: Set<string>
  loro: Set<string>
} {
  const runtime = new Set<string>()
  const loro = new Set<string>()

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
        // Check for bindings on elements (these come from /loro subpath)
        for (const binding of child.bindings) {
          if (binding.bindingType === "checked") {
            loro.add("bindChecked")
          } else {
            loro.add("bindTextValue")
          }
        }
        // Check for multi-dependency attributes and inputTextRegion candidates
        for (const attr of child.attributes) {
          if (
            attr.value.bindingTime === "reactive" &&
            attr.value.dependencies.length > 1
          ) {
            runtime.add("subscribeMultiple")
          }
          // Check for delta-aware value attribute (enables inputTextRegion)
          if (isInputTextRegionAttribute(attr)) {
            runtime.add("inputTextRegion")
          }
        }
        // Recurse into element children
        collectFromChildren(child.children)
      } else if (child.kind === "content") {
        // Check for direct TextRef read (enables textRegion optimization)
        if (isTextRegionContent(child)) {
          runtime.add("textRegion")
        }
        // Check for multi-dependency content (text nodes)
        if (child.bindingTime === "reactive" && child.dependencies.length > 1) {
          runtime.add("subscribeMultiple")
        }
      }
    }
  }

  function collectFromBuilder(node: BuilderNode): void {
    if (node.isReactive) {
      runtime.add("subscribe")
      runtime.add("subscribeWithValue")
    }
    collectFromChildren(node.children)
  }

  for (const builder of ir) {
    collectFromBuilder(builder)
  }

  return { runtime, loro }
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
  const { runtime, loro } = collectRequiredImports(ir)
  let result = ""
  result += formatImportStatement(runtime, "@loro-extended/kinetic/runtime")
  result += formatImportStatement(loro, "@loro-extended/kinetic/loro")
  return result
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
 * the appropriate subpaths:
 * - Runtime functions from `@loro-extended/kinetic/runtime`
 * - Loro bindings from `@loro-extended/kinetic/loro`
 *
 * @param sourceFile - The ts-morph SourceFile to modify
 * @param requiredImports - Object with `runtime` and `loro` import sets
 */
export function mergeImports(
  sourceFile: SourceFile,
  requiredImports: { runtime: Set<string>; loro: Set<string> },
): void {
  mergeImportsForModule(
    sourceFile,
    requiredImports.runtime,
    "@loro-extended/kinetic/runtime",
  )
  mergeImportsForModule(
    sourceFile,
    requiredImports.loro,
    "@loro-extended/kinetic/loro",
  )
}

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
      KineticErrorCode.COMPILER_PARSE_ERROR,
      `Failed to parse source: ${e instanceof Error ? e.message : String(e)}`,
      { file: filename, line: 1, column: 0 },
    )
  }

  // Find builder calls
  const calls = findBuilderCalls(sourceFile)

  // Analyze each call and collect replacements
  const replacements: Array<{ call: CallExpression; ir: BuilderNode }> = []

  for (const call of calls) {
    try {
      const builder = analyzeBuilder(call)
      if (builder) {
        replacements.push({ call, ir: builder })
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

  // Collect IR nodes
  const ir = replacements.map(r => r.ir)

  // Collect required imports
  const requiredImports = collectRequiredImports(ir)

  // Sort replacements by position descending (process back-to-front)
  // This ensures that replacing earlier nodes doesn't shift the positions
  // of later nodes that we still need to replace
  replacements.sort((a, b) => b.call.getStart() - a.call.getStart())

  // Collect all module declarations from template cloning
  const allModuleDeclarations: string[] = []

  // Apply replacements using the appropriate codegen target
  // IMPORTANT: Do replacements BEFORE insertions to avoid stale AST references
  const target = options.target ?? "dom"

  // Filter target blocks (client:/server:) before codegen.
  // This strips non-matching blocks and unwraps matching ones so that
  // codegens never see TargetBlockNode in the IR tree.
  for (const r of replacements) {
    r.ir = filterTargetBlocks(r.ir, target)
    r.ir = dissolveConditionals(r.ir)
  }

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
    const found = calls.length > 0

    // Remove the temporary file to prevent duplicate type declarations
    // from interfering with subsequent transformSourceInPlace calls
    // that use the same shared project.
    const project = getProject()
    const checkFile = project.getSourceFile("check.ts")
    if (checkFile) {
      project.removeSourceFile(checkFile)
    }

    return found
  } catch {
    // Clean up on error too
    try {
      const project = getProject()
      const checkFile = project.getSourceFile("check.ts")
      if (checkFile) {
        project.removeSourceFile(checkFile)
      }
    } catch {
      // ignore cleanup errors
    }
    return false
  }
}
