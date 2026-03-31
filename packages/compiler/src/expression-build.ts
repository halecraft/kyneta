/**
 * ExpressionIR Builder — walks a TypeScript AST expression (via ts-morph)
 * and produces an ExpressionIR tree.
 *
 * This replaces the separate `expressionIsReactive` + `extractDependencies`
 * two-pass approach with a single structural construction. The builder:
 *
 * 1. Checks `isChangefeedType(node.getType())` at each sub-expression
 * 2. Wraps changefeed sub-expressions in `RefReadNode` when consumed as values
 * 3. Produces `SnapshotNode` for explicit `ref()` calls
 * 4. Produces `BindingRefNode` for reactive binding references
 * 5. Produces structural nodes (`MethodCallNode`, `BinaryNode`, etc.) otherwise
 *
 * The "consumed as a value" determination is type-driven:
 * - Changefeed in value context (e.g., method receiver, operand) → RefRead
 * - Changefeed navigating to another changefeed → structural (no read)
 * - Explicit call on changefeed → Snapshot
 *
 * @packageDocumentation
 */

import {
  type BinaryExpression,
  type CallExpression,
  type ConditionalExpression,
  type ElementAccessExpression,
  type Expression,
  type ParenthesizedExpression,
  type PostfixUnaryExpression,
  type PrefixUnaryExpression,
  type PropertyAccessExpression,
  SyntaxKind,
  type TemplateExpression,
  type Type,
} from "ts-morph"

import {
  binary,
  bindingRef,
  call,
  type ExpressionIR,
  elementAccess,
  identifier,
  literal,
  methodCall,
  propertyAccess,
  raw,
  refRead,
  snapshot,
  template,
  ternary,
  unary,
} from "./expression-ir.js"
import { getDeltaKind, isChangefeedType } from "./reactive-detection.js"

// =============================================================================
// Expression Scope (for binding lookup)
// =============================================================================

/**
 * Interface for looking up reactive bindings during ExpressionIR construction.
 *
 * When the builder encounters an identifier that resolves to a reactive
 * binding (e.g., `nameMatch`), it produces a `BindingRefNode` carrying
 * the binding's expression tree for expansion in reactive closures.
 *
 * This is a minimal interface — it doesn't depend on the full `BindingScope`
 * from `binding-scope.ts`, allowing the builder to be used with any scope
 * implementation that provides `ExpressionIR` lookups.
 */
export interface ExpressionScope {
  /** Look up a binding by name. Returns the binding's ExpressionIR if reactive, undefined otherwise. */
  lookupExpression(name: string): ExpressionIR | undefined
}

// =============================================================================
// Builder
// =============================================================================

/**
 * Build an ExpressionIR tree from a TypeScript AST expression.
 *
 * This is the main entry point for converting source expressions into
 * the structured ExpressionIR representation. The builder performs
 * auto-read detection in a single pass:
 *
 * - When a changefeed-typed expression is consumed in a value context
 *   (e.g., as a method receiver where the result is not a changefeed),
 *   it's wrapped in a `RefReadNode`.
 * - When the developer explicitly calls a changefeed (`ref()`), it
 *   becomes a `SnapshotNode`.
 * - When an identifier resolves to a reactive binding in the scope,
 *   it becomes a `BindingRefNode`.
 *
 * @param expr - The ts-morph Expression node to analyze
 * @param scope - Optional scope for reactive binding lookups
 * @returns The ExpressionIR tree
 */
export function buildExpressionIR(
  expr: Expression,
  scope?: ExpressionScope,
): ExpressionIR {
  return buildNode(expr, scope)
}

// =============================================================================
// Internal Builder
// =============================================================================

/**
 * Recursively build an ExpressionIR node from a ts-morph AST node.
 */
