/**
 * AST Analysis for Kinetic Compiler
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
  Node,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type SourceFile,
  type Statement,
  SyntaxKind,
  type TemplateExpression,
  type Type,
} from "ts-morph"
import type {
  AttributeNode,
  BuilderNode,
  ChildNode,
  ConditionalBranch,
  ContentNode,
  ElementBinding,
  EventHandlerNode,
  SourceSpan,
} from "./ir.js"
import {
  createBuilder,
  createConditionalBranch,
  createConditionalRegion,
  createContent,
  createElement,
  createLiteral,
  createLoop,
  createSpan,
  createStatement,
  createStaticConditional,
} from "./ir.js"

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
 * Loro ref type names that indicate reactivity.
 */
const LORO_REF_TYPES = new Set([
  "TextRef",
  "CounterRef",
  "ListRef",
  "MovableListRef",
  "MapRef",
  "RecordRef",
  "StructRef",
  "TreeRef",
  // Also match the Loro container types directly
  "LoroText",
  "LoroCounter",
  "LoroList",
  "LoroMovableList",
  "LoroMap",
  "LoroTree",
])

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

/**
 * Check if a type is or contains a Loro ref type.
 *
 * This recursively checks union types, intersection types, and type arguments.
 */
export function isReactiveType(type: Type): boolean {
  // Check the type symbol name
  const symbol = type.getSymbol()
  if (symbol) {
    const name = symbol.getName()
    if (LORO_REF_TYPES.has(name)) {
      return true
    }
  }

  // Check alias symbol (for type aliases)
  const aliasSymbol = type.getAliasSymbol()
  if (aliasSymbol) {
    const name = aliasSymbol.getName()
    if (LORO_REF_TYPES.has(name)) {
      return true
    }
  }

  // Check type text for ref patterns
  const typeText = type.getText()
  for (const refType of LORO_REF_TYPES) {
    if (typeText.includes(refType)) {
      return true
    }
  }

  // Check union types
  if (type.isUnion()) {
    return type.getUnionTypes().some(t => isReactiveType(t))
  }

  // Check intersection types
  if (type.isIntersection()) {
    return type.getIntersectionTypes().some(t => isReactiveType(t))
  }

  // Check type arguments (for generic types)
  const typeArgs = type.getTypeArguments()
  if (typeArgs.length > 0) {
    return typeArgs.some(t => isReactiveType(t))
  }

  return false
}

/**
 * Check if an expression accesses a reactive ref.
 *
 * This uses the TypeScript type checker to determine if any part of
 * the expression has a Loro ref type.
 */
export function expressionIsReactive(expr: Expression): boolean {
  // Get the type of the expression
  const type = expr.getType()

  // Check if the result type is reactive
  if (isReactiveType(type)) {
    return true
  }

  // For property access chains, check each part
  if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
    const propAccess = expr as PropertyAccessExpression
    const objType = propAccess.getExpression().getType()
    if (isReactiveType(objType)) {
      return true
    }
    // Recursively check the object expression
    return expressionIsReactive(propAccess.getExpression())
  }

  // For call expressions, check the callee and arguments
  if (expr.getKind() === SyntaxKind.CallExpression) {
    const call = expr as CallExpression
    const calleeExpr = call.getExpression()

    // Check if calling a method on a reactive type
    if (calleeExpr.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = calleeExpr as PropertyAccessExpression
      const objType = propAccess.getExpression().getType()
      if (isReactiveType(objType)) {
        return true
      }
    }

    // Check arguments
    const callArgs = call.getArguments() as Expression[]
    for (const arg of callArgs) {
      if (expressionIsReactive(arg)) {
        return true
      }
    }
  }

  // For template literals, check embedded expressions
  if (expr.getKind() === SyntaxKind.TemplateExpression) {
    const templateExpr = expr as TemplateExpression
    const spans = templateExpr.getTemplateSpans()
    for (const span of spans) {
      const spanExpr = span.getExpression()
      if (expressionIsReactive(spanExpr)) {
        return true
      }
    }
  }

  // For binary expressions, check both sides
  if (expr.getKind() === SyntaxKind.BinaryExpression) {
    const children = expr.getChildren()
    for (const child of children) {
      if (Node.isExpression(child) && expressionIsReactive(child)) {
        return true
      }
    }
  }

  // For identifiers, check what they reference
  if (expr.getKind() === SyntaxKind.Identifier) {
    const symbol = expr.getSymbol()
    if (symbol) {
      const decls = symbol.getDeclarations()
      for (const decl of decls) {
        const declType = decl.getType()
        if (isReactiveType(declType)) {
          return true
        }
      }
    }
  }

  return false
}

