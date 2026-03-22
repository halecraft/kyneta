/**
 * Expression IR — a tree representation of expressions in the compiler IR.
 *
 * Instead of carrying pre-baked source strings, the Expression IR represents
 * the expression's semantics as a typed tree. This enables:
 *
 * - **Auto-read insertion**: `RefReadNode` renders to `source()` — the
 *   observation morphism is structural, not string surgery.
 * - **Binding expansion**: `BindingRefNode` carries the binding's full
 *   expression tree, enabling structural recursion in reactive closures.
 * - **Dependency derivation**: `extractDeps` is a fold over the tree,
 *   replacing the separate `extractDependencies` heuristic walk.
 * - **Reactivity detection**: `isReactive` is a structural property —
 *   the tree contains `RefReadNode` or `BindingRefNode` iff the expression
 *   is reactive.
 *
 * @packageDocumentation
 */

import type { DeltaKind, Dependency } from "./ir.js"

// =============================================================================
// ExpressionIR Node Types
// =============================================================================

/**
 * A node in the expression IR tree.
 *
 * Each variant represents a distinct expression form. The tree is pure data —
 * no methods, no circular references, JSON-serializable (except for
 * `BindingRefNode.expression` which may create DAG structure via shared
 * subtrees).
 */
export type ExpressionIR =
  | RefReadNode
  | MethodCallNode
  | PropertyAccessNode
  | CallNode
  | BinaryNode
  | UnaryNode
  | TemplateNode
  | LiteralNode
  | IdentifierNode
  | BindingRefNode
  | SnapshotNode
  | RawNode

// -----------------------------------------------------------------------------
// Reactive boundary nodes
// -----------------------------------------------------------------------------

/**
 * Reading a changefeed value — the observation morphism.
 *
 * Rendered as `ref()` — the compiler inserts the `()` call.
 * The `ref` subtree is the expression that produces the changefeed
 * (e.g., `recipe.name`, `filterText`).
 *
 * @example
 * Source: `recipe.name.toLowerCase()`
 * Tree:  `MethodCall(RefRead(PropertyAccess(Identifier("recipe"), "name")), "toLowerCase", [])`
 * Output: `recipe.name().toLowerCase()`
 */
export interface RefReadNode {
  readonly kind: "ref-read"
  /** The expression tree for the ref being read */
  readonly ref: ExpressionIR
  /** The changefeed's delta kind (text, sequence, replace, etc.) */
  readonly deltaKind: DeltaKind
}

/**
 * Explicit ref() call — the developer's opt-out from auto-read.
 *
 * When the developer writes `recipe.name()` with an explicit `()`, the
 * compiler produces a `SnapshotNode` instead of a `RefReadNode`. The
 * rendered output is identical (`recipe.name()`), but the semantic
 * distinction matters: the developer chose this, not the compiler.
 *
 * @example
 * Source: `recipe.name()`
 * Tree:  `Snapshot(PropertyAccess(Identifier("recipe"), "name"), [])`
 * Output: `recipe.name()`
 */
export interface SnapshotNode {
  readonly kind: "snapshot"
  /** The expression tree for the ref being snapshot-read */
  readonly ref: ExpressionIR
  /** Arguments passed to the call (usually empty for bare ref()) */
  readonly args: readonly ExpressionIR[]
  /** The changefeed's delta kind */
  readonly deltaKind: DeltaKind
}

/**
 * Reference to a reactive const binding.
 *
 * When the developer writes `const nameMatch = <reactive expr>` and later
 * uses `nameMatch` in a reactive closure, the compiler produces a
 * `BindingRefNode` carrying the binding's full expression tree.
 *
 * In snapshot context (`expandBindings: false`), renders as `"nameMatch"`.
 * In reactive closure context (`expandBindings: true`), recursively renders
 * the binding's `.expression` tree with auto-read insertion.
 *
 * @example
 * Source: `nameMatch && veggieMatch`
 * Tree:  `Binary(BindingRef("nameMatch", <expr>), "&&", BindingRef("veggieMatch", <expr>))`
 */
export interface BindingRefNode {
  readonly kind: "binding-ref"
  /** The binding name (e.g., "nameMatch") */
  readonly name: string
  /** The binding's full expression tree — used for expansion in reactive closures */
  readonly expression: ExpressionIR
}

// -----------------------------------------------------------------------------
// Standard expression nodes
// -----------------------------------------------------------------------------

