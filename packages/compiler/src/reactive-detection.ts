/**
 * Changefeed Type Detection and Component Factory Detection
 *
 * This module provides functions to detect whether TypeScript types implement
 * the CHANGEFEED protocol from @kyneta/schema, and whether types implement
 * the ComponentFactory interface from Kyneta.
 *
 * Detection uses a three-layer property-level strategy that checks whether
 * a candidate type has a property keyed by the `[CHANGEFEED]` unique symbol:
 *
 * 1. **Symbol.for() tracing** — When the symbol's declaration has an
 *    initializer (source files), we walk the AST to verify it's
 *    `Symbol.for("kyneta:changefeed")`. This is the most robust check.
 *
 * 2. **Symbol declaration name** — In `.d.ts` files the initializer is
 *    erased, but the `unique symbol` type still carries a reference back
 *    to the variable that declared it. We check that variable's name
 *    is `"CHANGEFEED"`.
 *
 * 3. **Property escaped name** — As a last-resort fallback, we check
 *    the property's own mangled name (`__@CHANGEFEED@<id>`).
 *
 * This approach is more robust than `isTypeAssignableTo` because it works
 * regardless of whether the `Changefeed` interface has generic type
 * parameters.
 *
 * @packageDocumentation
 */

import { type Project, type SourceFile, type Type, ts } from "ts-morph"
import type { DeltaKind } from "./ir.js"

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
 * @param moduleSpecifier - The module to resolve (e.g., "@kyneta/schema")
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
 * Resolve changefeed-related modules for a source file.
 *
 * This resolves `@kyneta/schema` (the sole reactive type provider) and
 * any other `@kyneta/*` packages found in the source file's imports.
 *
 * @param project - The ts-morph Project
 * @param sourceFile - The source file to scan for imports
 */
export function resolveReactiveImports(
  project: Project,
  sourceFile: SourceFile,
): void {
  // Always resolve @kyneta/schema — it defines CHANGEFEED and all change types
  resolveAndAddModule(project, "@kyneta/schema", sourceFile)

  // Scan imports and resolve any @kyneta packages
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const moduleSpecifier = importDecl.getModuleSpecifierValue()
    if (moduleSpecifier.startsWith("@kyneta/")) {
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
 * Check whether a single compiler symbol represents a well-known symbol property.
 *
 * Uses a three-layer strategy, from most to least robust:
 *
 * 1. **Symbol.for() tracing** — If the symbol's value declaration has an
 *    initializer, verify it's `Symbol.for(symbolForKey)`.
 * 2. **Symbol declaration name** — The `unique symbol` type's backing
 *    variable has `escapedName === declarationName`.
 * 3. **Property escaped name** — The property's own mangled name starts
 *    with `mangledPrefix`.
 *
 * @param compilerSymbol - The compiler symbol to inspect
 * @param symbolForKey - The string key passed to Symbol.for() (e.g., "kyneta:changefeed")
 * @param declarationName - The variable name of the symbol declaration (e.g., "CHANGEFEED")
 * @param mangledPrefix - The mangled property name prefix (e.g., "__@CHANGEFEED@")
 * @returns true if this property is keyed by the specified well-known symbol
 */
function isWellKnownSymbolProperty(
  compilerSymbol: ts.Symbol,
  symbolForKey: string,
  declarationName: string,
  mangledPrefix: string,
): boolean {
  // Access the symbol's internal links to get the nameType.
  // For computed property names like [CHANGEFEED], TypeScript stores the
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

      // Layer 1: Trace to Symbol.for() initializer.
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
            init.arguments[0].text === symbolForKey
          ) {
            return true
          }
        }
      }

      // Layer 2: Check the symbol's declaration name.
      // In .d.ts files the initializer is erased, but the unique symbol
      // type still references the variable that declared it. Its
      // escapedName is the clean variable name (e.g., "CHANGEFEED"),
      // not the mangled property name.
      if (nameSymbol) {
        const symName = nameSymbol.escapedName as string
        if (symName === declarationName) {
          return true
        }
      }
    }
  }

  // Layer 3: Mangled property name fallback.
  // TypeScript encodes unique-symbol-keyed properties as __@NAME@<id>
  // in the property's own escapedName.
  const escapedName = compilerSymbol.escapedName as string
  if (escapedName.startsWith(mangledPrefix)) {
    return true
  }

  return false
}

/**
 * Check whether a compiler symbol represents the `[CHANGEFEED]` property.
 * Delegates to `isWellKnownSymbolProperty` with CHANGEFEED-specific parameters.
 */
function isChangefeedSymbolProperty(compilerSymbol: ts.Symbol): boolean {
  return isWellKnownSymbolProperty(
    compilerSymbol,
    "kyneta:changefeed",
    "CHANGEFEED",
    "__@CHANGEFEED@",
  )
}

