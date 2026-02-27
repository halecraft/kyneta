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

import { type CallExpression, Project, type SourceFile } from "ts-morph"
import { CompilerError, KineticErrorCode } from "../errors.js"
import { analyzeBuilder, findBuilderCalls } from "./analyze.js"
import { generateElementFactory } from "./codegen/dom.js"
import { generateEscapeHelper, generateHTML } from "./codegen/html.js"
import type { BuilderNode, ChildNode } from "./ir.js"
import { LORO_CHANGE_TYPE_STUBS } from "./type-stubs.js"

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
   * The set of runtime imports required.
   */
  requiredImports: Set<string>
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
 * The project uses an in-memory filesystem with pre-loaded type stubs
 * for @loro-extended/change. This enables the compiler to resolve types
 * like ListRef, TextRef, etc. for reactive detection.
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

    // Inject type stubs for @loro-extended/change into the in-memory filesystem.
    // This enables the compiler to resolve types like ListRef, TextRef, etc.
    // which are required for reactive detection via isReactiveType().
    sharedProject.createSourceFile(
      "node_modules/@loro-extended/change/index.d.ts",
      LORO_CHANGE_TYPE_STUBS,
    )

    // Also inject a stub for @loro-extended/kinetic so that `import { bind } from "@loro-extended/kinetic"`
    // resolves correctly and doesn't cause the entire file's types to degrade.
    sharedProject.createSourceFile(
      "node_modules/@loro-extended/kinetic/index.d.ts",
      `
      export declare function bind<T>(ref: T): { __brand: "kinetic:binding"; ref: T }
      export declare class Scope { constructor(name?: string) }
      export declare function mount(element: () => Node, container: Element): { node: Node; dispose: () => void }
      export declare function __subscribe(ref: unknown, handler: (event: unknown) => void, scope: unknown): number
      export declare function __subscribeWithValue<T>(ref: unknown, getValue: () => T, onValue: (value: T) => void, scope: unknown): number
      export declare function __listRegion<T>(parent: Node, listRef: unknown, handlers: { create: (item: T, index: number) => Node }, scope: unknown): void
      export declare function __conditionalRegion(marker: Comment, conditionRef: unknown, getCondition: () => boolean, handlers: { whenTrue?: () => Node; whenFalse?: () => Node }, scope: unknown): void
      export declare function __bindTextValue(input: HTMLInputElement, ref: unknown, scope: unknown): void
      export declare function __bindChecked(input: HTMLInputElement, ref: unknown, scope: unknown): void
      `,
    )

    // Stub for loro-crdt so LoroDoc resolves
    sharedProject.createSourceFile(
      "node_modules/loro-crdt/index.d.ts",
      `
      export declare class LoroDoc {
        constructor()
        commit(): void
      }
      `,
    )
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
// Import Collection (Functional Core)
// =============================================================================

/**
 * Collect required runtime imports from IR nodes.
 *
 * This is a pure function that analyzes the IR and returns the set
 * of runtime function names that need to be imported.
 *
 * @param ir - Array of builder nodes to analyze
 * @returns Set of import names (e.g., "__subscribe", "__listRegion")
 */
export function collectRequiredImports(ir: BuilderNode[]): Set<string> {
  const imports = new Set<string>()

  function collectFromChildren(children: ChildNode[]): void {
    for (const child of children) {
      if (child.kind === "list-region") {
        imports.add("__listRegion")
        collectFromChildren(child.body)
      } else if (child.kind === "conditional-region") {
        if (child.subscriptionTarget) {
          imports.add("__conditionalRegion")
        } else {
          imports.add("__staticConditionalRegion")
        }
        for (const branch of child.branches) {
          collectFromChildren(branch.body)
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
        collectFromChildren(child.children)
      }
    }
  }

  function collectFromBuilder(node: BuilderNode): void {
    if (node.isReactive) {
      imports.add("__subscribe")
      imports.add("__subscribeWithValue")
    }
    collectFromChildren(node.children)
  }

  for (const builder of ir) {
    collectFromBuilder(builder)
  }

  return imports
}

/**
 * Generate import statement string from a set of import names.
 *
 * @param imports - Set of import names
 * @returns Import statement string, or empty string if no imports needed
 */
function formatImportStatement(imports: Set<string>): string {
  if (imports.size === 0) {
    return ""
  }
  const importList = Array.from(imports).sort().join(", ")
  return `import { ${importList} } from "@loro-extended/kinetic"\n`
}

/**
 * Generate imports for the runtime functions used in DOM output.
 * This is the original function, kept for backward compatibility.
 */
function generateDOMImports(ir: BuilderNode[]): string {
  const imports = collectRequiredImports(ir)
  return formatImportStatement(imports)
}

// =============================================================================
// Import Merging (Imperative Shell)
// =============================================================================

/**
 * Merge required imports into a source file.
 *
 * This function modifies the source file in place:
 * - If an @loro-extended/kinetic import exists, add missing named imports to it
 * - If no such import exists, add a new import declaration at the top
 *
 * @param sourceFile - The ts-morph SourceFile to modify
 * @param requiredImports - Set of import names to ensure are present
 */
export function mergeImports(
  sourceFile: SourceFile,
  requiredImports: Set<string>,
): void {
  if (requiredImports.size === 0) {
    return
  }

  // Find existing @loro-extended/kinetic import
  const existingImport = sourceFile.getImportDeclarations().find(decl => {
    const moduleSpecifier = decl.getModuleSpecifierValue()
    return moduleSpecifier === "@loro-extended/kinetic"
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
      moduleSpecifier: "@loro-extended/kinetic",
      namedImports: importNames,
    })
  }
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

  // Apply replacements
  for (const { call, ir: builderIr } of replacements) {
    const factoryCode = generateElementFactory(builderIr)
    call.replaceWithText(factoryCode)
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