/**
 * Extract the reactive dependencies from an expression.
 *
 * Returns an array of source text for each ref access (e.g., ["doc.count", "item.text"]).
 */
export function extractDependencies(expr: Expression): string[] {
  const deps: string[] = []

  function visit(node: Node): void {
    // Property access on a reactive type
    if (node.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = node as PropertyAccessExpression
      const objType = propAccess.getExpression().getType()
      if (isReactiveType(objType)) {
        deps.push(propAccess.getExpression().getText())
      }
    }

    // Call expression on a reactive type
    if (node.getKind() === SyntaxKind.CallExpression) {
      const call = node as CallExpression
      const calleeExpr = call.getExpression()

      if (calleeExpr.getKind() === SyntaxKind.PropertyAccessExpression) {
        const propAccess = calleeExpr as PropertyAccessExpression
        const objExpr = propAccess.getExpression()
        const objType = objExpr.getType()
        if (isReactiveType(objType)) {
          deps.push(objExpr.getText())
        }
      }
    }

    // Identifier that is a reactive type
    if (node.getKind() === SyntaxKind.Identifier) {
      const type = (node as Expression).getType()
      if (isReactiveType(type)) {
        deps.push(node.getText())
      }
    }

    // Recurse into children
    node.forEachChild(visit)
  }

  visit(expr)

  // Deduplicate
  return [...new Set(deps)]
}

// =============================================================================
// Expression Analysis
// =============================================================================

/**
 * Analyze an expression and return the appropriate content node.
 */
export function analyzeExpression(expr: Expression): ContentNode {
  const span = getSpan(expr)
  const source = expr.getText()

  // String literal -> literal content
  if (expr.getKind() === SyntaxKind.StringLiteral) {
    // Strip quotes
    const value = source.slice(1, -1)
    return createLiteral(value, span)
  }

  // No substitution template literal -> literal content
  if (expr.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    // Strip backticks
    const value = source.slice(1, -1)
    return createLiteral(value, span)
  }

  // Check if reactive
  if (expressionIsReactive(expr)) {
    const deps = extractDependencies(expr)
    return createContent(source, "reactive", deps, span)
  }

  // Render-time expression
  return createContent(source, "render", [], span)
}

// =============================================================================
// Props Analysis
// =============================================================================

/**
 * Check if a call expression is a bind() call.
 */
function isBindCall(expr: Expression): boolean {
  if (expr.getKind() !== SyntaxKind.CallExpression) {
    return false
  }
  const call = expr as CallExpression
  const callee = call.getExpression()
  return callee.getText() === "bind"
}

/**
 * Extract the ref source from a bind() call.
 */
function extractBindRefSource(expr: CallExpression): string | null {
  const args = expr.getArguments()
  if (args.length === 0) {
    return null
  }
  return args[0].getText()
}

/**
 * Binding information extracted from props.
 */
export interface BindingInfo {
  /** The attribute being bound (e.g., "value", "checked") */
  attribute: string
  /** The ref source (e.g., "doc.title") */
  refSource: string
  /** The type of binding */
  bindingType: "value" | "checked"
  /** Source span */
  span: SourceSpan
}

/**
 * Analyze props object literal.
 */
export function analyzeProps(obj: ObjectLiteralExpression): {
  attributes: AttributeNode[]
  eventHandlers: EventHandlerNode[]
  bindings: BindingInfo[]
} {
  const attributes: AttributeNode[] = []
  const eventHandlers: EventHandlerNode[] = []
  const bindings: BindingInfo[] = []

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
          handlerSource: valueNode.getText(),
          span: getSpan(prop),
        })
      } else if (isBindCall(valueNode)) {
        // Two-way binding: value: bind(doc.title)
        const refSource = extractBindRefSource(valueNode as CallExpression)
        if (refSource) {
          const bindingType = name === "checked" ? "checked" : "value"
          bindings.push({
            attribute: name,
            refSource,
            bindingType,
            span: getSpan(prop),
          })
        }
      } else {
        // Regular attribute
        const value = analyzeExpression(valueNode)
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

  return { attributes, eventHandlers, bindings }
}

// =============================================================================
// Statement Analysis
// =============================================================================

/**
 * Analyze a for..of statement.
 */
