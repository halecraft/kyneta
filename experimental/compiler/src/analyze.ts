/**
 * AST Analysis for Kyneta Compiler
 *
 * This module analyzes TypeScript AST (via ts-morph) and produces IR nodes.
 * All functions are pure - they take AST nodes and return IR without side effects.
 *
 * The analysis:
 * 1. Finds element factory calls with builder functions
 * 2. Classifies expressions as static or reactive using TypeScript's type system
 * 3. Transforms control flow (if/for) into region nodes
 * 4. Extracts dependencies for subscription generation
 *
 * @packageDocumentation
 */

import {
  type ArrayBindingPattern,
  type ArrowFunction,
  type Block,
  type CallExpression,
  type Expression,
  type ExpressionStatement,
  type ForOfStatement,
  type FunctionExpression,
  type IfStatement,
  type LabeledStatement,
  Node,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from "ts-morph"
import { type BindingScope, createBindingScope } from "./binding-scope.js"
import { buildExpressionIR } from "./expression-build.js"
import {
  isReactive as exprIsReactive,
  extractDeps,
  isRefRead,
  refRead,
  renderExpression,
  renderRefSource,
} from "./expression-ir.js"

import type {
  AttributeNode,
  BuilderNode,
  ChildNode,
  ConditionalBranch,
  ContentNode,
  Dependency,
  EventHandlerNode,
  SourceSpan,
} from "./ir.js"
import {
  createBinding,
  createBuilder,
  createConditional,
  createConditionalBranch,
  createContent,
  createElement,
  createLabeledBlock,
  createLiteral,
  createLoop,
  createSpan,
  createStatement,
} from "./ir.js"
import { detectFilterPattern } from "./patterns.js"
import {
  getDeltaKind,
  isChangefeedType,
  isComponentFactoryType,
} from "./reactive-detection.js"

// =============================================================================
// Constants
// =============================================================================

/**
 * Known HTML element factory names.
 * The compiler recognizes calls to these as element creation.
 */
export const ELEMENT_FACTORIES = new Set([
  // Document structure
  "html",
  "head",
  "body",
  "title",
  "meta",
  "link",
  "script",
  "style",
  "base",

  // Sectioning
  "header",
  "footer",
  "main",
  "nav",
  "aside",
  "section",
  "article",
  "address",

  // Content grouping
  "div",
  "p",
  "hr",
  "pre",
  "blockquote",
  "figure",
  "figcaption",

  // Text content
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "span",
  "a",
  "em",
  "strong",
  "small",
  "s",
  "cite",
  "q",
  "dfn",
  "abbr",
  "code",
  "var",
  "samp",
  "kbd",
  "sub",
  "sup",
  "i",
  "b",
  "u",
  "mark",
  "ruby",
  "rt",
  "rp",
  "bdi",
  "bdo",
  "br",
  "wbr",

  // Lists
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",

  // Tables
  "table",
  "caption",
  "colgroup",
  "col",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",

  // Forms
  "form",
  "label",
  "input",
  "button",
  "select",
  "datalist",
  "optgroup",
  "option",
  "textarea",
  "output",
  "progress",
  "meter",
  "fieldset",
  "legend",

  // Interactive
  "details",
  "summary",
  "dialog",

  // Media
  "img",
  "picture",
  "source",
  "video",
  "audio",
  "track",
  "map",
  "area",
  "iframe",
  "embed",
  "object",
  "param",
  "canvas",
  "svg",

  // Misc
  "template",
  "slot",
  "noscript",
])

/**
 * Result of checking if a call expression is an element or component.
 */
interface ElementOrComponentInfo {
  /** Whether this is a recognized element/component call */
  isElementOrComponent: boolean
  /** The tag/factory name */
  name: string
  /** Whether this is a user-defined component (vs HTML element) */
  isComponent: boolean
}

/**
 * Check if a call expression is to an HTML element factory or a ComponentFactory.
 *
 * Two-tier detection:
 * 1. If the callee name is in ELEMENT_FACTORIES, it's an HTML element
 * 2. Otherwise, check if the callee's type is ComponentFactory
 *
 * @param call - The call expression to check
 * @returns Info about whether this is an element/component call
 */
function checkElementOrComponent(call: CallExpression): ElementOrComponentInfo {
  const callee = call.getExpression()

  // Must be a simple identifier for now
  if (callee.getKind() !== SyntaxKind.Identifier) {
    return { isElementOrComponent: false, name: "", isComponent: false }
  }

  const name = callee.getText()

  // First check: HTML element factory
  if (ELEMENT_FACTORIES.has(name)) {
    return { isElementOrComponent: true, name, isComponent: false }
  }

  // Second check: ComponentFactory type
  // PascalCase is a hint but not required - we rely on types
  const calleeType = callee.getType()
  if (isComponentFactoryType(calleeType)) {
    return { isElementOrComponent: true, name, isComponent: true }
  }

  return { isElementOrComponent: false, name: "", isComponent: false }
}

/**
 * Event handler prop names (start with "on").
 */
function isEventHandlerProp(name: string): boolean {
  return (
    name.startsWith("on") &&
    name.length > 2 &&
    name[2] === name[2].toUpperCase()
  )
}

// =============================================================================
// Source Span Helpers
// =============================================================================

/**
 * Extract source span from a ts-morph node.
 */
export function getSpan(node: Node): SourceSpan {
  const start = node.getStartLineNumber()
  const startCol = node.getStart() - node.getStartLinePos()
  const end = node.getEndLineNumber()
  const endCol = node.getEnd() - node.getStartLinePos()
  return createSpan(start, startCol, end, endCol)
}

// =============================================================================
// Type Analysis
// =============================================================================

export { isChangefeedType }

// NOTE: `expressionIsReactive` and `extractDependencies` have been removed.
// Reactivity detection is now a structural property of the ExpressionIR tree
// (see `isReactive` in expression-ir.ts). Dependency extraction is now a fold
// over the ExpressionIR tree (see `extractDeps` in expression-ir.ts).

// =============================================================================
// Direct-Read Detection
// =============================================================================

/**
 * Detect if an expression is a direct read on a reactive ref.
 *
 * A direct read is when the expression is exactly `ref.get()` or `ref.toString()`
 * on a single reactive dependency — not nested inside a transformation like
 * `.toUpperCase()` or combined with other expressions.
 *
 * This enables surgical text patching: when the dependency has deltaKind "text",
 * the runtime can use insertData/deleteData instead of full textContent replacement.
 *
 * @param expr - The expression to check
 * @returns The source text of the reactive ref if this is a direct read, else undefined
 *
 * @example
 * detectDirectRead(parse("title.get()")) // → "title"
 * detectDirectRead(parse("doc.title.get()")) // → "doc.title"
 * detectDirectRead(parse("title.toString()")) // → "title"
 * detectDirectRead(parse("title.get().toUpperCase()")) // → undefined (root is outer call)
 * detectDirectRead(parse("title.get() + subtitle.get()")) // → undefined (root is binary)
 *
 * @deprecated Replaced by Changefeed-native analysis in `analyzeExpression`.
 * The compiler now asks "is this expression itself a Changefeed?" via
 * `isChangefeedType` instead of pattern-matching on method names. Retained
 * only for documentation of the previous approach.
 */
export function detectDirectRead(expr: Expression): string | undefined {
  // 1. Must be a CallExpression
  if (expr.getKind() !== SyntaxKind.CallExpression) {
    return undefined
  }

  const call = expr as CallExpression

  // 2. Must have zero arguments
  if (call.getArguments().length > 0) {
    return undefined
  }

  const callee = call.getExpression()

  // 3. Must be a PropertyAccessExpression (receiver.method)
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) {
    return undefined
  }

  const propAccess = callee as PropertyAccessExpression
  const methodName = propAccess.getName()

  // 4. Method must be .get() or .toString()
  if (methodName !== "get" && methodName !== "toString") {
    return undefined
  }

  // 5. Receiver must be reactive
  const receiver = propAccess.getExpression()
  const receiverType = receiver.getType()

  if (!isChangefeedType(receiverType)) {
    return undefined
  }

  // All checks pass — return the receiver source text
  return receiver.getText()
}

