/**
 * Reactive Type Detection
 *
 * This module provides functions to detect whether TypeScript types implement
 * the Reactive interface from @loro-extended/reactive.
 *
 * Detection is done structurally by checking if a type has a [REACTIVE] symbol
 * property. This is identified by looking for symbol-keyed properties with names
 * matching the pattern used by TypeScript for unique symbols.
 *
 * @packageDocumentation
 */

import type { Type } from "ts-morph"

// =============================================================================
// Constants
// =============================================================================

/**
 * Pattern fragments used to identify the REACTIVE symbol in mangled property names.
 *
 * TypeScript mangles symbol property names as "__@<name>@<id>" where:
 * - <name> is derived from the symbol's description
 * - <id> is a numeric identifier
 *
 * For Symbol.for("kinetic:reactive"), we look for these patterns.
 */
const REACTIVE_SYMBOL_PATTERNS = [
  "REACTIVE", // From `const REACTIVE = Symbol.for(...)`
  "kinetic", // From the symbol description "kinetic:reactive"
] as const

// =============================================================================
// Type Detection
// =============================================================================

/**
 * Check if a type has a [REACTIVE] symbol property.
 *
 * This uses the TypeScript compiler API to inspect all properties of a type,
 * including symbol-keyed ones. Symbol properties appear with mangled names
 * like "__@REACTIVE@123" in the TypeScript checker.
 *
 * @param type - The ts-morph Type to check
 * @returns true if the type has a REACTIVE symbol property
 */
function hasReactiveSymbolProperty(type: Type): boolean {
  // Access the underlying TypeScript compiler type and checker
  // Using 'any' to avoid type conflicts between different TypeScript versions
  const tsType = type.compilerType as unknown
  const tsChecker = (type as any)._context?.typeChecker?.compilerObject as any

  if (!tsChecker || !tsType) {
    return false
  }

  // Get all properties including symbol-keyed ones
  const getPropertiesOfType = tsChecker.getPropertiesOfType as
    | ((t: unknown) => Array<{ getName(): string }>)
    | undefined

  if (typeof getPropertiesOfType !== "function") {
    return false
  }

  const properties = getPropertiesOfType.call(tsChecker, tsType)

  // Look for a property that matches the REACTIVE symbol pattern
  for (const prop of properties) {
    const name = prop.getName()

    // Symbol properties start with "__@"
    if (!name.startsWith("__@")) {
      continue
    }

    // Check if the name contains any of our pattern fragments
    for (const pattern of REACTIVE_SYMBOL_PATTERNS) {
      if (name.includes(pattern)) {
        return true
      }
    }
  }

  return false
}

/**
 * Check if a type is reactive.
 *
 * A type is reactive if it implements the Reactive interface, which means
 * it has a [REACTIVE] symbol property. Detection is done structurally by
 * checking for symbol-keyed properties matching the REACTIVE pattern.
 *
 * This recursively checks:
 * - Union types (reactive if any branch is reactive)
 * - Intersection types (reactive if any part is reactive)
 * - Generic type arguments (reactive if any argument is reactive)
 *
 * @param type - The ts-morph Type to check
 * @returns true if the type implements Reactive
 *
 * @example
 * ```typescript
 * const varDecl = sourceFile.getVariableDeclaration("myRef")
 * const type = varDecl.getType()
 * if (isReactiveType(type)) {
 *   // This type has a [REACTIVE] property
 * }
 * ```
 */
export function isReactiveType(type: Type): boolean {
  // Direct check: does this type have a [REACTIVE] symbol property?
  if (hasReactiveSymbolProperty(type)) {
    return true
  }

  // Union types: reactive if any branch is reactive
  // e.g., LocalRef<number> | null
  if (type.isUnion()) {
    return type.getUnionTypes().some(t => isReactiveType(t))
  }

  // Intersection types: reactive if any part is reactive
  // e.g., LocalRef<number> & { extra: string }
  if (type.isIntersection()) {
    return type.getIntersectionTypes().some(t => isReactiveType(t))
  }

  // Generic type arguments: check if any argument is reactive
  // This handles wrapper types like Promise<LocalRef<T>>
  const typeArgs = type.getTypeArguments()
  if (typeArgs.length > 0) {
    return typeArgs.some(t => isReactiveType(t))
  }

  return false
}