export function analyzeForOfStatement(stmt: ForOfStatement): ChildNode | null {
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

  // Analyze the body
  const body = stmt.getStatement()
  const bodyChildren = analyzeStatementBody(body)

  // Determine binding time from reactivity analysis
  const isReactive = expressionIsReactive(iterExpr)

  return createLoop(
    listSource,
    isReactive ? "reactive" : "render",
    itemVariable,
    indexVariable,
    bodyChildren,
    isReactive ? [listSource] : [],
    span,
  )
}

/**
 * Analyze an if statement.
 */
export function analyzeIfStatement(stmt: IfStatement): ChildNode | null {
  const span = getSpan(stmt)

  // Analyze the condition
  const condExpr = stmt.getExpression()
  const condition = analyzeExpression(condExpr)

  // Extract subscription target
  let subscriptionTarget: string | null = null
  if (
    condition.bindingTime === "reactive" &&
    condition.dependencies.length > 0
  ) {
    subscriptionTarget = condition.dependencies[0]
  }

  // Analyze then branch
  const thenStmt = stmt.getThenStatement()
  const thenBody = analyzeStatementBody(thenStmt)

  // Analyze else branch (if present)
  const elseStmt = stmt.getElseStatement()
  let elseBody: ChildNode[] | null = null

  if (elseStmt) {
    // else if -> recurse
    if (elseStmt.getKind() === SyntaxKind.IfStatement) {
      const nestedIf = analyzeIfStatement(elseStmt as IfStatement)
      if (nestedIf) {
        // For reactive nested if, merge into conditional region
        if (nestedIf.kind === "conditional-region") {
          // Build branches for reactive conditional
          const branches: ConditionalBranch[] = [
            createConditionalBranch(condition, thenBody, getSpan(thenStmt)),
            ...nestedIf.branches,
          ]
          // Use the first reactive subscription target found
          if (!subscriptionTarget && nestedIf.subscriptionTarget) {
            subscriptionTarget = nestedIf.subscriptionTarget
          }
          return createConditionalRegion(branches, subscriptionTarget, span)
        }
        // For static nested if, wrap it as the else body
        elseBody = [nestedIf]
      }
    } else {
      // else -> analyze body
      elseBody = analyzeStatementBody(elseStmt)
    }
  }

  // Static conditional - runs once at render time
  if (!subscriptionTarget && condition.bindingTime !== "reactive") {
    return createStaticConditional(condition.source, thenBody, elseBody, span)
  }

  // Reactive conditional - subscribes to condition changes
  const branches: ConditionalBranch[] = [
    createConditionalBranch(condition, thenBody, getSpan(thenStmt)),
  ]
  if (elseBody !== null && elseStmt) {
    branches.push(createConditionalBranch(null, elseBody, getSpan(elseStmt)))
  }

  return createConditionalRegion(branches, subscriptionTarget, span)
}

/**
 * Analyze statements within a block or single statement.
 */