// =============================================================================
// Implicit-Read Detection
// =============================================================================

/**
 * Detect if an expression is a bare reactive ref (implicit read).
 *
 * A bare reactive ref is when the expression itself IS a reactive ref,
 * not a method call on one. For example, `doc.title` in content position
 * where `doc.title` is a `TextRef`. This is distinct from `doc.title.get()`
 * which is a direct read (handled by `detectDirectRead`).
 *
 * Returns the expression's source text if:
 * 1. The expression is NOT a CallExpression (those go through detectDirectRead)
 * 2. The expression's type is reactive (has [REACTIVE])
 * 3. The expression's type is snapshotable (has [SNAPSHOT])
 *
 * Returns undefined otherwise.
 *
 * @example
 * detectImplicitRead(parse("doc.title"))     // → "doc.title" (TextRef is reactive + snapshotable)
 * detectImplicitRead(parse("doc.title.get()")) // → undefined (CallExpression)
 * detectImplicitRead(parse("someString"))      // → undefined (not reactive)
 */
/**
 * @deprecated Replaced by Changefeed-native analysis in `analyzeExpression`.
 * Retained only for documentation of the previous approach.
 */
export function detectImplicitRead(expr: Expression): string | undefined {
  // 1. Must NOT be a CallExpression — those are handled by detectDirectRead
  if (expr.getKind() === SyntaxKind.CallExpression) {
    return undefined
  }

  // 2. Expression's type must have a changefeed.
  // CHANGEFEED subsumes both REACTIVE and SNAPSHOT — any type with
  // [CHANGEFEED] is both subscribable and has a readable .current.
  const type = expr.getType()
  if (!isChangefeedType(type)) {
    return undefined
  }

  return expr.getText()
}