/**
 * Calling a method on a receiver: `receiver.method(args)`.
 */
export interface MethodCallNode {
  readonly kind: "method-call"
  /** The receiver expression */
  readonly receiver: ExpressionIR
  /** The method name */
  readonly method: string
  /** The argument expressions */
  readonly args: readonly ExpressionIR[]
}

/**
 * Accessing a property: `object.property`.
 */
export interface PropertyAccessNode {
  readonly kind: "property-access"
  /** The object expression */
  readonly object: ExpressionIR
  /** The property name */
  readonly property: string
}

/**
 * Calling a function: `callee(args)`.
 *
 * This is for non-method calls (free functions, identifiers as callees).
 * Method calls use `MethodCallNode`.
 */
export interface CallNode {
  readonly kind: "call"
  /** The callee expression */
  readonly callee: ExpressionIR
  /** The argument expressions */
  readonly args: readonly ExpressionIR[]
}

/**
 * Binary operation: `left op right`.
 */
export interface BinaryNode {
  readonly kind: "binary"
  /** The left operand */
  readonly left: ExpressionIR
  /** The operator (e.g., "&&", "||", "+", "===", ">") */
  readonly op: string
  /** The right operand */
  readonly right: ExpressionIR
}

/**
 * Unary operation: `op operand` (prefix) or `operand op` (postfix).
 */
export interface UnaryNode {
  readonly kind: "unary"
  /** The operator (e.g., "!", "-", "typeof") */
  readonly op: string
  /** The operand expression */
  readonly operand: ExpressionIR
  /** Whether the operator is a prefix (true) or postfix (false) */
  readonly prefix: boolean
}

/**
 * Template literal: `` `text${expr}text${expr}text` ``
 *
 * `parts` alternates between string segments and expression holes:
 * - Even indices (0, 2, 4, ...): string segments (LiteralNode with the raw text)
 * - Odd indices (1, 3, 5, ...): expression holes (any ExpressionIR)
 *
 * A template with N expressions has 2N+1 parts.
 */
export interface TemplateNode {
  readonly kind: "template"
  /** Alternating string segments and expression holes */
  readonly parts: readonly ExpressionIR[]
}

/**
 * A literal value: string, number, boolean, null, undefined.
 */
export interface LiteralNode {
  readonly kind: "literal"
  /** The literal text as it appears in source (e.g., `"hello"`, `42`, `true`) */
  readonly value: string
}

/**
 * A plain identifier (non-reactive variable reference).
 */
export interface IdentifierNode {
  readonly kind: "identifier"
  /** The identifier name */
  readonly name: string
}

/**
 * Passthrough node — expression the compiler doesn't transform.
 *
 * Used as an escape hatch for expressions that don't need structural
 * analysis (event handler sources, mutation calls, complex expressions
 * the builder doesn't recognize).
 */
export interface RawNode {
  readonly kind: "raw"
  /** The verbatim source text */
  readonly source: string
}

// =============================================================================
// Factory Functions
// =============================================================================

/** Create a `RefReadNode` — reading a changefeed value. */
export function refRead(ref: ExpressionIR, deltaKind: DeltaKind): RefReadNode {
  return { kind: "ref-read", ref, deltaKind }
}

/** Create a `SnapshotNode` — explicit ref() call by the developer. */
export function snapshot(ref: ExpressionIR, args: readonly ExpressionIR[], deltaKind: DeltaKind): SnapshotNode {
  return { kind: "snapshot", ref, args, deltaKind }
}

/** Create a `BindingRefNode` — reference to a reactive const binding. */
export function bindingRef(name: string, expression: ExpressionIR): BindingRefNode {
  return { kind: "binding-ref", name, expression }
}

/** Create a `MethodCallNode` — `receiver.method(args)`. */
export function methodCall(receiver: ExpressionIR, method: string, args: readonly ExpressionIR[]): MethodCallNode {
  return { kind: "method-call", receiver, method, args }
}

/** Create a `PropertyAccessNode` — `object.property`. */
export function propertyAccess(object: ExpressionIR, property: string): PropertyAccessNode {
  return { kind: "property-access", object, property }
}

/** Create a `CallNode` — `callee(args)`. */
export function call(callee: ExpressionIR, args: readonly ExpressionIR[]): CallNode {
  return { kind: "call", callee, args }
}