/**
 * Check if a type has a changefeed.
 *
 * A type has a changefeed if it has a property keyed by the `[CHANGEFEED]`
 * unique symbol from `@kyneta/schema`. This is the property that the
 * Kyneta compiler uses to identify reactive types, and the runtime uses
 * to subscribe to changes.
 *
 * The `[CHANGEFEED]` symbol subsumes the old two-symbol design:
 * - `[REACTIVE]` → `[CHANGEFEED].subscribe(cb)`
 * - `[SNAPSHOT]` → `[CHANGEFEED].current`
 *
 * The detection is purely property-level — it does not rely on
 * `isTypeAssignableTo` against the `HasChangefeed` interface, which avoids
 * issues with generic type parameters.
 *
 * Handles:
 * - Direct types (TextRef, SequenceRef<T>, LocalRef<T>, etc.)
 * - Union types (reactive if any branch has changefeed)
 * - Types from `.d.ts` files (where `Symbol.for()` initializers are erased)
 * - Types from `.ts` source files (where initializers are available)
 *
 * @param type - The ts-morph Type to check
 * @returns true if the type has a [CHANGEFEED] property
 */
export function isChangefeedType(type: Type): boolean {
  // Exclude `any` and `unknown` — they match everything but are not reactive.
  const typeText = type.getText()
  if (typeText === "any" || typeText === "unknown") {
    return false
  }

  // Handle union types: reactive if any branch has changefeed.
  // e.g., LocalRef<number> | null → true because LocalRef has changefeed.
  if (type.isUnion()) {
    return type.getUnionTypes().some(t => isChangefeedType(t))
  }

  // Check the type's properties for one keyed by the CHANGEFEED symbol.
  const properties = type.compilerType.getProperties()
  for (const prop of properties) {
    if (isChangefeedSymbolProperty(prop)) {
      return true
    }
  }

  return false
}

/**
 * Get the delta kind for a type with a changefeed.
 *
 * This inspects the `[CHANGEFEED]` property's type to determine what kind
 * of changes the changefeed emits. The property type is
 * `ChangefeedProtocol<S, C>` — a TypeReference whose second type argument
 * is the change type `C`. We extract the `type` literal from `C`.
 *
 * Primary extraction path (3 hops via TypeReference):
 * 1. `[CHANGEFEED]` property → property type (`ChangefeedProtocol<S, C>`)
 * 2. → `getTypeArguments()` → second type argument `C`
 * 3. → `.type` property → string literal value
 *
 * Fallback extraction path (structural walk, 9 hops):
 * Used when the property type is NOT a TypeReference (e.g., inline object
 * literal types in tests). Walks through `.subscribe` → callback →
 * `Changeset.changes` → array element → `.type`.
 *
 * Falls back to "replace" for unknown types or extraction failures.
 *
 * @param type - The ts-morph Type to inspect (must have changefeed)
 * @returns The delta kind this type emits
 */
export function getDeltaKind(type: Type): DeltaKind {
  // Handle union types: use the first changefeed branch's delta kind
  if (type.isUnion()) {
    for (const t of type.getUnionTypes()) {
      if (isChangefeedType(t)) {
        return getDeltaKind(t)
      }
    }
    return "replace"
  }

  // Find the [CHANGEFEED] property
  const properties = type.compilerType.getProperties()
  let changefeedProperty: ts.Symbol | undefined

  for (const prop of properties) {
    if (isChangefeedSymbolProperty(prop)) {
      changefeedProperty = prop
      break
    }
  }

  if (!changefeedProperty) {
    return "replace"
  }

  try {
    // Get the type checker. Not part of the public ts.Type interface but
    // available on instantiated types.
    const checker = (type.compilerType as { checker?: ts.TypeChecker }).checker
    if (!checker) {
      return "replace"
    }

    // Hop 1: Get the [CHANGEFEED] property type → ChangefeedProtocol<S, C>
    const changefeedType = checker.getTypeOfSymbol(changefeedProperty)

    // ── Primary path: TypeReference extraction (3 hops) ──
    // If the property type is a TypeReference (i.e., an instantiation of a
    // generic interface like ChangefeedProtocol<S, C>), extract the second
    // type argument directly. This works for both explicitly declared
    // [CHANGEFEED] properties AND inherited ones from HasChangefeed<S, C>.
    const objectFlags = (changefeedType as any).objectFlags as
      | number
      | undefined
    if (objectFlags !== undefined && objectFlags & ts.ObjectFlags.Reference) {
      const typeRef = changefeedType as ts.TypeReference
      const typeArgs = checker.getTypeArguments(typeRef)

      // Hop 2: Second type argument is C (the change type)
      if (typeArgs.length >= 2) {
        const deltaKind = extractDeltaKindFromChangeType(
          checker,
          typeArgs[1],
        )
        if (deltaKind) return deltaKind
      }

      // TypeReference but couldn't extract → fall back to replace
      // (e.g., default C = ChangeBase where .type is `string`, not a literal)
      return "replace"
    }

    // ── Fallback path: structural walk (9 hops) ──
    // Used when the property type is NOT a TypeReference (e.g., an inline
    // object literal type `{ current: string; subscribe(...): ... }`).
    return getDeltaKindStructural(checker, changefeedType)
  } catch {
    // Any extraction failure falls back to replace
    return "replace"
  }
}

/**
 * Extract a DeltaKind from a change type `C` by reading its `.type` property.
 *
 * Shared by both the primary (TypeReference) and fallback (structural) paths.
 *
 * @returns The delta kind string, or `undefined` if extraction fails.
 */