// =============================================================================
// Expression Analysis
// =============================================================================

/**
 * Analyze an expression and return the appropriate content node.
 *
 * Uses Changefeed-native analysis: the single question "is this expression
 * itself a Changefeed?" replaces the old `detectDirectRead` / `detectImplicitRead`
 * heuristics. The user controls the boundary:
 *
 * - `doc.title` (TextRef — IS a Changefeed) → `directReadSource` set, `read()` synthesized
 * - `doc.title()` (string — NOT a Changefeed) → user's expression as-is
 * - `doc.title.get()` (string — NOT a Changefeed) → user's expression as-is
 *
 * When the expression IS a Changefeed:
 * - `directReadSource` = expression text (e.g. `"doc.title"`)
 * - `source` = `read(doc.title)` — synthesized via the universal read helper
 * - Codegen dispatches on `directReadSource` + `deltaKind` for surgical regions
 *
 * When the expression is NOT a Changefeed but depends on one(s):
 * - `directReadSource` is NOT set
 * - `source` = user's expression verbatim
 * - Codegen emits `valueRegion` with replace semantics
 */
export function analyzeExpression(
  expr: Expression,
  scope?: BindingScope,
): ContentNode {
  const span = getSpan(expr)
  const rawSource = expr.getText()

  // String literal -> literal content (no ExpressionIR needed)
  if (expr.getKind() === SyntaxKind.StringLiteral) {
    const value = rawSource.slice(1, -1)
    return createLiteral(value, span)
  }

  // No substitution template literal -> literal content
  if (expr.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    const value = rawSource.slice(1, -1)
    return createLiteral(value, span)
  }

  // Build the ExpressionIR tree — single-pass structural analysis
  const exprIR = buildExpressionIR(expr, scope)

  // Derive reactivity and dependencies from the tree
  if (exprIsReactive(exprIR)) {
    const deps = extractDeps(exprIR)

    // Derive source from the expression tree (with auto-read insertion)
    const source = renderExpression(exprIR, { expandBindings: false })

    // Derive directReadSource: when the root is a RefReadNode or the
    // expression itself is a bare changefeed (the observation morphism).
    // This enables surgical text patching via textRegion.
    let directReadSource: string | undefined
    if (isRefRead(exprIR)) {
      // Auto-read: the whole expression is a single ref read
      // directReadSource is the ref path without the ()
      directReadSource = renderRefSource(exprIR.ref)
    }

    return createContent(
      source,
      "reactive",
      deps,
      span,
      directReadSource,
      exprIR,
    )
  }

  // Bare changefeed in content position: the ExpressionIR builder doesn't
  // wrap bare identifiers/property-accesses in RefRead (that's the consumer's
  // job — binary, unary, method-call builders do the wrapping). But when a
  // bare changefeed appears as the entire expression in content position
  // (e.g., `h1(doc.title)` or `span(doc.favorites)`), the compiler must
  // auto-read it. Detect this case via the AST type and promote to reactive.
  const exprType = expr.getType()
  if (isChangefeedType(exprType)) {
    const deltaKind = getDeltaKind(exprType)
    const autoReadIR = refRead(exprIR, deltaKind)
    const deps = extractDeps(autoReadIR)
    const source = renderExpression(autoReadIR, { expandBindings: false })
    const directReadSource = renderRefSource(exprIR)
    return createContent(
      source,
      "reactive",
      deps,
      span,
      directReadSource,
      autoReadIR,
    )
  }

  // Non-reactive expression — render-time evaluation
  const source = renderExpression(exprIR, { expandBindings: false })
  return createContent(source, "render", [], span, undefined, exprIR)
}

