/**
 * BindingScope — lexical scope for tracking analyzed variable bindings.
 *
 * During builder body analysis, the compiler maintains a BindingScope that
 * maps variable names to their analyzed ContentNode values. When the compiler
 * encounters an identifier in a reactive context, it consults the scope
 * to discover transitive reactive dependencies.
 *
 * Scopes nest for structured constructs (loop bodies, conditional branches).
 * Lookup traverses the parent chain. Bindings in inner scopes shadow outer
 * ones (standard lexical scoping).
 *
 * @packageDocumentation
 */

import type { ContentNode } from "./ir.js"

export interface BindingScope {
  /** Look up a binding by name, traversing the parent chain. */
  lookup(name: string): ContentNode | undefined
  /** Register a new binding in this scope. */
  bind(name: string, value: ContentNode): void
  /** Create a child scope (for loop bodies, conditional branches, etc.). */
  child(): BindingScope
}

export function createBindingScope(parent?: BindingScope): BindingScope {
  const bindings = new Map<string, ContentNode>()

  return {
    lookup(name: string): ContentNode | undefined {
      const local = bindings.get(name)
      if (local !== undefined) return local
      return parent?.lookup(name)
    },

    bind(name: string, value: ContentNode): void {
      bindings.set(name, value)
    },

    child(): BindingScope {
      return createBindingScope(this)
    },
  }
}