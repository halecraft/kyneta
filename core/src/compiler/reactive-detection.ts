/**
 * Reactive Type Detection
 *
 * This module provides functions to detect whether TypeScript types implement
 * the Reactive interface from @loro-extended/reactive.
 *
 * Detection uses TypeScript's structural type system via `isTypeAssignableTo`,
 * checking if a type is assignable to the `Reactive` interface. This is more
 * robust than property enumeration because it:
 * - Handles unions, intersections, and base types correctly
 * - Avoids reliance on mangled `__@...` symbol names
 * - Lets TypeScript do what it's good at
 *
 * The key insight: we must use the **same** `Reactive` interface that the
 * types under test reference. Creating a new probe with a re-imported symbol
 * creates a distinct `unique symbol` type. Instead, we find the existing
 * `Reactive` interface already in the project's type graph.
 *
 * @packageDocumentation
 */

import { type Project, type SourceFile, ts, type Type } from "ts-morph"

// =============================================================================
// Module Resolution
// =============================================================================

/**
 * Set of module specifiers we've already resolved and added to a project.
 * Keyed by project instance to handle multiple projects.
 */
const resolvedModules = new WeakMap<Project, Set<string>>()

/**
 * Resolve a module and add its declaration file to the project.
 *
 * This manually resolves the module using TypeScript's resolution algorithm
 * and adds the resulting .d.ts file to the project. This is necessary because
 * ts-morph with `skipFileDependencyResolution: true` won't automatically
 * load external package types.
 *
 * @param project - The ts-morph Project
 * @param moduleSpecifier - The module to resolve (e.g., "@loro-extended/change")
 * @param fromFile - The file requesting the import (for resolution context)
 */
export function resolveAndAddModule(
  project: Project,
  moduleSpecifier: string,
  fromFile: SourceFile,
): void {
  // Track which modules we've already resolved for this project
  let resolved = resolvedModules.get(project)
  if (!resolved) {
    resolved = new Set()
    resolvedModules.set(project, resolved)
  }

  // Skip if already resolved
  if (resolved.has(moduleSpecifier)) {
    return
  }

  const host = project.getModuleResolutionHost()
  const compilerOptions = project.getCompilerOptions()

  const result = ts.resolveModuleName(
    moduleSpecifier,
    fromFile.getFilePath(),
    compilerOptions,
    host,
  ).resolvedModule

  if (result?.resolvedFileName) {
    // Only add if not already in the project
    if (!project.getSourceFile(result.resolvedFileName)) {
      project.addSourceFileAtPath(result.resolvedFileName)
    }
    resolved.add(moduleSpecifier)
  }
}

/**
 * Resolve common reactive-related modules for a source file.
 *
 * This scans the source file's imports and resolves any modules that might
 * contain reactive types (@loro-extended/change, @loro-extended/reactive, etc.)
 *
 * @param project - The ts-morph Project
 * @param sourceFile - The source file to scan for imports
 */
export function resolveReactiveImports(
  project: Project,
  sourceFile: SourceFile,
): void {
  // Always resolve the reactive package for the probe type
  resolveAndAddModule(project, "@loro-extended/reactive", sourceFile)

  // Scan imports and resolve any @loro-extended packages
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const moduleSpecifier = importDecl.getModuleSpecifierValue()
    if (moduleSpecifier.startsWith("@loro-extended/")) {
      resolveAndAddModule(project, moduleSpecifier, sourceFile)
    }
  }

  // After adding modules, resolve their dependencies
  project.resolveSourceFileDependencies()
}

// =============================================================================
// Reactive Interface Discovery
// =============================================================================

/**
 * Cache for the Reactive interface node per project.
 * We cache the interface node (not the compiler type) because the compiler
 * type can become stale when `resolveSourceFileDependencies()` is called
 * multiple times, invalidating the TypeChecker.
 */