// =============================================================================
// Props Analysis
// =============================================================================

/**
 * Analyze props object literal.
 */
export function analyzeProps(
  obj: ObjectLiteralExpression,
  scope?: BindingScope,
): {
  attributes: AttributeNode[]
  eventHandlers: EventHandlerNode[]
} {
  const attributes: AttributeNode[] = []
  const eventHandlers: EventHandlerNode[] = []

  for (const prop of obj.getProperties()) {
    // Property assignment: { name: value }
    if (prop.getKind() === SyntaxKind.PropertyAssignment) {
      let name = prop.getChildAtIndex(0)?.getText() ?? ""
      // Strip quotes from property names like "data-testid"
      if (
        (name.startsWith('"') && name.endsWith('"')) ||
        (name.startsWith("'") && name.endsWith("'"))
      ) {
        name = name.slice(1, -1)
      }
      const valueNode = prop.getChildAtIndex(2)

      if (!valueNode || !Node.isExpression(valueNode)) continue

      if (isEventHandlerProp(name)) {
        // Event handler
        const eventName = name.slice(2).toLowerCase() // onClick -> click
        eventHandlers.push({
          event: eventName,
          propName: name,
          handlerSource: valueNode.getText(),
          span: getSpan(prop),
        })
      } else {
        // Regular attribute
        const value = analyzeExpression(valueNode, scope)
        attributes.push({ name, value })
      }
    }

    // Shorthand property: { name }
    if (prop.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
      const name = prop.getText()
      const value = createContent(name, "render", [], getSpan(prop))
      attributes.push({ name, value })
    }
  }

  return { attributes, eventHandlers }
}

// =============================================================================
// Statement Analysis
// =============================================================================

/**
 * Analyze a for..of statement.
 */
export function analyzeForOfStatement(
  stmt: ForOfStatement,
  scope?: BindingScope,
): ChildNode | null {
  const span = getSpan(stmt)

  // Get the initializer (the variable declaration)
  const initializer = stmt.getInitializer()
  if (!initializer) return null

  // Extract variable name(s)
  let itemVariable: string
  let indexVariable: string | null = null

  if (initializer.getKind() === SyntaxKind.VariableDeclarationList) {
    const decls = initializer.getDescendantsOfKind(
      SyntaxKind.VariableDeclaration,
    )
    if (decls.length === 0) return null

    const firstDecl = decls[0]
    const nameNode = firstDecl.getNameNode()

    // Simple variable: for (const item of list)
    if (nameNode.getKind() === SyntaxKind.Identifier) {
      itemVariable = nameNode.getText()
    }
    // Array destructuring: for (const [index, item] of list.entries())
    else if (nameNode.getKind() === SyntaxKind.ArrayBindingPattern) {
      const arrayBinding = nameNode as ArrayBindingPattern
      const elements = arrayBinding.getElements()
      if (elements.length >= 2) {
        indexVariable = elements[0].getText()
        itemVariable = elements[1].getText()
      } else if (elements.length === 1) {
        itemVariable = elements[0].getText()
      } else {
        return null
      }
    } else {
      return null
    }
  } else {
    return null
  }

  // Get the expression being iterated
  const iterExpr = stmt.getExpression()
  const listSource = iterExpr.getText()

  // Analyze the body with a child scope (loop body is a new block scope)
  const body = stmt.getStatement()
  const bodyScope = scope?.child()
  const bodyChildren = analyzeStatementBody(body, bodyScope)

  // Determine binding time: is the iterable a changefeed (reactive list)?
  // Check the iterable's own type first. If that's not a changefeed, also
  // check parent objects in property access chains and method call receivers.
  // This handles patterns like:
  //   - `doc.items` where `doc` is a TypedDoc (HasChangefeed) but `items`
  //     itself may be typed as `any` from a shape mock
  //   - `items.entries()` where `items` is a ListRef (changefeed) but the
  //     return type of `.entries()` is `IterableIterator` (not changefeed)
  let isReactive = isChangefeedType(iterExpr.getType())
  if (
    !isReactive &&
    iterExpr.getKind() === SyntaxKind.PropertyAccessExpression
  ) {
    const propAccess = iterExpr as PropertyAccessExpression
    const objType = propAccess.getExpression().getType()
    if (isChangefeedType(objType)) {
      isReactive = true
    }
  }
  if (!isReactive && iterExpr.getKind() === SyntaxKind.CallExpression) {
    const call = iterExpr as CallExpression
    const calleeExpr = call.getExpression()
    // Check if the callee is a method on a changefeed receiver:
    // e.g., `items.entries()` where `items` is a ListRef
    if (calleeExpr.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = calleeExpr as PropertyAccessExpression
      const receiverType = propAccess.getExpression().getType()
      if (isChangefeedType(receiverType)) {
        isReactive = true
      }
    }
  }

  // Extract dependencies with delta kind for reactive loops
  const dependencies: Dependency[] = isReactive
    ? [{ source: listSource, deltaKind: getDeltaKind(iterExpr.getType()) }]
    : []

  let loopNode = createLoop(
    listSource,
    isReactive ? "reactive" : "render",
    itemVariable,
    indexVariable,
    bodyChildren,
    dependencies,
    span,
  )

  // Stage 3: detect filter pattern and annotate with classified metadata
  const filter = detectFilterPattern(loopNode)
  if (filter) {
    loopNode = createLoop(
      loopNode.iterableSource,
      loopNode.iterableBindingTime,
      loopNode.itemVariable,
      loopNode.indexVariable,
      loopNode.body,
      loopNode.dependencies,
      loopNode.span,
      filter,
    )
  }

  return loopNode
}