function extractDeltaKindFromChangeType(
  checker: ts.TypeChecker,
  changeType: ts.Type,
): DeltaKind | undefined {
  const typeProperty = changeType.getProperty("type")
  if (!typeProperty) return undefined

  const typePropertyType = checker.getTypeOfSymbol(typeProperty)

  if (typePropertyType.isStringLiteral()) {
    const value = (typePropertyType as ts.StringLiteralType).value
    if (
      value === "replace" ||
      value === "text" ||
      value === "sequence" ||
      value === "map" ||
      value === "tree" ||
      value === "increment"
    ) {
      return value
    }
  }

  // Non-literal .type (e.g., ChangeBase where type is `string`) → no match
  return undefined
}

/**
 * Structural fallback for getDeltaKind when the [CHANGEFEED] property type
 * is not a TypeReference (e.g., inline object literal types in tests).
 *
 * Walks: subscribe → call signature → callback param → callback signature →
 * changeset param → Changeset.changes → array element → .type
 */
function getDeltaKindStructural(
  checker: ts.TypeChecker,
  changefeedType: ts.Type,
): DeltaKind {
  // Hop 2: Get the `.subscribe` method
  const subscribeProp = changefeedType.getProperty("subscribe")
  if (!subscribeProp) return "replace"

  const subscribeType = checker.getTypeOfSymbol(subscribeProp)

  // Hop 3: Get the call signature of subscribe
  const subscribeSignatures = subscribeType.getCallSignatures()
  if (subscribeSignatures.length === 0) return "replace"

  const subscribeSig = subscribeSignatures[0]
  const subscribeParams = subscribeSig.getParameters()
  if (subscribeParams.length === 0) return "replace"

  // Hop 4: Get the callback parameter type → (changeset: Changeset<C>) => void
  const callbackParam = subscribeParams[0]
  const callbackType = checker.getTypeOfSymbol(callbackParam)

  // Hop 5: Get the callback's call signature
  const callbackSignatures = callbackType.getCallSignatures()
  if (callbackSignatures.length === 0) return "replace"

  const callbackSig = callbackSignatures[0]
  const changeParams = callbackSig.getParameters()
  if (changeParams.length === 0) return "replace"

  // Hop 6: Get the changeset parameter type → Changeset<C>
  const changesetParam = changeParams[0]
  const changesetType = checker.getTypeOfSymbol(changesetParam)

  // Hop 7: Get the `changes` property on Changeset<C> → readonly C[]
  const changesProp = changesetType.getProperty("changes")
  if (!changesProp) return "replace"

  const changesArrayType = checker.getTypeOfSymbol(changesProp)

  // Hop 8: Get the array element type → C
  const changeType = changesArrayType.getNumberIndexType?.()
  if (!changeType) return "replace"

  // Hop 9: Extract the "type" property from the change type C
  return extractDeltaKindFromChangeType(checker, changeType) ?? "replace"
}

// =============================================================================
// Component Factory Detection
// =============================================================================

/**
 * Check if a type is a ComponentFactory.
 *
 * A ComponentFactory is a function type that:
 * - Returns an Element (a scope-accepting function that returns Node)
 * - Optionally takes props (an object) as first argument
 * - Optionally takes a Builder (a function) as second argument
 *
 * This detection works by checking if the type has call signatures where:
 * 1. The return type is a function type (Element = (scope: ScopeInterface) => Node)
 * 2. Parameters are either empty, props object, builder function, or both
 *
 * @param type - The ts-morph Type to check
 * @returns true if the type is a ComponentFactory
 */
export function isComponentFactoryType(type: Type): boolean {
  // Exclude primitive types
  const typeText = type.getText()
  if (
    typeText === "any" ||
    typeText === "unknown" ||
    typeText === "never" ||
    typeText === "void" ||
    typeText === "undefined" ||
    typeText === "null"
  ) {
    return false
  }

  // Must be a function type (have call signatures)
  const callSignatures = type.getCallSignatures()
  if (callSignatures.length === 0) {
    return false
  }

  // Check if any call signature returns an Element-like type
  // Element = (scope: ScopeInterface) => Node, a function returning Node
  for (const sig of callSignatures) {
    const returnType = sig.getReturnType()

    // Element is a function type: (scope: ScopeInterface) => Node
    const returnCallSigs = returnType.getCallSignatures()
    if (returnCallSigs.length > 0) {
      // Check if it returns something Node-like
      const innerReturnType = returnCallSigs[0].getReturnType()
      const innerReturnText = innerReturnType.getText()

      // Node, Element, HTMLElement, etc. or a union containing Node
      if (
        innerReturnText === "Node" ||
        innerReturnText.includes("Node") ||
        innerReturnText.includes("Element") ||
        innerReturnText.includes("HTMLElement")
      ) {
        return true
      }
    }

    // Also check if return type text contains "Element" directly
    // This handles cases where Element type alias is used
    const returnText = returnType.getText()
    if (returnText === "Element" || returnText.includes("=> Node")) {
      return true
    }
  }

  return false
}
