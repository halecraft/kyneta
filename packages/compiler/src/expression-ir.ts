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
  | TernaryNode
  | TemplateNode
  | LiteralNode
  | IdentifierNode
  | BindingRefNode
  | SnapshotNode
  | ElementAccessNode
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

/**
 * Ternary (conditional) expression: `condition ? whenTrue : whenFalse`.
 *
 * All three sub-expressions participate in reactivity — if any contains
 * a changefeed ref, the whole ternary is reactive.
 */
export interface TernaryNode {
  readonly kind: "ternary"
  readonly condition: ExpressionIR
  readonly whenTrue: ExpressionIR
  readonly whenFalse: ExpressionIR
}

/**
 * Element (bracket) access expression: `object[index]`.
 *
 * Both sub-expressions participate in reactivity. The object may be a
 * changefeed being consumed (needs `refRead` wrapping by the builder),
 * and the index may also be reactive.
 */
export interface ElementAccessNode {
  readonly kind: "element-access"
  readonly object: ExpressionIR
  readonly index: ExpressionIR
}

// =============================================================================
// Factory Functions
// =============================================================================

/** Create a `RefReadNode` — reading a changefeed value. */
export function refRead(ref: ExpressionIR, deltaKind: DeltaKind): RefReadNode {
  return { kind: "ref-read", ref, deltaKind }
}

/** Create a `SnapshotNode` — explicit ref() call by the developer. */
export function snapshot(
  ref: ExpressionIR,
  args: readonly ExpressionIR[],
  deltaKind: DeltaKind,
): SnapshotNode {
  return { kind: "snapshot", ref, args, deltaKind }
}

/** Create a `BindingRefNode` — reference to a reactive const binding. */
export function bindingRef(
  name: string,
  expression: ExpressionIR,
): BindingRefNode {
  return { kind: "binding-ref", name, expression }
}

/** Create a `MethodCallNode` — `receiver.method(args)`. */
export function methodCall(
  receiver: ExpressionIR,
  method: string,
  args: readonly ExpressionIR[],
): MethodCallNode {
  return { kind: "method-call", receiver, method, args }
}

/** Create a `PropertyAccessNode` — `object.property`. */
export function propertyAccess(
  object: ExpressionIR,
  property: string,
): PropertyAccessNode {
  return { kind: "property-access", object, property }
}

/** Create a `CallNode` — `callee(args)`. */
export function call(
  callee: ExpressionIR,
  args: readonly ExpressionIR[],
): CallNode {
  return { kind: "call", callee, args }
}

/** Create a `BinaryNode` — `left op right`. */
export function binary(
  left: ExpressionIR,
  op: string,
  right: ExpressionIR,
): BinaryNode {
  return { kind: "binary", left, op, right }
}