/**
 * Analyze an if statement.
 *
 * Always produces a unified ConditionalNode with flat branches.
 * - subscriptionTarget === null → render-time conditional
 * - subscriptionTarget !== null → reactive conditional
 *
 * Else-if chains are flattened into the branches array (not nested).
 */
export function analyzeIfStatement(
  stmt: IfStatement,
  scope?: BindingScope,
): ChildNode | null {
  const span = getSpan(stmt)

  // Analyze the condition (with scope so bindings in predicates are resolved)
  const condExpr = stmt.getExpression()
  const condition = analyzeExpression(condExpr, scope)

  // Extract subscription target for reactive conditions
  let subscriptionTarget: Dependency | null = null
  if (
    condition.bindingTime === "reactive" &&
    condition.dependencies.length > 0
  ) {
    subscriptionTarget = condition.dependencies[0]
  }

  // Analyze then branch (const is block-scoped, so use child scope)
  const thenStmt = stmt.getThenStatement()
  const thenScope = scope?.child()
  const thenBody = analyzeStatementBody(thenStmt, thenScope)

  // Build branches array - always use flat structure
  const branches: ConditionalBranch[] = [
    createConditionalBranch(condition, thenBody, getSpan(thenStmt)),
  ]

  // Analyze else branch (if present)
  const elseStmt = stmt.getElseStatement()

  if (elseStmt) {
    // else if -> recurse and flatten
    if (elseStmt.getKind() === SyntaxKind.IfStatement) {
      const nestedIf = analyzeIfStatement(elseStmt as IfStatement, scope)
      if (nestedIf && nestedIf.kind === "conditional") {
        // Flatten: merge nested branches into this conditional
        branches.push(...nestedIf.branches)
        // Inherit subscription target if we don't have one
        if (!subscriptionTarget && nestedIf.subscriptionTarget) {
          subscriptionTarget = nestedIf.subscriptionTarget
        }
      }
    } else {
      // else -> analyze body and add as final branch with null condition
      const elseScope = scope?.child()
      const elseBody = analyzeStatementBody(elseStmt, elseScope)
      branches.push(createConditionalBranch(null, elseBody, getSpan(elseStmt)))
    }
  }

  return createConditional(branches, subscriptionTarget, span)
}

/**
 * Analyze statements within a block or single statement.
 */
export function analyzeStatementBody(
  stmt: Statement,
  scope?: BindingScope,
): ChildNode[] {
  const children: ChildNode[] = []

  if (stmt.getKind() === SyntaxKind.Block) {
    const block = stmt as Block
    for (const innerStmt of block.getStatements()) {
      const child = analyzeStatement(innerStmt, scope)
      if (child) {
        children.push(...child)
      }
    }
  } else {
    const child = analyzeStatement(stmt, scope)
    if (child) {
      children.push(...child)
    }
  }

  return children
}

