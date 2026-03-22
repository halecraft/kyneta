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
 * The scope also stores ExpressionIR trees alongside ContentNodes. This
 * enables the ExpressionIR builder to produce BindingRefNodes that carry
 * the binding's full expression tree for expansion in reactive closures.
 * The ExpressionIR storage implements the ExpressionScope interface from
 * expression-build.ts.
 *
 * @packageDocumentation
 */

import type { ContentNode } from "./ir.js"
import type { ExpressionIR } from "./expression-ir.js"
import type { ExpressionScope } from "./expression-build.js"

export interface BindingScope extends ExpressionScope {
  /** Look up a binding by name, traversing the parent chain. */
  lookup(name: string): ContentNode | undefined
  /** Register a new binding in this scope. */
  bind(name: string, value: ContentNode): void
  /** Look up a binding's ExpressionIR by name, traversing the parent chain. */
  lookupExpression(name: string): ExpressionIR | undefined
  /** Register a binding's ExpressionIR in this scope. */
  bindExpression(name: string, expression: ExpressionIR): void
  /** Create a child scope (for loop bodies, conditional branches, etc.). */
  child(): BindingScope
}

export function createBindingScope(parent?: BindingScope): BindingScope {
  const bindings = new Map<string, ContentNode>()
  const expressions = new Map<string, ExpressionIR>()

  return {
    lookup(name: string): ContentNode | undefined {
      const local = bindings.get(name)
      if (local !== undefined) return local
      return parent?.lookup(name)
    },

    bind(name: string, value: ContentNode): void {
      bindings.set(name, value)
    },

    lookupExpression(name: string): ExpressionIR | undefined {
      const local = expressions.get(name)
      if (local !== undefined) return local
      return parent?.lookupExpression(name)
    },

    bindExpression(name: string, expression: ExpressionIR): void {
      expressions.set(name, expression)
    },

    child(): BindingScope {
      return createBindingScope(this)
    },
  }
}