const reactiveInterfaceCache = new WeakMap<
  Project,
  import("ts-morph").InterfaceDeclaration
>()

/**
 * Find the Reactive interface type in the project.
 *
 * Instead of creating a probe interface (which creates a distinct `unique symbol`
 * type), we find the **existing** `Reactive` interface that types in the project
 * already reference.
 *
 * Search order:
 * 1. Look for an interface named "Reactive" that has a member whose name
 *    contains "REACTIVE" (the mangled symbol name pattern `__@REACTIVE@...`).
 * 2. Search all source files in the project.
 *
 * @param project - The ts-morph Project
 * @returns The TypeScript compiler type for the Reactive interface, or undefined
 */
function getReactiveInterfaceType(project: Project): ts.Type | undefined {
  // Check if we've already found the Reactive interface node for this project
  const cachedNode = reactiveInterfaceCache.get(project)
  if (cachedNode) {
    // Always get a fresh compiler type from the node — the TypeChecker may
    // have been invalidated by resolveSourceFileDependencies() calls.
    return cachedNode.getType().compilerType
  }

  // Search all source files for an interface named "Reactive"
  // that has a symbol-keyed member matching the REACTIVE pattern.
  for (const sf of project.getSourceFiles()) {
    const reactiveInterface = sf.getInterface("Reactive")
    if (!reactiveInterface) {
      continue
    }

    // Verify this is the right Reactive interface by checking its members.
    // The real Reactive interface has a [REACTIVE] symbol property, which
    // appears as a member with a computed property name.
    const members = reactiveInterface.getMembers()
    const hasReactiveSymbol = members.some(m => {
      // Check if member has a computed property name like [REACTIVE]
      const nameNode =
        "getNameNode" in m ? (m as any).getNameNode?.() : undefined
      if (!nameNode) return false
      return nameNode.getKindName() === "ComputedPropertyName"
    })

    if (hasReactiveSymbol) {
      // Cache the interface node, not the type — the type can go stale
      reactiveInterfaceCache.set(project, reactiveInterface)
      return reactiveInterface.getType().compilerType
    }
  }

  return undefined
}

// =============================================================================
// Type Detection
// =============================================================================

/**
 * Check if a type is reactive using structural assignability.
 *
 * A type is reactive if it is assignable to the `Reactive` interface, which
 * means it has a `[REACTIVE]` symbol property with the correct signature.
 *
 * This approach is more robust than property enumeration because:
 * - It handles unions (reactive if any branch is reactive)
 * - It handles intersections (reactive if the combined type is reactive)
 * - It handles inheritance (reactive if base class is reactive)
 * - It doesn't rely on mangled symbol names
 *
 * @param type - The ts-morph Type to check
 * @returns true if the type implements Reactive
 *
 * @example
 * ```typescript
 * const varDecl = sourceFile.getVariableDeclaration("myRef")
 * const type = varDecl.getType()
 * if (isReactiveType(type)) {
 *   // This type implements Reactive
 * }
 * ```
 */
export function isReactiveType(type: Type): boolean {
  // Get the project from the type's internal context
  const project = (type as any)._context?.project as Project | undefined
  if (!project) {
    return false
  }

  const reactiveType = getReactiveInterfaceType(project)
  if (!reactiveType) {
    return false
  }

  // Exclude `any` and `unknown` — they are assignable to everything,
  // but they are not reactive types.
  const typeText = type.getText()
  if (typeText === "any" || typeText === "unknown") {
    return false
  }

  // Handle union types: reactive if any branch is reactive
  // e.g., LocalRef<number> | null → true because LocalRef is reactive
  if (type.isUnion()) {
    return type.getUnionTypes().some(t => isReactiveType(t))
  }

  const checker = project.getTypeChecker().compilerObject
  const candidateType = type.compilerType

  // Use TypeScript's structural assignability check
  return checker.isTypeAssignableTo(candidateType, reactiveType)
}