/** Create a `BinaryNode` — `left op right`. */
export function binary(left: ExpressionIR, op: string, right: ExpressionIR): BinaryNode {
  return { kind: "binary", left, op, right }
}

/** Create a `UnaryNode` — `op operand` (prefix by default). */
export function unary(op: string, operand: ExpressionIR, prefix: boolean = true): UnaryNode {
  return { kind: "unary", op, operand, prefix }
}

/** Create a `TemplateNode` — template literal with alternating string/expression parts. */
export function template(parts: readonly ExpressionIR[]): TemplateNode {
  return { kind: "template", parts }
}

/** Create a `LiteralNode` — a literal value. */
export function literal(value: string): LiteralNode {
  return { kind: "literal", value }
}

/** Create an `IdentifierNode` — a plain identifier. */
export function identifier(name: string): IdentifierNode {
  return { kind: "identifier", name }
}

/** Create a `RawNode` — verbatim source passthrough. */
export function raw(source: string): RawNode {
  return { kind: "raw", source }
}

// =============================================================================
// Type Guards
// =============================================================================

/** Check if the node is a `RefReadNode`. */
export function isRefRead(node: ExpressionIR): node is RefReadNode {
  return node.kind === "ref-read"
}

/** Check if the node is a `SnapshotNode`. */
export function isSnapshot(node: ExpressionIR): node is SnapshotNode {
  return node.kind === "snapshot"
}

/** Check if the node is a `BindingRefNode`. */
export function isBindingRef(node: ExpressionIR): node is BindingRefNode {
  return node.kind === "binding-ref"
}

/** Check if the node is a `MethodCallNode`. */
export function isMethodCall(node: ExpressionIR): node is MethodCallNode {
  return node.kind === "method-call"
}

/** Check if the node is a `PropertyAccessNode`. */
export function isPropertyAccess(node: ExpressionIR): node is PropertyAccessNode {
  return node.kind === "property-access"
}

/** Check if the node is a `CallNode`. */
export function isCall(node: ExpressionIR): node is CallNode {
  return node.kind === "call"
}

/** Check if the node is a `BinaryNode`. */
export function isBinary(node: ExpressionIR): node is BinaryNode {
  return node.kind === "binary"
}

/** Check if the node is a `UnaryNode`. */
export function isUnary(node: ExpressionIR): node is UnaryNode {
  return node.kind === "unary"
}

/** Check if the node is a `TemplateNode`. */
export function isTemplate(node: ExpressionIR): node is TemplateNode {
  return node.kind === "template"
}

/** Check if the node is a `LiteralNode`. */
export function isLiteral(node: ExpressionIR): node is LiteralNode {
  return node.kind === "literal"
}

/** Check if the node is an `IdentifierNode`. */
export function isIdentifier(node: ExpressionIR): node is IdentifierNode {
  return node.kind === "identifier"
}

/** Check if the node is a `RawNode`. */
export function isRaw(node: ExpressionIR): node is RawNode {
  return node.kind === "raw"
}

// =============================================================================
// Derived Properties
// =============================================================================

/**
 * Extract dependencies from an ExpressionIR tree.
 *
 * A fold that collects all `RefReadNode` and `SnapshotNode` entries as
 * dependencies. `BindingRefNode` contributes its expression's deps
 * (transitive expansion).
 *
 * Includes subsumption logic: when a child dependency exists (e.g.,
 * `"doc.title"`), any parent dependency whose source is a strict prefix
 * (e.g., `"doc"`) is removed. This prevents redundant broader subscriptions
 * when more specific ones exist.
 *
 * Replaces the old `extractDependencies` AST walk.
 */