/**
 * Analyze a single statement.
 *
 * Returns an array because some statements may produce multiple children
 * or no children at all.
 *
 * Statements that aren't UI-specific (element calls, control flow) are
 * captured as StatementNode to preserve them in the generated code.
 */
export function analyzeStatement(
  stmt: Statement,
  scope?: BindingScope,
): ChildNode[] | null {
  const span = getSpan(stmt)

  // Return statement - not supported in builder functions
  if (stmt.getKind() === SyntaxKind.ReturnStatement) {
    const line = stmt.getStartLineNumber()
    throw new Error(
      `Kyneta Compiler Error: Return statement not supported in builder function at line ${line}.\n` +
        `Builder functions must produce DOM elements, not return early.`,
    )
  }

  // Expression statement (most common - element calls)
  if (stmt.getKind() === SyntaxKind.ExpressionStatement) {
    const exprStmt = stmt as ExpressionStatement
    const expr = exprStmt.getExpression()
    if (!expr) {
      // Empty expression - capture as statement
      return [createStatement(stmt.getText(), span)]
    }

    // Check for element factory call
    if (expr.getKind() === SyntaxKind.CallExpression) {
      const call = expr as CallExpression
      const element = analyzeElementCall(call, scope)
      if (element) {
        return [element]
      }
    }

    // Non-element expression statement (e.g., console.log(), function calls)
    // Capture as statement to preserve in output
    return [createStatement(stmt.getText(), span)]
  }

  // For..of statement
  if (stmt.getKind() === SyntaxKind.ForOfStatement) {
    const region = analyzeForOfStatement(stmt as ForOfStatement, scope)
    if (region) {
      return [region]
    }
    // If analysis fails, capture as statement
    return [createStatement(stmt.getText(), span)]
  }

  // If statement
  if (stmt.getKind() === SyntaxKind.IfStatement) {
    const region = analyzeIfStatement(stmt as IfStatement, scope)
    if (region) {
      return [region]
    }
    // If analysis fails, capture as statement
    return [createStatement(stmt.getText(), span)]
  }

  // Labeled statement — detect client:/server: target blocks
  if (stmt.getKind() === SyntaxKind.LabeledStatement) {
    const labeled = stmt as LabeledStatement
    const label = labeled.getLabel().getText()

    if (label === "client" || label === "server") {
      const body = labeled.getStatement()
      const children: ChildNode[] = []

      if (body.getKind() === SyntaxKind.Block) {
        const block = body as Block
        for (const innerStmt of block.getStatements()) {
          const result = analyzeStatement(innerStmt, scope)
          if (result) {
            children.push(...result)
          }
        }
      } else {
        // Single statement body (e.g., `client: console.log("hi")`)
        const result = analyzeStatement(body as Statement, scope)
        if (result) {
          children.push(...result)
        }
      }

      return [createLabeledBlock(label, children, span)]
    }

    // Unknown label — fall through to verbatim statement capture
    return [createStatement(stmt.getText(), span)]
  }

  // Block statement - recursively analyze contents
  if (stmt.getKind() === SyntaxKind.Block) {
    const block = stmt as Block
    const children: ChildNode[] = []
    for (const innerStmt of block.getStatements()) {
      const result = analyzeStatement(innerStmt, scope)
      if (result) {
        children.push(...result)
      }
    }
    return children.length > 0 ? children : null
  }

  // Variable declaration (const x = ..., let y = ...)
  if (stmt.getKind() === SyntaxKind.VariableStatement) {
    const varStmt = stmt as any // VariableStatement
    const declarations = varStmt.getDeclarationList().getDeclarations()
    const declarationKind = varStmt
      .getDeclarationList()
      .getDeclarationKind() as string

    // Reject mutable bindings with instructive error
    if (declarationKind === "let" || declarationKind === "var") {
      const line = stmt.getStartLineNumber()
      throw new Error(
        `Kyneta Compiler Error: Mutable binding \`${declarationKind}\` in builder body at line ${line}.\n` +
          `Builder bodies require \`const\` bindings for dependency tracking. ` +
          `If you need mutable state, use \`state(initialValue)\` to create a reactive ref.`,
      )
    }

    const results: ChildNode[] = []
    for (const decl of declarations) {
      const name = decl.getName()
      const initializer = decl.getInitializer()
      // Simple named bindings — destructuring is deferred (kept as StatementNode)
      if (
        initializer &&
        Node.isExpression(initializer) &&
        decl.getNameNode().getKind() === SyntaxKind.Identifier
      ) {
        const value = analyzeExpression(initializer, scope)
        if (scope) {
          scope.bind(name, value)
          // Only store ExpressionIR for reactive bindings — non-reactive bindings
          // (like `const x = 1`) should NOT produce BindingRefNodes, because
          // BindingRefNode is always classified as reactive by isReactive().
          if (value.expression && value.bindingTime === "reactive") {
            scope.bindExpression(name, value.expression)
          }
        }
        results.push(createBinding(name, value, getSpan(decl)))
      } else {
        // Destructuring or no initializer — keep as statement
        results.push(createStatement(stmt.getText(), span))
      }
    }
    return results
  }

  // Any other statement - capture verbatim to preserve in output
  // This includes: while, switch, try/catch, throw, etc.
  return [createStatement(stmt.getText(), span)]
}