/** Create a `UnaryNode` — `op operand` (prefix by default). */
export function unary(
  op: string,
  operand: ExpressionIR,
  prefix: boolean = true,
): UnaryNode {
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

/** Create a `TernaryNode` — `condition ? whenTrue : whenFalse`. */
export function ternary(
  condition: ExpressionIR,
  whenTrue: ExpressionIR,
  whenFalse: ExpressionIR,
): TernaryNode {
  return { kind: "ternary", condition, whenTrue, whenFalse }
}

/** Create an `ElementAccessNode` — `object[index]`. */
export function elementAccess(
  object: ExpressionIR,
  index: ExpressionIR,
): ElementAccessNode {
  return { kind: "element-access", object, index }
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
export function isPropertyAccess(
  node: ExpressionIR,
): node is PropertyAccessNode {
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

/** Check if the node is a `TernaryNode`. */
export function isTernary(node: ExpressionIR): node is TernaryNode {
  return node.kind === "ternary"
}

/** Check if the node is an `ElementAccessNode`. */
export function isElementAccess(node: ExpressionIR): node is ElementAccessNode {
  return node.kind === "element-access"
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

      case "ternary": {
        collect(node.condition)
        collect(node.whenTrue)
        collect(node.whenFalse)
        break
      }

      case "element-access": {
        collect(node.object)
        collect(node.index)
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
      return isReactive(expr.receiver) || expr.args.some(isReactive)

    case "property-access":
      return isReactive(expr.object)

    case "call":
      return isReactive(expr.callee) || expr.args.some(isReactive)

    case "binary":
      return isReactive(expr.left) || isReactive(expr.right)

    case "unary":
      return isReactive(expr.operand)

    case "template":
      return expr.parts.some(isReactive)

    case "ternary":
      return (
        isReactive(expr.condition) ||
        isReactive(expr.whenTrue) ||
        isReactive(expr.whenFalse)
      )

    case "element-access":
      return isReactive(expr.object) || isReactive(expr.index)

    case "literal":
    case "identifier":
    case "raw":
      return false
  }
}

// =============================================================================
// Operator Precedence (for precedence-aware rendering)
// =============================================================================

/**
 * JS binary operator precedence levels.
 * Higher number = tighter binding.
 * Unknown operators default to 0 (always parenthesize).
 */
const BINARY_PRECEDENCE: Record<string, number> = {
  // Assignment (right-to-left)
  "=": 1,
  "+=": 1,
  "-=": 1,
  "*=": 1,
  "/=": 1,
  "%=": 1,
  // Nullish coalescing
  "??": 3,
  // Logical OR
  "||": 4,
  // Logical AND
  "&&": 5,
  // Bitwise OR
  "|": 6,
  // Bitwise XOR
  "^": 7,
  // Bitwise AND
  "&": 8,
  // Equality
  "==": 9,
  "!=": 9,
  "===": 9,
  "!==": 9,
  // Relational
  "<": 10,
  ">": 10,
  "<=": 10,
  ">=": 10,
  instanceof: 10,
  in: 10,
  // Shift
  "<<": 11,
  ">>": 11,
  ">>>": 11,
  // Additive
  "+": 12,
  "-": 12,
  // Multiplicative
  "*": 13,
  "/": 13,
  "%": 13,
  // Exponentiation (right-to-left)
  "**": 14,
}

/** Precedence level for ternary conditional (between assignment and ??). */
const TERNARY_PRECEDENCE = 2

/** Precedence level for prefix/postfix unary operators (above all binary). */
const UNARY_PRECEDENCE = 15

/** Precedence level for member access, call, ref-read (highest). */
const MEMBER_PRECEDENCE = 20

function getOperatorPrecedence(op: string): number {
  return BINARY_PRECEDENCE[op] ?? 0
}

/** Right-associative binary operators: parens needed on the LEFT at same precedence. */
const RIGHT_ASSOCIATIVE = new Set(["=", "+=", "-=", "*=", "/=", "%=", "**"])

function isRightAssociative(op: string): boolean {
  return RIGHT_ASSOCIATIVE.has(op)
}

/**
 * Whether an expression node is "atomic" — safe to use as a receiver,
 * callee, or ref without parenthesization.
 *
 * Atomic nodes produce output that binds tighter than any operator:
 * identifiers, literals, calls (including method calls), property access,
 * ref-reads, snapshots, and template literals.
 *
 * Non-atomic nodes (binary, unary, raw, binding-ref) may produce output
 * that contains operators and must be wrapped when used in member-access
 * or call position.
 */
function isAtomicExpr(node: ExpressionIR): boolean {
  switch (node.kind) {
    case "identifier":
    case "literal":
    case "method-call":
    case "call":
    case "property-access":
    case "ref-read":
    case "snapshot":
    case "template":
      return true
    case "binary":
    case "unary":
    case "ternary":
    case "raw":
      return false
    case "element-access":
      // Bracket access binds as tightly as dot access — atomic
      return true
    case "binding-ref":
      // A binding-ref with expandBindings=false renders as an identifier (atomic),
      // but with expandBindings=true it renders as the inner expression.
      // We conservatively return false — the caller checks context.
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
 * This is a **precedence-aware** pretty-printer: it re-introduces parentheses
 * wherever the tree structure requires grouping that would otherwise be lost
 * in the flat string output. This covers:
 *
 * - Binary operators: lower-precedence child of higher-precedence parent
 * - Associativity: right child at same precedence for left-associative ops
 * - Unary operators: compound operand (binary, raw) wrapped in parens
 * - Unary chain: `-(-a)` not rendered as `--a` (token merge prevention)
 * - Member access / call: non-atomic receiver/callee wrapped in parens
 * - Binding expansion: expanded expression inherits parent precedence context
 * - RawNode: conservatively wrapped when in a precedence-sensitive position
 *
 * Auto-read insertion happens here too: `RefReadNode` renders as `source()`
 * — the observation morphism is a structural property of the tree.
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
 * // → full rendered expression with () reads, parenthesized as needed
 *
 * // Precedence preservation
 * renderExpression(binary(binary(a, "+", b), "*", c), ctx)
 * // → "(a + b) * c"   (not "a + b * c")
 * ```
 */
export function renderExpression(
  expr: ExpressionIR,
  ctx: RenderContext,
): string {
  return renderWithPrec(expr, ctx, 0, "none")
}

/** Side of the child relative to a binary parent — used for associativity. */
type Side = "left" | "right" | "none"

/**
 * Internal precedence-aware renderer.
 *
 * @param expr - The expression to render
 * @param ctx - Render context (expandBindings flag)
 * @param parentPrec - Precedence of the enclosing operator (0 = top-level)
 * @param side - Which side of the parent binary operator this child is on
 */
function renderWithPrec(
  expr: ExpressionIR,
  ctx: RenderContext,
  parentPrec: number,
  side: Side,
): string {
  switch (expr.kind) {
    case "ref-read":
      // The observation morphism: render the ref, then append ()
      // Result is a call expression — atomic, never needs outer parens.
      return `${renderAtomic(expr.ref, ctx)}()`

    case "snapshot":
      // Explicit ref() call by the developer — same output shape as RefRead
      // but semantically distinct (the developer chose this)
      if (expr.args.length === 0) {
        return `${renderAtomic(expr.ref, ctx)}()`
      }
      return `${renderAtomic(expr.ref, ctx)}(${renderArgs(expr.args, ctx)})`

    case "binding-ref":
      if (ctx.expandBindings) {
        // Reactive closure context: inline the binding's expression tree.
        // Pass parent precedence straight through — the expanded expression
        // gets parenthesized by whatever case handles its node kind.
        return renderWithPrec(expr.expression, ctx, parentPrec, side)
      }
      // Initial render context: emit the binding name (atomic)
      return expr.name

    case "method-call":
      // Result is a call — atomic. Receiver must be atomic for `.method()`.
      return `${renderAtomic(expr.receiver, ctx)}.${expr.method}(${renderArgs(expr.args, ctx)})`

    case "property-access":
      // Result is a member access — atomic. Object must be atomic for `.prop`.
      return `${renderAtomic(expr.object, ctx)}.${expr.property}`

    case "call":
      // Result is a call — atomic. Callee must be atomic for `callee()`.
      return `${renderAtomic(expr.callee, ctx)}(${renderArgs(expr.args, ctx)})`

    case "binary": {
      const thisPrec = getOperatorPrecedence(expr.op)

      // Render children with this operator's precedence as their parent context
      const leftStr = renderWithPrec(expr.left, ctx, thisPrec, "left")
      const rightStr = renderWithPrec(expr.right, ctx, thisPrec, "right")
      const result = `${leftStr} ${expr.op} ${rightStr}`

      // Does THIS binary expression need parens in its parent context?
      if (needsParens(thisPrec, parentPrec, expr.op, side)) {
        return `(${result})`
      }
      return result
    }

    case "unary": {
      if (expr.prefix) {
        // Prefix: `!x`, `-x`, `typeof x`
        const space = /^[a-z]+$/i.test(expr.op) ? " " : ""

        // Operand rendered at unary precedence (tighter than any binary).
        let operandStr = renderWithPrec(
          expr.operand,
          ctx,
          UNARY_PRECEDENCE,
          "none",
        )

        // Token merge prevention: -(-a) must not become --a, +(+a) must not become ++a.
        // This happens when the operand is also a prefix unary with the same single-char op.
        if (
          expr.operand.kind === "unary" &&
          expr.operand.prefix &&
          expr.op === expr.operand.op &&
          expr.op.length === 1
        ) {
          operandStr = `(${operandStr})`
        }

        return `${expr.op}${space}${operandStr}`
      }

      // Postfix: `x++`, `x--`
      // Operand must be atomic — `(a + b)++` not `a + b++`
      return `${renderAtomic(expr.operand, ctx)}${expr.op}`
    }

    case "template": {
      // Template literals are self-contained (backtick-delimited) — atomic.
      // Expression holes are inside ${...} which provides grouping.
      let result = "`"
      for (let i = 0; i < expr.parts.length; i++) {
        const part = expr.parts[i]
        if (i % 2 === 0) {
          // Even index: string segment (LiteralNode)
          result +=
            part.kind === "literal"
              ? part.value
              : renderWithPrec(part, ctx, 0, "none")
        } else {
          // Odd index: expression hole — ${...} provides grouping
          result += `\${${renderWithPrec(part, ctx, 0, "none")}}`
        }
      }
      result += "`"
      return result
    }

    case "literal":
      return expr.value

    case "identifier":
      return expr.name

    case "ternary": {
      // Ternary: condition ? whenTrue : whenFalse
      // Precedence 2 (between assignment=1 and ??=3), right-associative.
      // Branches are delimited by ? and : — reset to precedence 0.
      const condStr = renderWithPrec(
        expr.condition,
        ctx,
        TERNARY_PRECEDENCE,
        "left",
      )
      const trueStr = renderWithPrec(expr.whenTrue, ctx, 0, "none")
      const falseStr = renderWithPrec(expr.whenFalse, ctx, 0, "none")
      const result = `${condStr} ? ${trueStr} : ${falseStr}`
      return parentPrec > TERNARY_PRECEDENCE ? `(${result})` : result
    }

    case "element-access":
      // Bracket access: object[index]. Atomic like property-access.
      // Object in member position, index inside [] resets precedence.
      return `${renderAtomic(expr.object, ctx)}[${renderWithPrec(expr.index, ctx, 0, "none")}]`

    case "raw":
      // Raw source text is opaque — we can't determine its precedence.
      // Wrap conservatively when in a precedence-sensitive position
      // (any parent operator or member-access context).
      if (parentPrec > 0) {
        return `(${expr.source})`
      }
      return expr.source
  }
}

/**
 * Render an expression that must be atomic (for use as a receiver, callee,
 * or ref in member-access / call position).
 *
 * Non-atomic expressions are wrapped in parentheses.
 */
function renderAtomic(expr: ExpressionIR, ctx: RenderContext): string {
  // For binding-ref with expansion, check the inner expression's atomicity
  if (expr.kind === "binding-ref" && ctx.expandBindings) {
    return renderAtomic(expr.expression, ctx)
  }

  if (isAtomicExpr(expr)) {
    return renderWithPrec(expr, ctx, 0, "none")
  }
  // Wrap in parens — use MEMBER_PRECEDENCE so binary/raw children know they're inside parens
  return `(${renderWithPrec(expr, ctx, 0, "none")})`
}

/**
 * Determine if a binary expression needs parentheses in its parent context.
 *
 * Parens are needed when:
 * 1. This operator's precedence is lower than the parent's (child is weaker)
 * 2. Same precedence, but on the non-associative side:
 *    - Left-associative op on the RIGHT side of same-prec parent
 *    - Right-associative op on the LEFT side of same-prec parent
 */
function needsParens(
  thisPrec: number,
  parentPrec: number,
  op: string,
  side: Side,
): boolean {
  if (thisPrec < parentPrec) return true
  if (thisPrec === parentPrec && parentPrec > 0) {
    // Same precedence — check associativity
    if (isRightAssociative(op)) {
      // Right-assoc: a ** (b ** c) is natural, (a ** b) ** c needs parens
      return side === "left"
    }
    // Left-assoc: (a - b) - c is natural, a - (b - c) needs parens
    return side === "right"
  }
  return false
}

/**
 * Render a comma-separated argument list.
 * Arguments are inside (...) which provides grouping — no parent precedence.
 */
function renderArgs(args: readonly ExpressionIR[], ctx: RenderContext): string {
  return args.map(arg => renderWithPrec(arg, ctx, 0, "none")).join(", ")
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

    case "ternary":
      return `${renderRefSource(expr.condition)} ? ${renderRefSource(expr.whenTrue)} : ${renderRefSource(expr.whenFalse)}`

    case "element-access":
      return `${renderRefSource(expr.object)}[${renderRefSource(expr.index)}]`
  }
}