function buildNode(expr: Expression, scope?: ExpressionScope): ExpressionIR {
  const kind = expr.getKind()

  switch (kind) {
    // -------------------------------------------------------------------------
    // Call expression: f(args) or obj.method(args) or ref()
    // -------------------------------------------------------------------------
    case SyntaxKind.CallExpression:
      return buildCallExpression(expr as CallExpression, scope)

    // -------------------------------------------------------------------------
    // Property access: obj.prop
    // -------------------------------------------------------------------------
    case SyntaxKind.PropertyAccessExpression:
      return buildPropertyAccess(expr as PropertyAccessExpression, scope)

    // -------------------------------------------------------------------------
    // Binary expression: left op right
    // -------------------------------------------------------------------------
    case SyntaxKind.BinaryExpression:
      return buildBinaryExpression(expr as BinaryExpression, scope)

    // -------------------------------------------------------------------------
    // Prefix unary: !x, -x, typeof x, etc.
    // -------------------------------------------------------------------------
    case SyntaxKind.PrefixUnaryExpression:
      return buildPrefixUnary(expr as PrefixUnaryExpression, scope)

    // -------------------------------------------------------------------------
    // Postfix unary: x++, x--
    // -------------------------------------------------------------------------
    case SyntaxKind.PostfixUnaryExpression:
      return buildPostfixUnary(expr as PostfixUnaryExpression, scope)

    // -------------------------------------------------------------------------
    // Template expression: `text${expr}text`
    // -------------------------------------------------------------------------
    case SyntaxKind.TemplateExpression:
      return buildTemplateExpression(expr as TemplateExpression, scope)

    // -------------------------------------------------------------------------
    // No-substitution template: `hello` (no ${} holes)
    // -------------------------------------------------------------------------
    case SyntaxKind.NoSubstitutionTemplateLiteral: {
      // Strip backticks: `hello` → hello
      const text = expr.getText()
      return literal(text.slice(1, -1))
    }

    // -------------------------------------------------------------------------
    // String literal: "hello" or 'hello'
    // -------------------------------------------------------------------------
    case SyntaxKind.StringLiteral:
      return literal(expr.getText())

    // -------------------------------------------------------------------------
    // Numeric literal: 42, 3.14
    // -------------------------------------------------------------------------
    case SyntaxKind.NumericLiteral:
      return literal(expr.getText())

    // -------------------------------------------------------------------------
    // Boolean literals: true, false
    // -------------------------------------------------------------------------
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
      return literal(expr.getText())

    // -------------------------------------------------------------------------
    // Null/undefined
    // -------------------------------------------------------------------------
    case SyntaxKind.NullKeyword:
      return literal("null")

    case SyntaxKind.UndefinedKeyword:
      return literal("undefined")

    // -------------------------------------------------------------------------
    // Identifier: x, foo, nameMatch
    // -------------------------------------------------------------------------
    case SyntaxKind.Identifier:
      return buildIdentifier(expr, scope)

    // -------------------------------------------------------------------------
    // Parenthesized: (expr)
    // -------------------------------------------------------------------------
    case SyntaxKind.ParenthesizedExpression:
      return buildNode((expr as ParenthesizedExpression).getExpression(), scope)

    // -------------------------------------------------------------------------
    // Conditional (ternary): cond ? a : b
    // -------------------------------------------------------------------------
    case SyntaxKind.ConditionalExpression:
      return buildConditionalExpression(expr as ConditionalExpression, scope)

    // -------------------------------------------------------------------------
    // Element access: obj[key]
    // -------------------------------------------------------------------------
    case SyntaxKind.ElementAccessExpression:
      return buildElementAccess(expr as ElementAccessExpression, scope)

    // -------------------------------------------------------------------------
    // Fallback: anything we don't recognize → RawNode
    // -------------------------------------------------------------------------
    default:
      return raw(expr.getText())
  }
}

// =============================================================================
// Call Expression Builder
// =============================================================================

/**
 * Build a CallExpression: `f(args)`, `obj.method(args)`, or `ref()`.
 *
 * Key decisions:
 * 1. If the callee is a changefeed (e.g., `filterText()`) → SnapshotNode
 * 2. If the callee is `obj.method` where `obj` is a changefeed:
 *    a. If the method is defined on the ref's own interface → ref method call,
 *       no auto-read (e.g., `recipe.name.insert(0, "x")`)
 *    b. If the method comes from value-type widening → auto-read the receiver,
 *       then call the value method (e.g., `recipe.name.toLowerCase()`)
 * 3. Otherwise → normal CallNode or MethodCallNode
 */