// =============================================================================
// Element Analysis
// =============================================================================

/**
 * Analyze an element factory call.
 *
 * Handles various calling patterns:
 * - div(() => { ... })           - builder only
 * - div({ class: "x" }, () => { ... }) - props + builder
 * - div("text", span("nested"))  - children only
 * - div({ class: "x" }, "text")  - props + children
 */
export function analyzeElementCall(
  call: CallExpression,
  scope?: BindingScope,
): ChildNode | null {
  // Check if this is an HTML element or component call
  const info = checkElementOrComponent(call)
  if (!info.isElementOrComponent) {
    return null
  }

  const factoryName = info.name
  const isComponent = info.isComponent

  const args = call.getArguments() as Expression[]
  if (args.length === 0) {
    // Empty element/component: div() or MyComponent()
    return createElement(
      factoryName,
      [],
      [],
      [],
      [],
      getSpan(call),
      isComponent ? factoryName : undefined,
    )
  }

  let props: AttributeNode[] = []
  let eventHandlers: EventHandlerNode[] = []
  const children: ChildNode[] = []
  let startIndex = 0

  // Check if first argument is props object
  const firstArg = args[0]
  if (firstArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
    const propsResult = analyzeProps(firstArg as ObjectLiteralExpression, scope)
    props = propsResult.attributes
    eventHandlers = propsResult.eventHandlers
    startIndex = 1
  }

  // Process remaining arguments
  for (let i = startIndex; i < args.length; i++) {
    const arg = args[i]

    // Builder function: () => { ... }
    if (
      arg.getKind() === SyntaxKind.ArrowFunction ||
      arg.getKind() === SyntaxKind.FunctionExpression
    ) {
      const builderChildren = analyzeBuilderFunction(
        arg as ArrowFunction | FunctionExpression,
        scope,
      )
      children.push(...builderChildren)
    }
    // Nested element call: span("text")
    else if (arg.getKind() === SyntaxKind.CallExpression) {
      const nestedElement = analyzeElementCall(arg as CallExpression, scope)
      if (nestedElement) {
        children.push(nestedElement)
      } else {
        // Not an element call - treat as expression (e.g., count.get())
        const content = analyzeExpression(arg, scope)
        children.push(content)
      }
    }
    // String or expression
    else {
      const content = analyzeExpression(arg, scope)
      children.push(content)
    }
  }

  return createElement(
    factoryName,
    props,
    eventHandlers,
    [],
    children,
    getSpan(call),
    isComponent ? factoryName : undefined,
  )
}

/**
 * Analyze a builder function body.
 */
export function analyzeBuilderFunction(
  fn: ArrowFunction | FunctionExpression,
  scope?: BindingScope,
): ChildNode[] {
  const body = fn.getBody()
  if (!body) return []

  // Arrow function with expression body: () => expr
  if (body.getKind() !== SyntaxKind.Block) {
    // Body is an expression
    if (body.getKind() === SyntaxKind.CallExpression) {
      const element = analyzeElementCall(body as CallExpression, scope)
      if (element) {
        return [element]
      }
    }
    if (Node.isExpression(body)) {
      const content = analyzeExpression(body, scope)
      return [content]
    }
    return []
  }

  // Arrow function or regular function with block body
  const block = body as Block
  const children: ChildNode[] = []
  for (const stmt of block.getStatements()) {
    const result = analyzeStatement(stmt, scope)
    if (result) {
      children.push(...result)
    }
  }
  return children
}

// =============================================================================
// Main Entry Point
// =============================================================================