export function analyzeStatementBody(stmt: Statement): ChildNode[] {
  const children: ChildNode[] = []

  if (stmt.getKind() === SyntaxKind.Block) {
    const block = stmt as Block
    for (const innerStmt of block.getStatements()) {
      const child = analyzeStatement(innerStmt)
      if (child) {
        children.push(...child)
      }
    }
  } else {
    const child = analyzeStatement(stmt)
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
export function analyzeStatement(stmt: Statement): ChildNode[] | null {
  const span = getSpan(stmt)

  // Return statement - not supported in builder functions
  if (stmt.getKind() === SyntaxKind.ReturnStatement) {
    const line = stmt.getStartLineNumber()
    throw new Error(
      `Kinetic Compiler Error: Return statement not supported in builder function at line ${line}.\n` +
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
      const element = analyzeElementCall(call)
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
    const region = analyzeForOfStatement(stmt as ForOfStatement)
    if (region) {
      return [region]
    }
    // If analysis fails, capture as statement
    return [createStatement(stmt.getText(), span)]
  }

  // If statement
  if (stmt.getKind() === SyntaxKind.IfStatement) {
    const region = analyzeIfStatement(stmt as IfStatement)
    if (region) {
      return [region]
    }
    // If analysis fails, capture as statement
    return [createStatement(stmt.getText(), span)]
  }

  // Block statement - recursively analyze contents
  if (stmt.getKind() === SyntaxKind.Block) {
    const block = stmt as Block
    const children: ChildNode[] = []
    for (const innerStmt of block.getStatements()) {
      const result = analyzeStatement(innerStmt)
      if (result) {
        children.push(...result)
      }
    }
    return children.length > 0 ? children : null
  }

  // Variable declaration (const x = ..., let y = ...)
  if (stmt.getKind() === SyntaxKind.VariableStatement) {
    return [createStatement(stmt.getText(), span)]
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
export function analyzeElementCall(call: CallExpression): ChildNode | null {
  // Get the function being called
  const callee = call.getExpression()
  if (callee.getKind() !== SyntaxKind.Identifier) {
    return null
  }

  const factoryName = callee.getText()
  if (!ELEMENT_FACTORIES.has(factoryName)) {
    return null
  }

  const args = call.getArguments() as Expression[]
  if (args.length === 0) {
    // Empty element: div()
    return createElement(factoryName, [], [], [], [], getSpan(call))
  }

  let props: AttributeNode[] = []
  let eventHandlers: EventHandlerNode[] = []
  let bindings: ElementBinding[] = []
  const children: ChildNode[] = []
  let startIndex = 0

  // Check if first argument is props object
  const firstArg = args[0]
  if (firstArg.getKind() === SyntaxKind.ObjectLiteralExpression) {
    const propsResult = analyzeProps(firstArg as ObjectLiteralExpression)
    props = propsResult.attributes
    eventHandlers = propsResult.eventHandlers
    bindings = propsResult.bindings.map(b => ({
      attribute: b.attribute,
      refSource: b.refSource,
      bindingType: b.bindingType,
      span: b.span,
    }))
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
      )
      children.push(...builderChildren)
    }
    // Nested element call: span("text")
    else if (arg.getKind() === SyntaxKind.CallExpression) {
      const nestedElement = analyzeElementCall(arg as CallExpression)
      if (nestedElement) {
        children.push(nestedElement)
      } else {
        // Not an element call - treat as expression (e.g., count.get())
        const content = analyzeExpression(arg)
        children.push(content)
      }
    }
    // String or expression
    else {
      const content = analyzeExpression(arg)
      children.push(content)
    }
  }

  return createElement(
    factoryName,
    props,
    eventHandlers,
    bindings,
    children,
    getSpan(call),
  )
}

/**
 * Analyze a builder function body.
 */
export function analyzeBuilderFunction(
  fn: ArrowFunction | FunctionExpression,
): ChildNode[] {
  const body = fn.getBody()
  if (!body) return []

  // Arrow function with expression body: () => expr
  if (body.getKind() !== SyntaxKind.Block) {
    // Body is an expression
    if (body.getKind() === SyntaxKind.CallExpression) {
      const element = analyzeElementCall(body as CallExpression)
      if (element) {
        return [element]
      }
    }
    if (Node.isExpression(body)) {
      const content = analyzeExpression(body)
      return [content]
    }
    return []
  }

  // Arrow function or regular function with block body
  const block = body as Block
  const children: ChildNode[] = []
  for (const stmt of block.getStatements()) {
    const result = analyzeStatement(stmt)
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
    const callee = call.getExpression()
    if (callee.getKind() !== SyntaxKind.Identifier) {
      continue
    }

    const name = callee.getText()
    if (!ELEMENT_FACTORIES.has(name)) {
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
      // Check if its parent is a call expression to an element factory
      const funcParent = current.getParent()
      if (funcParent && funcParent.getKind() === SyntaxKind.CallExpression) {
        const parentCall = funcParent as CallExpression
        const parentCallee = parentCall.getExpression()
        if (parentCallee.getKind() === SyntaxKind.Identifier) {
          const parentName = parentCallee.getText()
          if (ELEMENT_FACTORIES.has(parentName)) {
            // This call is inside a builder function of an element factory
            return true
          }
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
 */
export function analyzeBuilder(call: CallExpression): BuilderNode | null {
  const callee = call.getExpression()
  if (callee.getKind() !== SyntaxKind.Identifier) {
    return null
  }

  const factoryName = callee.getText()
  if (!ELEMENT_FACTORIES.has(factoryName)) {
    return null
  }

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
    const propsResult = analyzeProps(firstArg as ObjectLiteralExpression)
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
      )
      children.push(...builderChildren)
    } else if (arg.getKind() === SyntaxKind.CallExpression) {
      const nestedElement = analyzeElementCall(arg as CallExpression)
      if (nestedElement) {
        children.push(nestedElement)
      }
    } else {
      const content = analyzeExpression(arg)
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