function buildCallExpression(
  expr: CallExpression,
  scope?: ExpressionScope,
): ExpressionIR {
  const calleeExpr = expr.getExpression()
  const args = expr.getArguments().map(a => buildNode(a as Expression, scope))

  // Case 1: Callee is a property access → potential method call or snapshot
  if (calleeExpr.getKind() === SyntaxKind.PropertyAccessExpression) {
    const propAccess = calleeExpr as PropertyAccessExpression
    const receiver = propAccess.getExpression()
    const methodName = propAccess.getName()
    const receiverType = receiver.getType()
    const calleeType = calleeExpr.getType()

    // Case 1a: The full callee (e.g., `recipe.name`) is itself a changefeed.
    // Calling a changefeed = explicit snapshot: recipe.name() → Snapshot
    if (isChangefeedType(calleeType)) {
      const calleeIR = buildNode(calleeExpr, scope)
      const deltaKind = getDeltaKind(calleeType)
      return snapshot(calleeIR, args, deltaKind)
    }

    // Case 1b: The receiver is a changefeed but the callee (property) is not.
    // This means we're calling a method on a changefeed receiver.
    if (isChangefeedType(receiverType)) {
      // Special case: .get() with zero args on a changefeed is an explicit read
      // (old calling convention). Treat it like a snapshot so the receiver
      // appears as a dependency for reactive tracking.
      if (methodName === "get" && args.length === 0) {
        const receiverIR = buildNode(receiver, scope)
        const deltaKind = getDeltaKind(receiverType)
        return snapshot(receiverIR, [], deltaKind)
      }

      // Is this a ref method or a value method?
      if (isRefMethod(receiverType, methodName)) {
        // Ref method (mutation) — no auto-read, call directly on the ref
        // e.g., recipe.name.insert(0, "x") → methodCall(recipe.name, "insert", args)
        const receiverIR = buildNode(receiver, scope)
        return methodCall(receiverIR, methodName, args)
      } else {
        // Value method — auto-read the receiver, then call the value method
        // e.g., recipe.name.toLowerCase() → methodCall(refRead(recipe.name), "toLowerCase", [])
        const receiverIR = buildNode(receiver, scope)
        const deltaKind = getDeltaKind(receiverType)
        return methodCall(refRead(receiverIR, deltaKind), methodName, args)
      }
    }

    // Non-changefeed receiver — normal method call
    const receiverIR = buildNode(receiver, scope)
    return methodCall(receiverIR, methodName, args)
  }

  // Case 2: Callee is a bare identifier or other expression
  const calleeType = calleeExpr.getType()

  if (isChangefeedType(calleeType)) {
    // Calling a changefeed directly: e.g., filterText()
    // This is an explicit snapshot (the developer chose to call it).
    const calleeIR = buildNode(calleeExpr, scope)
    const deltaKind = getDeltaKind(calleeType)
    return snapshot(calleeIR, args, deltaKind)
  }

  // Normal function call — auto-read changefeed arguments.
  // When a changefeed is passed to a non-changefeed function (e.g.,
  // `String(doc.title)`), the developer intends to pass the VALUE,
  // not the ref object. The compiler auto-reads it: `String(doc.title())`.
  const calleeIR = buildNode(calleeExpr, scope)
  const wrappedArgs = args.map((argIR, i) => {
    const argExpr = expr.getArguments()[i] as Expression | undefined
    if (argExpr) {
      return wrapIfChangefeed(argIR, argExpr)
    }
    return argIR
  })
  return call(calleeIR, wrappedArgs)
}

// =============================================================================
// Property Access Builder
// =============================================================================