/**
 * Find all builder calls in a source file.
 *
 * Returns an array of call expressions that are element factory calls
 * with builder function arguments.
 */
export function findBuilderCalls(sourceFile: SourceFile): CallExpression[] {
  const calls: CallExpression[] = []

  const allCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)

  for (const call of allCalls) {
    // Use two-tier detection: HTML elements OR ComponentFactory types
    const info = checkElementOrComponent(call)
    if (!info.isElementOrComponent) {
      continue
    }

    // Check if any argument is a builder function
    const args = call.getArguments()
    const hasBuilder = args.some(
      arg =>
        arg.getKind() === SyntaxKind.ArrowFunction ||
        arg.getKind() === SyntaxKind.FunctionExpression,
    )

    if (!hasBuilder) {
      continue
    }

    // Only include top-level builder calls, not nested ones.
    // A builder call is nested if it's inside an arrow function that is
    // an argument to another element factory call.
    const isNested = isNestedBuilderCall(call)
    if (!isNested) {
      calls.push(call)
    }
  }

  return calls
}

/**
 * Check if a call expression is nested inside another builder function.
 */
function isNestedBuilderCall(call: CallExpression): boolean {
  let current: Node | undefined = call.getParent()

  while (current) {
    // If we find an arrow function or function expression...
    if (
      current.getKind() === SyntaxKind.ArrowFunction ||
      current.getKind() === SyntaxKind.FunctionExpression
    ) {
      // Check if its parent is a call expression to an element factory or component
      const funcParent = current.getParent()
      if (funcParent && funcParent.getKind() === SyntaxKind.CallExpression) {
        const parentCall = funcParent as CallExpression
        const parentInfo = checkElementOrComponent(parentCall)
        if (parentInfo.isElementOrComponent) {
          // This call is inside a builder function of an element factory or component
          return true
        }
      }
    }
    current = current.getParent()
  }

  return false
}

/**
 * Analyze a builder call and produce IR.
 *
 * This is the main entry point for analyzing a single element factory call.
 * Supports both HTML elements and ComponentFactory-typed functions.
 */
export function analyzeBuilder(call: CallExpression): BuilderNode | null {
  // Create a root BindingScope for this builder — bindings registered during
  // analysis of the builder function body are looked up when downstream
  // expressions reference bound names.
  const scope = createBindingScope()

  // Use two-tier detection: HTML elements OR ComponentFactory types
  const info = checkElementOrComponent(call)
  if (!info.isElementOrComponent) {
    return null
  }

  const factoryName = info.name

  const args = call.getArguments()
  if (args.length === 0) {
    return createBuilder(factoryName, [], [], [], getSpan(call))
  }

  let props: AttributeNode[] = []
  let eventHandlers: EventHandlerNode[] = []
  const children: ChildNode[] = []
  let startIndex = 0

  // Check if first argument is props object
  const firstArg = args[0]
  if (firstArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
    const propsResult = analyzeProps(firstArg as ObjectLiteralExpression, scope)
    props = propsResult.attributes
    eventHandlers = propsResult.eventHandlers
    startIndex = 1
  }

  // Process remaining arguments (should be builder functions for top-level)
  const allArgs = args as Expression[]
  for (let i = startIndex; i < allArgs.length; i++) {
    const arg = allArgs[i]

    if (
      arg.getKind() === SyntaxKind.ArrowFunction ||
      arg.getKind() === SyntaxKind.FunctionExpression
    ) {
      const builderChildren = analyzeBuilderFunction(
        arg as ArrowFunction | FunctionExpression,
        scope,
      )
      children.push(...builderChildren)
    } else if (arg.getKind() === SyntaxKind.CallExpression) {
      const nestedElement = analyzeElementCall(arg as CallExpression, scope)
      if (nestedElement) {
        children.push(nestedElement)
      }
    } else {
      const content = analyzeExpression(arg, scope)
      children.push(content)
    }
  }

  return createBuilder(
    factoryName,
    props,
    eventHandlers,
    children,
    getSpan(call),
  )
}

/**
 * Analyze an entire source file.
 *
 * Returns an array of BuilderNodes, one for each top-level element factory call.
 */
export function analyzeSourceFile(sourceFile: SourceFile): BuilderNode[] {
  const calls = findBuilderCalls(sourceFile)
  const builders: BuilderNode[] = []

  for (const call of calls) {
    const builder = analyzeBuilder(call)
    if (builder) {
      builders.push(builder)
    }
  }

  return builders
}