export function extractDeps(expr: ExpressionIR): Dependency[] {
  const depsMap = new Map<string, Dependency>()

  function collect(node: ExpressionIR): void {
    switch (node.kind) {
      case "ref-read": {
        const source = renderRefSource(node.ref)
        if (!depsMap.has(source)) {
          depsMap.set(source, { source, deltaKind: node.deltaKind })
        }
        // Don't recurse into node.ref — the ref itself is what we subscribe
        // to, not its sub-expressions. E.g., for `recipe.name` we subscribe
        // to the whole ref, not `recipe` separately.
        break
      }

      case "snapshot": {
        // Snapshots also contribute dependencies — the developer called the
        // ref explicitly, but the runtime still needs to subscribe to it for
        // re-evaluation of the containing expression.
        const source = renderRefSource(node.ref)
        if (!depsMap.has(source)) {
          depsMap.set(source, { source, deltaKind: node.deltaKind })
        }
        // Also collect deps from the arguments (they may contain refs)
        for (const arg of node.args) {
          collect(arg)
        }
        break
      }

      case "binding-ref": {
        // Transitive expansion: the binding's expression tree contributes
        // its deps, not the binding name itself.
        collect(node.expression)
        break
      }

      case "method-call": {
        collect(node.receiver)
        for (const arg of node.args) {
          collect(arg)
        }
        break
      }

      case "property-access": {
        collect(node.object)
        break
      }

      case "call": {
        collect(node.callee)
        for (const arg of node.args) {
          collect(arg)
        }
        break
      }

      case "binary": {
        collect(node.left)
        collect(node.right)
        break
      }

      case "unary": {
        collect(node.operand)
        break
      }

      case "template": {
        for (const part of node.parts) {
          collect(part)
        }
        break
      }

      case "literal":
      case "identifier":
      case "raw":
        // Leaf nodes — no reactive content
        break
    }
  }

  collect(expr)

  const deps = Array.from(depsMap.values())

  // Dependency subsumption: when a child dependency exists (e.g., "doc.title"),
  // remove any parent dependency whose source is a strict prefix (e.g., "doc").
  // This mirrors the subsumption logic in the old `extractDependencies`.
  if (deps.length > 1) {
    const sources = new Set(deps.map(d => d.source))
    return deps.filter(dep => {
      for (const other of sources) {
        if (
          other !== dep.source &&
          other.startsWith(dep.source) &&
          other[dep.source.length] === "."
        ) {
          return false // This dep is subsumed by a more specific child dep
        }
      }
      return true
    })
  }

  return deps
}

/**
 * Check if an ExpressionIR tree is reactive.
 *
 * Returns true if the tree contains any `RefReadNode`, `SnapshotNode`,
 * or `BindingRefNode`. These are the nodes that indicate the expression
 * depends on changefeed values and needs reactive tracking.
 *
 * Replaces the old `expressionIsReactive` heuristic.
 */
export function isReactive(expr: ExpressionIR): boolean {
  switch (expr.kind) {
    case "ref-read":
    case "snapshot":
    case "binding-ref":
      return true

    case "method-call":
      return (
        isReactive(expr.receiver) ||
        expr.args.some(isReactive)
      )

    case "property-access":
      return isReactive(expr.object)

    case "call":
      return (
        isReactive(expr.callee) ||
        expr.args.some(isReactive)
      )

    case "binary":
      return isReactive(expr.left) || isReactive(expr.right)

    case "unary":
      return isReactive(expr.operand)

    case "template":
      return expr.parts.some(isReactive)

    case "literal":
    case "identifier":
    case "raw":
      return false
  }
}

// =============================================================================
// Expression Rendering (ExpressionIR → JavaScript source)
// =============================================================================

/**
 * Controls how `renderExpression` emits `BindingRefNode` references.
 */
export interface RenderContext {
  /**
   * When true, `BindingRefNode` expands to its expression tree
   * (for reactive closures — the getter must be self-contained).
   *
   * When false, `BindingRefNode` emits the binding name
   * (for initial render — the `const` binding is in scope).
   */
  expandBindings: boolean
}

/**
 * Render an ExpressionIR tree to a JavaScript source string.
 *
 * This is where auto-read insertion happens: `RefReadNode` renders as
 * `source()` — the observation morphism is a structural property of the
 * tree, not a string transformation.
 *
 * Binding expansion is controlled by `context.expandBindings`:
 * - `false` → `BindingRefNode` emits `"nameMatch"` (initial render)
 * - `true` → `BindingRefNode` recursively renders its `.expression` tree
 *   (reactive closure — must re-evaluate from live refs)
 *
 * @example
 * ```typescript
 * // RefRead → auto-inserted ()
 * renderExpression(refRead(identifier("filterText"), "replace"), ctx)
 * // → "filterText()"
 *
 * // BindingRef with expandBindings: false
 * renderExpression(bindingRef("nameMatch", expr), { expandBindings: false })
 * // → "nameMatch"
 *
 * // BindingRef with expandBindings: true
 * renderExpression(bindingRef("nameMatch", expr), { expandBindings: true })
 * // → full rendered expression with () reads
 * ```
 */