/**
 * Build a PropertyAccessExpression: `obj.prop`.
 *
 * Key decisions:
 * 1. If `obj` is a changefeed and `obj.prop` is also a changefeed →
 *    structural navigation (e.g., `doc.recipes` where both are reactive).
 *    No read needed.
 * 2. If `obj` is a changefeed and `obj.prop` is NOT a changefeed →
 *    the changefeed is being consumed as a value. But we DON'T insert
 *    a RefRead here — the parent (call, binary, etc.) will do that if
 *    needed. The property access node itself represents the ref path.
 * 3. If `obj` is NOT a changefeed → plain property access.
 *
 * Note: Auto-read insertion for property access on a changefeed receiver
 * (e.g., `recipe.name.length`) happens when the property access result
 * is used in a value context. The builder handles this at the PARENT level.
 * For example, in `recipe.name.toLowerCase()`, the CallExpression builder
 * detects that `recipe.name` is a changefeed and wraps it in RefRead before
 * the `.toLowerCase()` call.
 *
 * For standalone changefeed property access consumed as a value (e.g.,
 * `recipe.name.length` without a call), the `wrapIfChangefeed` helper
 * at the top-level or binary/unary builder handles the wrapping.
 */
function buildPropertyAccess(
  expr: PropertyAccessExpression,
  scope?: ExpressionScope,
): ExpressionIR {
  const objExpr = expr.getExpression()
  const propName = expr.getName()

  const objIR = buildNode(objExpr, scope)

  // Check if the object is a changefeed and the result is NOT a changefeed.
  // In this case, the property access is consuming the changefeed as a value
  // (e.g., `recipe.name.length` where `.length` is a number).
  //
  // However, we only auto-read if the RESULT is not a changefeed. If both
  // object and result are changefeeds, it's structural navigation.
  const objType = objExpr.getType()
  const resultType = expr.getType()

  if (isChangefeedType(objType) && !isChangefeedType(resultType)) {
    // The object is a changefeed being consumed for a non-changefeed property.
    // Check if this is a ref-own property (like `.length` on a SequenceRef)
    // or a value-type property.
    if (isRefProperty(objType, propName)) {
      // Ref-own property — still needs auto-read for reactivity.
      // e.g., listRef.length → refRead(listRef).length
      // The expression is reactive: when the list's changefeed fires
      // (items added/removed), .length changes and must re-evaluate.
      const deltaKind = getDeltaKind(objType)
      return propertyAccess(refRead(objIR, deltaKind), propName)
    }

    // Value-type property — insert auto-read
    // e.g., recipe.name.length → propertyAccess(refRead(recipe.name), "length")
    const deltaKind = getDeltaKind(objType)
    return propertyAccess(refRead(objIR, deltaKind), propName)
  }

  // Either:
  // - Object is not a changefeed → plain property access
  // - Both object and result are changefeeds → structural navigation (no read)
  return propertyAccess(objIR, propName)
}

// =============================================================================
// Binary Expression Builder
// =============================================================================

/**
 * Build a BinaryExpression: `left op right`.
 *
 * Both operands are checked: if either is a changefeed, it's wrapped
 * in RefRead (since binary operators consume values, not changefeeds).
 */
function buildBinaryExpression(
  expr: BinaryExpression,
  scope?: ExpressionScope,
): ExpressionIR {
  const leftExpr = expr.getLeft()
  const rightExpr = expr.getRight()
  const op = expr.getOperatorToken().getText()

  const leftIR = wrapIfChangefeed(buildNode(leftExpr, scope), leftExpr)
  const rightIR = wrapIfChangefeed(buildNode(rightExpr, scope), rightExpr)

  return binary(leftIR, op, rightIR)
}

// =============================================================================
// Unary Expression Builders
// =============================================================================

/**
 * Build a PrefixUnaryExpression: `!x`, `-x`, `~x`, `typeof x`, etc.
 *
 * If the operand is a changefeed, wrap it in RefRead (unary operators
 * consume values).
 */
function buildPrefixUnary(
  expr: PrefixUnaryExpression,
  scope?: ExpressionScope,
): ExpressionIR {
  const operandExpr = expr.getOperand()
  const op = getUnaryOperatorText(expr.getOperatorToken())

  const operandIR = wrapIfChangefeed(buildNode(operandExpr, scope), operandExpr)

  return unary(op, operandIR, true)
}

/**
 * Build a PostfixUnaryExpression: `x++`, `x--`.
 */
function buildPostfixUnary(
  expr: PostfixUnaryExpression,
  scope?: ExpressionScope,
): ExpressionIR {
  const operandExpr = expr.getOperand()
  const op = getPostfixOperatorText(expr.getOperatorToken())

  const operandIR = buildNode(operandExpr, scope)

  return unary(op, operandIR, false)
}

