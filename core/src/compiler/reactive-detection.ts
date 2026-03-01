/**
 * Reactive Type Detection
 *
 * This module provides functions to detect whether TypeScript types implement
 * the Reactive interface from @loro-extended/reactive.
 *
 * Detection uses a three-layer property-level strategy that checks whether
 * a candidate type has a property keyed by the `[REACTIVE]` unique symbol:
 *
 * 1. **Symbol.for() tracing** — When the symbol's declaration has an
 *    initializer (source files), we walk the AST to verify it's
 *    `Symbol.for("kinetic:reactive")`. This is the most robust check.
 *
 * 2. **Symbol declaration name** — In `.d.ts` files the initializer is
 *    erased, but the `unique symbol` type still carries a reference back
 *    to the variable that declared it. We check that variable's name
 *    is `"REACTIVE"`.
 *
 * 3. **Property escaped name** — As a last-resort fallback, we check
 *    the property's own mangled name (`__@REACTIVE@<id>`).
 *
 * This approach is more robust than the previous `isTypeAssignableTo`
 * strategy because it works regardless of whether the `Reactive` interface
 * has generic type parameters (which caused `isTypeAssignableTo` to fail
 * when `Reactive<D>` was introduced).
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
// Type Detection
// =============================================================================

/**
 * Check whether a single compiler symbol represents the `[REACTIVE]` property.
 *
 * Uses a three-layer strategy, from most to least robust:
 *
 * 1. **Symbol.for() tracing** — If the symbol's value declaration has an
 *    initializer, verify it's `Symbol.for("kinetic:reactive")`.
 * 2. **Symbol declaration name** — The `unique symbol` type's backing
 *    variable has `escapedName === "REACTIVE"`.
 * 3. **Property escaped name** — The property's own mangled name starts
 *    with `__@REACTIVE@`.
 *
 * @param compilerSymbol - The compiler symbol to inspect
 * @returns true if this property is keyed by the REACTIVE symbol
 */
function isReactiveSymbolProperty(compilerSymbol: ts.Symbol): boolean {
  // Access the symbol's internal links to get the nameType.
  // For computed property names like [REACTIVE], TypeScript stores the
  // type of the key expression (the unique symbol type) as `nameType`.
  const links = (compilerSymbol as any).links as
    | Record<string, unknown>
    | undefined
  const nameType = links?.nameType as ts.Type | undefined

  if (nameType) {
    // The property is keyed by a computed name. Check if it's a unique symbol.
    // ts.TypeFlags.UniqueESSymbol = 8192
    if ((nameType.flags & ts.TypeFlags.UniqueESSymbol) !== 0) {
      const nameSymbol = nameType.symbol

      // Layer 1: Trace to Symbol.for("kinetic:reactive") initializer.
      // Available when the symbol is defined in a .ts source file.
      if (nameSymbol?.valueDeclaration) {
        const valueDecl = nameSymbol.valueDeclaration
        if (ts.isVariableDeclaration(valueDecl) && valueDecl.initializer) {
          const init = valueDecl.initializer
          if (
            ts.isCallExpression(init) &&
            ts.isPropertyAccessExpression(init.expression) &&
            init.expression.name.text === "for" &&
            init.arguments.length > 0 &&
            ts.isStringLiteral(init.arguments[0]) &&
            init.arguments[0].text === "kinetic:reactive"
          ) {
            return true
          }
        }
      }

      // Layer 2: Check the symbol's declaration name.
      // In .d.ts files the initializer is erased, but the unique symbol
      // type still references the variable that declared it. Its
      // escapedName is the clean variable name (e.g., "REACTIVE"),
      // not the mangled property name.
      if (nameSymbol) {
        const symName = nameSymbol.escapedName as string
        if (symName === "REACTIVE") {
          return true
        }
      }
    }
  }

  // Layer 3: Mangled property name fallback.
  // TypeScript encodes unique-symbol-keyed properties as __@NAME@<id>
  // in the property's own escapedName.
  const escapedName = compilerSymbol.escapedName as string
  if (escapedName.startsWith("__@REACTIVE@")) {
    return true
  }

  return false
}

/**
 * Check if a type is reactive.
 *
 * A type is reactive if it has a property keyed by the `[REACTIVE]` unique
 * symbol from `@loro-extended/reactive`. This is the property that the
 * Kinetic compiler uses to identify reactive types, and the runtime uses
 * to subscribe to changes.
 *
 * The detection is purely property-level — it does not rely on
 * `isTypeAssignableTo` against the `Reactive` interface, which avoids
 * issues with generic type parameters on the interface.
 *
 * Handles:
 * - Direct types (TextRef, ListRef<T>, LocalRef<T>, etc.)
 * - Union types (reactive if any branch is reactive)
 * - Types from `.d.ts` files (where `Symbol.for()` initializers are erased)
 * - Types from `.ts` source files (where initializers are available)
 *
 * @param type - The ts-morph Type to check
 * @returns true if the type implements Reactive
 *
 * @example
 * ```typescript
 * const varDecl = sourceFile.getVariableDeclaration("myRef")
 * const type = varDecl.getType()
 * if (isReactiveType(type)) {
 *   // This type implements Reactive — it has a [REACTIVE] property
 * }
 * ```
 */
export function isReactiveType(type: Type): boolean {
  // Exclude `any` and `unknown` — they match everything but are not reactive.
  const typeText = type.getText()
  if (typeText === "any" || typeText === "unknown") {
    return false
  }

  // Handle union types: reactive if any branch is reactive.
  // e.g., LocalRef<number> | null → true because LocalRef is reactive.
  if (type.isUnion()) {
    return type.getUnionTypes().some(t => isReactiveType(t))
  }

  // Check the type's properties for one keyed by the REACTIVE symbol.
  const properties = type.compilerType.getProperties()
  for (const prop of properties) {
    if (isReactiveSymbolProperty(prop)) {
      return true
    }
  }

  return false
}