export function renderExpression(expr: ExpressionIR, ctx: RenderContext): string {
  switch (expr.kind) {
    case "ref-read":
      // The observation morphism: render the ref, then append ()
      return `${renderExpression(expr.ref, ctx)}()`

    case "snapshot":
      // Explicit ref() call by the developer — same output shape as RefRead
      // but semantically distinct (the developer chose this)
      if (expr.args.length === 0) {
        return `${renderExpression(expr.ref, ctx)}()`
      }
      return `${renderExpression(expr.ref, ctx)}(${renderArgs(expr.args, ctx)})`

    case "binding-ref":
      if (ctx.expandBindings) {
        // Reactive closure context: inline the binding's expression tree
        return renderExpression(expr.expression, ctx)
      }
      // Initial render context: emit the binding name
      return expr.name

    case "method-call":
      return `${renderExpression(expr.receiver, ctx)}.${expr.method}(${renderArgs(expr.args, ctx)})`

    case "property-access":
      return `${renderExpression(expr.object, ctx)}.${expr.property}`

    case "call":
      return `${renderExpression(expr.callee, ctx)}(${renderArgs(expr.args, ctx)})`

    case "binary":
      return `${renderExpression(expr.left, ctx)} ${expr.op} ${renderExpression(expr.right, ctx)}`

    case "unary":
      if (expr.prefix) {
        // Prefix: `!x`, `-x`, `typeof x`
        // Add a space for word operators like `typeof`, `void`, `delete`
        const space = /^[a-z]+$/i.test(expr.op) ? " " : ""
        return `${expr.op}${space}${renderExpression(expr.operand, ctx)}`
      }
      // Postfix: `x++`, `x--`
      return `${renderExpression(expr.operand, ctx)}${expr.op}`

    case "template": {
      // Reconstruct template literal: `seg0${expr1}seg2${expr3}seg4`
      let result = "`"
      for (let i = 0; i < expr.parts.length; i++) {
        const part = expr.parts[i]
        if (i % 2 === 0) {
          // Even index: string segment (LiteralNode)
          result += part.kind === "literal" ? part.value : renderExpression(part, ctx)
        } else {
          // Odd index: expression hole
          result += `\${${renderExpression(part, ctx)}}`
        }
      }
      result += "`"
      return result
    }

    case "literal":
      return expr.value

    case "identifier":
      return expr.name

    case "raw":
      return expr.source
  }
}

/**
 * Render a comma-separated argument list.
 */
function renderArgs(args: readonly ExpressionIR[], ctx: RenderContext): string {
  return args.map(arg => renderExpression(arg, ctx)).join(", ")
}

// =============================================================================
// Ref Source Rendering (for dependency sources)
// =============================================================================

/**
 * Render the source text for a ref expression — used for dependency source
 * strings and subscription arrays.
 *
 * For simple structures (identifiers, property access chains), produces
 * the dotted path (e.g., `"recipe.name"`, `"filterText"`).
 * For complex expressions, falls back to a full render.
 *
 * This is intentionally simple — it handles the common cases that appear
 * as changefeed references. Complex ref expressions (rare) fall through
 * to a descriptive string.
 */
export function renderRefSource(expr: ExpressionIR): string {
  switch (expr.kind) {
    case "identifier":
      return expr.name

    case "property-access":
      return `${renderRefSource(expr.object)}.${expr.property}`

    case "raw":
      return expr.source

    case "literal":
      return expr.value

    // For other node kinds, produce a reasonable source string.
    // These cases are unusual for ref sources but we handle them
    // for completeness.
    case "method-call":
      return `${renderRefSource(expr.receiver)}.${expr.method}()`

    case "call":
      return `${renderRefSource(expr.callee)}()`

    case "ref-read":
      // A ref-read inside a ref source — render without the `()`
      return renderRefSource(expr.ref)

    case "snapshot":
      return `${renderRefSource(expr.ref)}()`

    case "binding-ref":
      return expr.name

    case "binary":
      return `${renderRefSource(expr.left)} ${expr.op} ${renderRefSource(expr.right)}`

    case "unary":
      return expr.prefix
        ? `${expr.op}${renderRefSource(expr.operand)}`
        : `${renderRefSource(expr.operand)}${expr.op}`

    case "template":
      return "`...`"
  }
}