// =============================================================================
// Template Expression Builder
// =============================================================================

/**
 * Build a TemplateExpression: `` `text${expr}text${expr}text` ``
 *
 * Produces a TemplateNode with alternating string segments and expression holes.
 * Changefeed expressions in template holes are wrapped in RefRead.
 */
function buildTemplateExpression(
  expr: TemplateExpression,
  scope?: ExpressionScope,
): ExpressionIR {
  const parts: ExpressionIR[] = []

  // Head: the text before the first ${...}
  const head = expr.getHead()
  parts.push(literal(head.getLiteralText()))

  // Template spans: alternating expression + text
  for (const span of expr.getTemplateSpans()) {
    const spanExpr = span.getExpression()
    const spanIR = wrapIfChangefeed(buildNode(spanExpr, scope), spanExpr)
    parts.push(spanIR)

    // The text after this ${...} (middle or tail)
    parts.push(literal(span.getLiteral().getLiteralText()))
  }

  return template(parts)
}

// =============================================================================
// Identifier Builder
// =============================================================================

/**
 * Build an Identifier expression.
 *
 * Checks:
 * 1. If the scope has a reactive binding for this name → BindingRefNode
 * 2. If the identifier's type is a changefeed → IdentifierNode
 *    (the RefRead wrapping happens at the consumer level — binary, unary, etc.)
 * 3. Otherwise → plain IdentifierNode
 */
function buildIdentifier(
  expr: Expression,
  scope?: ExpressionScope,
): ExpressionIR {
  const name = expr.getText()

  // Check scope for reactive binding
  if (scope) {
    const bindingExpr = scope.lookupExpression(name)
    if (bindingExpr !== undefined) {
      return bindingRef(name, bindingExpr)
    }
  }

  // Plain identifier (may be a changefeed — wrapping happens at consumer level)
  return identifier(name)
}

// =============================================================================
// Conditional Expression Builder
// =============================================================================

/**
 * Build a ConditionalExpression (ternary): `cond ? whenTrue : whenFalse`.
 *
 * All three sub-expressions are in value-consuming positions: the condition
 * is consumed as a boolean, the branches are consumed as values. Each is
 * wrapped via `wrapIfChangefeed` so changefeed refs get auto-read.
 */
function buildConditionalExpression(
  expr: ConditionalExpression,
  scope?: ExpressionScope,
): ExpressionIR {
  const condExpr = expr.getCondition()
  const trueExpr = expr.getWhenTrue()
  const falseExpr = expr.getWhenFalse()

  const condIR = wrapIfChangefeed(buildNode(condExpr, scope), condExpr)
  const trueIR = wrapIfChangefeed(buildNode(trueExpr, scope), trueExpr)
  const falseIR = wrapIfChangefeed(buildNode(falseExpr, scope), falseExpr)

  return ternary(condIR, trueIR, falseIR)
}

// =============================================================================
// Element Access Builder
// =============================================================================

/**
 * Build an ElementAccessExpression: `obj[key]`.
 *
 * Uses the same two-type check as `buildPropertyAccess` for the object:
 * if the object is a changefeed and the result is NOT a changefeed,
 * wrap the object in `refRead` (value consumption). If both are changefeeds,
 * it's structural navigation — no wrap.
 *
 * The index is always value-consuming (you never "structurally navigate"
 * through an index), so it uses `wrapIfChangefeed`.
 */
function buildElementAccess(
  expr: ElementAccessExpression,
  scope?: ExpressionScope,
): ExpressionIR {
  const objExpr = expr.getExpression()
  const argExpr = expr.getArgumentExpression()
  if (!argExpr) return raw(expr.getText())

  const objIR = buildNode(objExpr, scope)
  const indexIR = wrapIfChangefeed(buildNode(argExpr, scope), argExpr)

  // Two-type check: same logic as buildPropertyAccess.
  // Only wrap the object in refRead when it's a changefeed being consumed
  // for a non-changefeed result. When both are changefeeds (structural
  // navigation via bracket), don't wrap.
  const objType = objExpr.getType()
  const resultType = expr.getType()

  if (isChangefeedType(objType) && !isChangefeedType(resultType)) {
    const deltaKind = getDeltaKind(objType)
    return elementAccess(refRead(objIR, deltaKind), indexIR)
  }

  return elementAccess(objIR, indexIR)
}

// =============================================================================
// Auto-Read Helpers
// =============================================================================

/**
 * If the expression is a changefeed type and the IR node is NOT already
 * a RefRead or Snapshot (which already handle the read), wrap it in RefRead.
 *
 * This is used by consumers (binary, unary, template holes) that need
 * their operands to be values, not changefeeds.
 */
function wrapIfChangefeed(ir: ExpressionIR, astExpr: Expression): ExpressionIR {
  // Already a ref-read or snapshot — don't double-wrap
  if (ir.kind === "ref-read" || ir.kind === "snapshot") {
    return ir
  }

  // Already a binding-ref — don't wrap (the binding itself handles reactivity)
  if (ir.kind === "binding-ref") {
    return ir
  }

  // Check if the AST expression's type is a changefeed
  const type = astExpr.getType()
  if (isChangefeedType(type)) {
    const deltaKind = getDeltaKind(type)
    return refRead(ir, deltaKind)
  }

  return ir
}

/**
 * Check if a method name is a ref-own method (mutation, navigation, or
 * protocol method) as opposed to a value-type method inherited via
 * type widening.
 *
 * Uses a known set of ref method names. For unknown methods, defaults
 * to NOT a ref method (auto-read is inserted). This is the safe default —
 * a spurious auto-read is more visible than a silently missing one.
 *
 * This approach avoids fragile declaration-source analysis that breaks
 * with synthetic type stubs in tests (where value-type methods like
 * `toLowerCase` are declared directly on the ref interface for
 * type-checking convenience).
 */
function isRefMethod(_type: Type, methodName: string): boolean {
  return KNOWN_REF_METHODS.has(methodName)
}

/**
 * Check if a property name is a ref-own property (not inherited from
 * value types via widening).
 *
 * Uses a known set. Defaults to NOT a ref property for unknowns
 * (auto-read inserted — safe default).
 */
function isRefProperty(_type: Type, propertyName: string): boolean {
  return KNOWN_REF_PROPERTIES.has(propertyName)
}

/**
 * Known ref mutation methods across all schema ref types.
 *
 * These are methods defined on the ref's own interface (not inherited
 * from value types). When the builder sees a call to one of these on
 * a changefeed receiver, it does NOT insert an auto-read.
 */
const KNOWN_REF_METHODS = new Set([
  // ScalarRef / LocalRef
  "set",
  // TextRef
  "insert",
  "delete",
  "update",
  // CounterRef
  "increment",
  "decrement",
  // SequenceRef / ListRef
  "push",
  // "insert" and "delete" already covered above
  // MapRef
  "clear",
  // Note: `get` is NOT here — .get() on a changefeed is treated as a snapshot
  // (explicit read) in buildCallExpression, so it gets reactive tracking.
  // Navigation
  "at",
  // Changefeed protocol
  "subscribe",
  "toJSON",
])

/**
 * Known ref-own properties (not methods) across all schema ref types.
 */
const KNOWN_REF_PROPERTIES = new Set([
  // SequenceRef
  "length",
  // MapRef
  "size",
])

// =============================================================================
// Operator Helpers
// =============================================================================

/**
 * Get the text representation of a prefix unary operator token.
 */
function getUnaryOperatorText(token: SyntaxKind): string {
  switch (token) {
    case SyntaxKind.ExclamationToken:
      return "!"
    case SyntaxKind.MinusToken:
      return "-"
    case SyntaxKind.PlusToken:
      return "+"
    case SyntaxKind.TildeToken:
      return "~"
    case SyntaxKind.PlusPlusToken:
      return "++"
    case SyntaxKind.MinusMinusToken:
      return "--"
    default:
      return "?"
  }
}

/**
 * Get the text representation of a postfix unary operator token.
 */
function getPostfixOperatorText(token: SyntaxKind): string {
  switch (token) {
    case SyntaxKind.PlusPlusToken:
      return "++"
    case SyntaxKind.MinusMinusToken:
      return "--"
    default:
      return "?"
  }
}
