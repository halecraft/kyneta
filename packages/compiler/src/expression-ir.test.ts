/**
 * Tests for ExpressionIR types, factory functions, type guards,
 * dependency extraction, reactivity detection, and expression rendering.
 *
 * These tests validate the foundational data model for the Expression IR —
 * the tree representation that replaces pre-baked source strings in the
 * compiler IR.
 */

import { describe, expect, it } from "vitest"
import {
  // Factory functions
  refRead,
  snapshot,
  bindingRef,
  methodCall,
  propertyAccess,
  call,
  binary,
  unary,
  template,
  literal,
  identifier,
  raw,

  // Type guards
  isRefRead,
  isSnapshot,
  isBindingRef,
  isMethodCall,
  isPropertyAccess,
  isCall,
  isBinary,
  isUnary,
  isTemplate,
  isLiteral,
  isIdentifier,
  isRaw,

  // Derived properties
  extractDeps,
  isReactive,
  renderRefSource,

  // Rendering
  renderExpression,
  type RenderContext,

  // Types
  type ExpressionIR,
} from "./expression-ir.js"

// =============================================================================
// Factory Function Tests
// =============================================================================

describe("Factory functions", () => {
  it("refRead creates a RefReadNode", () => {
    const ref = identifier("filterText")
    const node = refRead(ref, "replace")
    expect(node).toEqual({
      kind: "ref-read",
      ref: { kind: "identifier", name: "filterText" },
      deltaKind: "replace",
    })
  })

  it("snapshot creates a SnapshotNode with deltaKind", () => {
    const ref = propertyAccess(identifier("recipe"), "name")
    const node = snapshot(ref, [], "text")
    expect(node).toEqual({
      kind: "snapshot",
      ref: { kind: "property-access", object: { kind: "identifier", name: "recipe" }, property: "name" },
      args: [],
      deltaKind: "text",
    })
  })

  it("snapshot with arguments", () => {
    const ref = identifier("someRef")
    const arg = literal("42")
    const node = snapshot(ref, [arg], "replace")
    expect(node.kind).toBe("snapshot")
    expect(node.args).toHaveLength(1)
    expect(node.args[0]).toEqual({ kind: "literal", value: "42" })
  })

  it("bindingRef creates a BindingRefNode", () => {
    const expr = refRead(identifier("filterText"), "replace")
    const node = bindingRef("nameMatch", expr)
    expect(node).toEqual({
      kind: "binding-ref",
      name: "nameMatch",
      expression: {
        kind: "ref-read",
        ref: { kind: "identifier", name: "filterText" },
        deltaKind: "replace",
      },
    })
  })

  it("methodCall creates a MethodCallNode", () => {
    const receiver = identifier("str")
    const node = methodCall(receiver, "toLowerCase", [])
    expect(node).toEqual({
      kind: "method-call",
      receiver: { kind: "identifier", name: "str" },
      method: "toLowerCase",
      args: [],
    })
  })

  it("methodCall with arguments", () => {
    const receiver = identifier("str")
    const arg = literal("\"x\"")
    const node = methodCall(receiver, "includes", [arg])
    expect(node.kind).toBe("method-call")
    expect(node.method).toBe("includes")
    expect(node.args).toHaveLength(1)
  })

  it("propertyAccess creates a PropertyAccessNode", () => {
    const node = propertyAccess(identifier("recipe"), "name")
    expect(node).toEqual({
      kind: "property-access",
      object: { kind: "identifier", name: "recipe" },
      property: "name",
    })
  })

  it("call creates a CallNode", () => {
    const callee = identifier("someFunction")
    const node = call(callee, [literal("1")])
    expect(node).toEqual({
      kind: "call",
      callee: { kind: "identifier", name: "someFunction" },
      args: [{ kind: "literal", value: "1" }],
    })
  })

  it("binary creates a BinaryNode", () => {
    const node = binary(identifier("a"), "&&", identifier("b"))
    expect(node).toEqual({
      kind: "binary",
      left: { kind: "identifier", name: "a" },
      op: "&&",
      right: { kind: "identifier", name: "b" },
    })
  })

  it("unary creates a UnaryNode (prefix by default)", () => {
    const node = unary("!", identifier("x"))
    expect(node).toEqual({
      kind: "unary",
      op: "!",
      operand: { kind: "identifier", name: "x" },
      prefix: true,
    })
  })

  it("unary creates a postfix UnaryNode", () => {
    const node = unary("++", identifier("i"), false)
    expect(node.prefix).toBe(false)
  })

  it("template creates a TemplateNode", () => {
    // `Hello ${name}!`
    const node = template([
      literal("Hello "),
      identifier("name"),
      literal("!"),
    ])
    expect(node).toEqual({
      kind: "template",
      parts: [
        { kind: "literal", value: "Hello " },
        { kind: "identifier", name: "name" },
        { kind: "literal", value: "!" },
      ],
    })
  })

  it("literal creates a LiteralNode", () => {
    expect(literal("42")).toEqual({ kind: "literal", value: "42" })
    expect(literal("true")).toEqual({ kind: "literal", value: "true" })
    expect(literal("\"hello\"")).toEqual({ kind: "literal", value: "\"hello\"" })
  })

  it("identifier creates an IdentifierNode", () => {
    expect(identifier("foo")).toEqual({ kind: "identifier", name: "foo" })
  })

  it("raw creates a RawNode", () => {
    expect(raw("some.complex[expr]")).toEqual({
      kind: "raw",
      source: "some.complex[expr]",
    })
  })
})

// =============================================================================
// Type Guard Tests
// =============================================================================

describe("Type guards", () => {
  const nodes: Record<string, ExpressionIR> = {
    refRead: refRead(identifier("x"), "replace"),
    snapshot: snapshot(identifier("x"), [], "replace"),
    bindingRef: bindingRef("x", literal("1")),
    methodCall: methodCall(identifier("x"), "foo", []),
    propertyAccess: propertyAccess(identifier("x"), "y"),
    call: call(identifier("f"), []),
    binary: binary(literal("1"), "+", literal("2")),
    unary: unary("!", literal("true")),
    template: template([literal("hello")]),
    literal: literal("42"),
    identifier: identifier("x"),
    raw: raw("x"),
  }

  it("isRefRead identifies only RefReadNode", () => {
    expect(isRefRead(nodes.refRead)).toBe(true)
    for (const [key, node] of Object.entries(nodes)) {
      if (key !== "refRead") expect(isRefRead(node)).toBe(false)
    }
  })

  it("isSnapshot identifies only SnapshotNode", () => {
    expect(isSnapshot(nodes.snapshot)).toBe(true)
    for (const [key, node] of Object.entries(nodes)) {
      if (key !== "snapshot") expect(isSnapshot(node)).toBe(false)
    }
  })

  it("isBindingRef identifies only BindingRefNode", () => {
    expect(isBindingRef(nodes.bindingRef)).toBe(true)
    for (const [key, node] of Object.entries(nodes)) {
      if (key !== "bindingRef") expect(isBindingRef(node)).toBe(false)
    }
  })

  it("isMethodCall identifies only MethodCallNode", () => {
    expect(isMethodCall(nodes.methodCall)).toBe(true)
    for (const [key, node] of Object.entries(nodes)) {
      if (key !== "methodCall") expect(isMethodCall(node)).toBe(false)
    }
  })

  it("isPropertyAccess identifies only PropertyAccessNode", () => {
    expect(isPropertyAccess(nodes.propertyAccess)).toBe(true)
    for (const [key, node] of Object.entries(nodes)) {
      if (key !== "propertyAccess") expect(isPropertyAccess(node)).toBe(false)
    }
  })

  it("isCall identifies only CallNode", () => {
    expect(isCall(nodes.call)).toBe(true)
    for (const [key, node] of Object.entries(nodes)) {
      if (key !== "call") expect(isCall(node)).toBe(false)
    }
  })

  it("isBinary identifies only BinaryNode", () => {
    expect(isBinary(nodes.binary)).toBe(true)
    for (const [key, node] of Object.entries(nodes)) {
      if (key !== "binary") expect(isBinary(node)).toBe(false)
    }
  })

  it("isUnary identifies only UnaryNode", () => {
    expect(isUnary(nodes.unary)).toBe(true)
    for (const [key, node] of Object.entries(nodes)) {
      if (key !== "unary") expect(isUnary(node)).toBe(false)
    }
  })

  it("isTemplate identifies only TemplateNode", () => {
    expect(isTemplate(nodes.template)).toBe(true)
    for (const [key, node] of Object.entries(nodes)) {
      if (key !== "template") expect(isTemplate(node)).toBe(false)
    }
  })

  it("isLiteral identifies only LiteralNode", () => {
    expect(isLiteral(nodes.literal)).toBe(true)
    for (const [key, node] of Object.entries(nodes)) {
      if (key !== "literal") expect(isLiteral(node)).toBe(false)
    }
  })

  it("isIdentifier identifies only IdentifierNode", () => {
    expect(isIdentifier(nodes.identifier)).toBe(true)
    for (const [key, node] of Object.entries(nodes)) {
      if (key !== "identifier") expect(isIdentifier(node)).toBe(false)
    }
  })

  it("isRaw identifies only RawNode", () => {
    expect(isRaw(nodes.raw)).toBe(true)
    for (const [key, node] of Object.entries(nodes)) {
      if (key !== "raw") expect(isRaw(node)).toBe(false)
    }
  })
})

// =============================================================================
// extractDeps Tests
// =============================================================================

describe("extractDeps", () => {
  // ---------------------------------------------------------------------------
  // Single dependencies
  // ---------------------------------------------------------------------------

  it("extracts a single RefRead dependency", () => {
    // recipe.name (TextRef) — auto-read
    const expr = refRead(
      propertyAccess(identifier("recipe"), "name"),
      "text",
    )
    const deps = extractDeps(expr)
    expect(deps).toEqual([{ source: "recipe.name", deltaKind: "text" }])
  })

  it("extracts a single Snapshot dependency", () => {
    // recipe.name() — explicit read
    const expr = snapshot(
      propertyAccess(identifier("recipe"), "name"),
      [],
      "text",
    )
    const deps = extractDeps(expr)
    expect(deps).toEqual([{ source: "recipe.name", deltaKind: "text" }])
  })

  it("extracts a dependency from a bare identifier ref", () => {
    // filterText — LocalRef<string>
    const expr = refRead(identifier("filterText"), "replace")
    const deps = extractDeps(expr)
    expect(deps).toEqual([{ source: "filterText", deltaKind: "replace" }])
  })

  // ---------------------------------------------------------------------------
  // Multiple dependencies
  // ---------------------------------------------------------------------------

  it("extracts multiple RefRead dependencies from a binary expression", () => {
    // recipe.name().toLowerCase().includes(filterText().toLowerCase())
    // Simplified as: MethodCall(RefRead(recipe.name), "toLowerCase", [])
    //                  .includes(MethodCall(RefRead(filterText), "toLowerCase", []))
    const expr = methodCall(
      methodCall(
        refRead(propertyAccess(identifier("recipe"), "name"), "text"),
        "toLowerCase",
        [],
      ),
      "includes",
      [
        methodCall(
          refRead(identifier("filterText"), "replace"),
          "toLowerCase",
          [],
        ),
      ],
    )
    const deps = extractDeps(expr)
    expect(deps).toHaveLength(2)
    const sources = deps.map(d => d.source).sort()
    expect(sources).toEqual(["filterText", "recipe.name"])
    expect(deps.find(d => d.source === "recipe.name")!.deltaKind).toBe("text")
    expect(deps.find(d => d.source === "filterText")!.deltaKind).toBe("replace")
  })

  it("extracts deps from both sides of a binary expression", () => {
    // nameMatch && veggieMatch (binding refs)
    const nameMatchExpr = methodCall(
      refRead(propertyAccess(identifier("recipe"), "name"), "text"),
      "toLowerCase",
      [],
    )
    const veggieMatchExpr = refRead(
      propertyAccess(identifier("recipe"), "vegetarian"),
      "replace",
    )

    const expr = binary(
      bindingRef("nameMatch", nameMatchExpr),
      "&&",
      bindingRef("veggieMatch", veggieMatchExpr),
    )

    const deps = extractDeps(expr)
    expect(deps).toHaveLength(2)
    const sources = deps.map(d => d.source).sort()
    expect(sources).toEqual(["recipe.name", "recipe.vegetarian"])
  })

  it("extracts deps transitively through BindingRefNode", () => {
    // const nameMatch = recipe.name.toLowerCase().includes(filterText.toLowerCase())
    // const veggieMatch = !veggieOnly || recipe.vegetarian
    // condition: nameMatch && veggieMatch
    const nameMatchExpr = methodCall(
      methodCall(
        refRead(propertyAccess(identifier("recipe"), "name"), "text"),
        "toLowerCase",
        [],
      ),
      "includes",
      [
        methodCall(
          refRead(identifier("filterText"), "replace"),
          "toLowerCase",
          [],
        ),
      ],
    )

    const veggieMatchExpr = binary(
      unary("!", refRead(identifier("veggieOnly"), "replace")),
      "||",
      refRead(propertyAccess(identifier("recipe"), "vegetarian"), "replace"),
    )

    const conditionExpr = binary(
      bindingRef("nameMatch", nameMatchExpr),
      "&&",
      bindingRef("veggieMatch", veggieMatchExpr),
    )

    const deps = extractDeps(conditionExpr)
    expect(deps).toHaveLength(4)
    const sources = deps.map(d => d.source).sort()
    expect(sources).toEqual([
      "filterText",
      "recipe.name",
      "recipe.vegetarian",
      "veggieOnly",
    ])
  })

  // ---------------------------------------------------------------------------
  // Deduplication
  // ---------------------------------------------------------------------------

  it("deduplicates identical dependencies", () => {
    // recipe.name appears twice in the expression
    const expr = binary(
      refRead(propertyAccess(identifier("recipe"), "name"), "text"),
      "+",
      refRead(propertyAccess(identifier("recipe"), "name"), "text"),
    )
    const deps = extractDeps(expr)
    expect(deps).toHaveLength(1)
    expect(deps[0].source).toBe("recipe.name")
  })

  // ---------------------------------------------------------------------------
  // Dependency subsumption
  // ---------------------------------------------------------------------------

  it("child dep subsumes parent dep (doc.title subsumes doc)", () => {
    // An expression referencing both `doc` and `doc.title`
    const expr = binary(
      refRead(identifier("doc"), "map"),
      "+",
      refRead(propertyAccess(identifier("doc"), "title"), "text"),
    )
    const deps = extractDeps(expr)
    expect(deps).toHaveLength(1)
    expect(deps[0]).toEqual({ source: "doc.title", deltaKind: "text" })
  })

  it("subsumption respects dot boundaries (d is NOT subsumed by doc)", () => {
    const expr = binary(
      refRead(identifier("d"), "replace"),
      "+",
      refRead(identifier("doc"), "map"),
    )
    const deps = extractDeps(expr)
    expect(deps).toHaveLength(2)
    const sources = deps.map(d => d.source).sort()
    expect(sources).toEqual(["d", "doc"])
  })

  it("deeper child subsumes shallower parent (a.b.c subsumes a.b and a)", () => {
    const expr = binary(
      binary(
        refRead(identifier("a"), "map"),
        "+",
        refRead(propertyAccess(identifier("a"), "b"), "sequence"),
      ),
      "+",
      refRead(
        propertyAccess(propertyAccess(identifier("a"), "b"), "c"),
        "text",
      ),
    )
    const deps = extractDeps(expr)
    expect(deps).toHaveLength(1)
    expect(deps[0]).toEqual({ source: "a.b.c", deltaKind: "text" })
  })

  it("sibling deps are not subsumed (a.x and a.y both survive)", () => {
    const expr = binary(
      refRead(propertyAccess(identifier("a"), "x"), "text"),
      "+",
      refRead(propertyAccess(identifier("a"), "y"), "replace"),
    )
    const deps = extractDeps(expr)
    expect(deps).toHaveLength(2)
    const sources = deps.map(d => d.source).sort()
    expect(sources).toEqual(["a.x", "a.y"])
  })

  // ---------------------------------------------------------------------------
  // Leaf nodes (no deps)
  // ---------------------------------------------------------------------------

  it("returns empty for a literal", () => {
    expect(extractDeps(literal("42"))).toEqual([])
  })

  it("returns empty for an identifier (non-reactive)", () => {
    expect(extractDeps(identifier("x"))).toEqual([])
  })

  it("returns empty for a raw node", () => {
    expect(extractDeps(raw("some.thing"))).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // Template deps
  // ---------------------------------------------------------------------------

  it("extracts deps from template expression holes", () => {
    // `${doc.title} items: ${doc.count}`
    const expr = template([
      literal(""),
      refRead(propertyAccess(identifier("doc"), "title"), "text"),
      literal(" items: "),
      refRead(propertyAccess(identifier("doc"), "count"), "increment"),
      literal(""),
    ])
    const deps = extractDeps(expr)
    expect(deps).toHaveLength(2)
    const sources = deps.map(d => d.source).sort()
    expect(sources).toEqual(["doc.count", "doc.title"])
  })

  // ---------------------------------------------------------------------------
  // Call node deps
  // ---------------------------------------------------------------------------

  it("extracts deps from call arguments", () => {
    const expr = call(identifier("someFunction"), [
      refRead(identifier("x"), "replace"),
    ])
    const deps = extractDeps(expr)
    expect(deps).toEqual([{ source: "x", deltaKind: "replace" }])
  })

  // ---------------------------------------------------------------------------
  // Unary deps
  // ---------------------------------------------------------------------------

  it("extracts deps from unary operand", () => {
    // !veggieOnly
    const expr = unary("!", refRead(identifier("veggieOnly"), "replace"))
    const deps = extractDeps(expr)
    expect(deps).toEqual([{ source: "veggieOnly", deltaKind: "replace" }])
  })

  // ---------------------------------------------------------------------------
  // Snapshot args deps
  // ---------------------------------------------------------------------------

  it("extracts deps from snapshot arguments", () => {
    const expr = snapshot(
      identifier("someRef"),
      [refRead(identifier("otherRef"), "replace")],
      "replace",
    )
    const deps = extractDeps(expr)
    expect(deps).toHaveLength(2)
    const sources = deps.map(d => d.source).sort()
    expect(sources).toEqual(["otherRef", "someRef"])
  })

  // ---------------------------------------------------------------------------
  // Does not recurse into RefRead's ref subtree
  // ---------------------------------------------------------------------------

  it("does not extract sub-deps from a RefRead ref subtree", () => {
    // RefRead(PropertyAccess(Identifier("recipe"), "name")) should NOT
    // produce a dep for "recipe" — only for "recipe.name"
    const expr = refRead(
      propertyAccess(identifier("recipe"), "name"),
      "text",
    )
    const deps = extractDeps(expr)
    expect(deps).toHaveLength(1)
    expect(deps[0].source).toBe("recipe.name")
  })
})

// =============================================================================
// isReactive Tests
// =============================================================================

describe("isReactive", () => {
  // ---------------------------------------------------------------------------
  // Reactive nodes
  // ---------------------------------------------------------------------------

  it("RefReadNode is reactive", () => {
    expect(isReactive(refRead(identifier("x"), "replace"))).toBe(true)
  })

  it("SnapshotNode is reactive", () => {
    expect(isReactive(snapshot(identifier("x"), [], "replace"))).toBe(true)
  })

  it("BindingRefNode is reactive", () => {
    expect(isReactive(bindingRef("x", literal("1")))).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Non-reactive leaf nodes
  // ---------------------------------------------------------------------------

  it("LiteralNode is not reactive", () => {
    expect(isReactive(literal("42"))).toBe(false)
  })

  it("IdentifierNode is not reactive", () => {
    expect(isReactive(identifier("x"))).toBe(false)
  })

  it("RawNode is not reactive", () => {
    expect(isReactive(raw("something"))).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Composite nodes — reactivity propagates
  // ---------------------------------------------------------------------------

  it("MethodCall with reactive receiver is reactive", () => {
    const expr = methodCall(
      refRead(identifier("x"), "replace"),
      "toString",
      [],
    )
    expect(isReactive(expr)).toBe(true)
  })

  it("MethodCall with reactive argument is reactive", () => {
    const expr = methodCall(
      identifier("str"),
      "includes",
      [refRead(identifier("x"), "replace")],
    )
    expect(isReactive(expr)).toBe(true)
  })

  it("MethodCall with no reactive parts is not reactive", () => {
    const expr = methodCall(identifier("str"), "toLowerCase", [])
    expect(isReactive(expr)).toBe(false)
  })

  it("PropertyAccess with reactive object is reactive", () => {
    const expr = propertyAccess(
      refRead(identifier("x"), "replace"),
      "length",
    )
    expect(isReactive(expr)).toBe(true)
  })

  it("PropertyAccess with non-reactive object is not reactive", () => {
    const expr = propertyAccess(identifier("x"), "length")
    expect(isReactive(expr)).toBe(false)
  })

  it("Call with reactive callee is reactive", () => {
    const expr = call(refRead(identifier("x"), "replace"), [])
    expect(isReactive(expr)).toBe(true)
  })

  it("Call with reactive argument is reactive", () => {
    const expr = call(identifier("f"), [refRead(identifier("x"), "replace")])
    expect(isReactive(expr)).toBe(true)
  })

  it("Call with no reactive parts is not reactive", () => {
    const expr = call(identifier("f"), [literal("1")])
    expect(isReactive(expr)).toBe(false)
  })

  it("Binary with reactive left is reactive", () => {
    const expr = binary(
      refRead(identifier("x"), "replace"),
      ">",
      literal("0"),
    )
    expect(isReactive(expr)).toBe(true)
  })

  it("Binary with reactive right is reactive", () => {
    const expr = binary(
      literal("0"),
      "<",
      refRead(identifier("x"), "replace"),
    )
    expect(isReactive(expr)).toBe(true)
  })

  it("Binary with no reactive parts is not reactive", () => {
    const expr = binary(literal("1"), "+", literal("2"))
    expect(isReactive(expr)).toBe(false)
  })

  it("Unary with reactive operand is reactive", () => {
    const expr = unary("!", refRead(identifier("x"), "replace"))
    expect(isReactive(expr)).toBe(true)
  })

  it("Unary with non-reactive operand is not reactive", () => {
    const expr = unary("-", literal("1"))
    expect(isReactive(expr)).toBe(false)
  })

  it("Template with reactive hole is reactive", () => {
    const expr = template([
      literal("Count: "),
      refRead(identifier("count"), "increment"),
      literal(""),
    ])
    expect(isReactive(expr)).toBe(true)
  })

  it("Template with no reactive holes is not reactive", () => {
    const expr = template([
      literal("Hello "),
      identifier("name"),
      literal("!"),
    ])
    expect(isReactive(expr)).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Deep nesting
  // ---------------------------------------------------------------------------

  it("deeply nested reactive node is detected", () => {
    // method(method(method(refRead(x))))
    const expr = methodCall(
      methodCall(
        methodCall(
          refRead(identifier("x"), "text"),
          "toLowerCase",
          [],
        ),
        "trim",
        [],
      ),
      "slice",
      [literal("0"), literal("10")],
    )
    expect(isReactive(expr)).toBe(true)
  })

  it("deeply nested non-reactive tree is not reactive", () => {
    const expr = methodCall(
      methodCall(
        methodCall(
          identifier("str"),
          "toLowerCase",
          [],
        ),
        "trim",
        [],
      ),
      "slice",
      [literal("0"), literal("10")],
    )
    expect(isReactive(expr)).toBe(false)
  })
})

// =============================================================================
// renderRefSource Tests
// =============================================================================

describe("renderRefSource", () => {
  it("renders an identifier", () => {
    expect(renderRefSource(identifier("filterText"))).toBe("filterText")
  })

  it("renders a property access chain", () => {
    const expr = propertyAccess(identifier("recipe"), "name")
    expect(renderRefSource(expr)).toBe("recipe.name")
  })

  it("renders a deep property access chain", () => {
    const expr = propertyAccess(
      propertyAccess(identifier("doc"), "recipes"),
      "length",
    )
    expect(renderRefSource(expr)).toBe("doc.recipes.length")
  })

  it("renders a raw node's source", () => {
    expect(renderRefSource(raw("complex[0]"))).toBe("complex[0]")
  })

  it("renders a literal's value", () => {
    expect(renderRefSource(literal("42"))).toBe("42")
  })

  it("renders a binding ref as its name", () => {
    expect(renderRefSource(bindingRef("x", literal("1")))).toBe("x")
  })

  it("renders a ref-read by stripping the read (returning inner ref source)", () => {
    const expr = refRead(propertyAccess(identifier("doc"), "title"), "text")
    expect(renderRefSource(expr)).toBe("doc.title")
  })

  it("renders a snapshot as ref()", () => {
    const expr = snapshot(propertyAccess(identifier("recipe"), "name"), [], "text")
    expect(renderRefSource(expr)).toBe("recipe.name()")
  })
})

// =============================================================================
// Compound Expression Tree Tests (recipe-book filter pattern)
// =============================================================================

describe("Recipe-book filter pattern tree", () => {
  /**
   * Build the full expression tree for the recipe-book filter condition:
   *
   *   const nameMatch = recipe.name.toLowerCase().includes(filterText.toLowerCase())
   *   const veggieMatch = !veggieOnly || recipe.vegetarian
   *   if (nameMatch && veggieMatch) { ... }
   *
   * In ExpressionIR:
   *   Binary(
   *     BindingRef("nameMatch",
   *       MethodCall(
   *         MethodCall(RefRead(recipe.name, "text"), "toLowerCase", []),
   *         "includes",
   *         [MethodCall(RefRead(filterText, "replace"), "toLowerCase", [])]
   *       )
   *     ),
   *     "&&",
   *     BindingRef("veggieMatch",
   *       Binary(
   *         Unary("!", RefRead(veggieOnly, "replace")),
   *         "||",
   *         RefRead(recipe.vegetarian, "replace")
   *       )
   *     )
   *   )
   */
  function buildFilterCondition(): ExpressionIR {
    const nameMatchExpr = methodCall(
      methodCall(
        refRead(propertyAccess(identifier("recipe"), "name"), "text"),
        "toLowerCase",
        [],
      ),
      "includes",
      [
        methodCall(
          refRead(identifier("filterText"), "replace"),
          "toLowerCase",
          [],
        ),
      ],
    )

    const veggieMatchExpr = binary(
      unary("!", refRead(identifier("veggieOnly"), "replace")),
      "||",
      refRead(propertyAccess(identifier("recipe"), "vegetarian"), "replace"),
    )

    return binary(
      bindingRef("nameMatch", nameMatchExpr),
      "&&",
      bindingRef("veggieMatch", veggieMatchExpr),
    )
  }

  it("is reactive", () => {
    expect(isReactive(buildFilterCondition())).toBe(true)
  })

  it("extracts all 4 transitive dependencies", () => {
    const deps = extractDeps(buildFilterCondition())
    expect(deps).toHaveLength(4)
    const sources = deps.map(d => d.source).sort()
    expect(sources).toEqual([
      "filterText",
      "recipe.name",
      "recipe.vegetarian",
      "veggieOnly",
    ])
  })

  it("preserves correct delta kinds", () => {
    const deps = extractDeps(buildFilterCondition())
    const bySource = new Map(deps.map(d => [d.source, d.deltaKind]))
    expect(bySource.get("recipe.name")).toBe("text")
    expect(bySource.get("filterText")).toBe("replace")
    expect(bySource.get("veggieOnly")).toBe("replace")
    expect(bySource.get("recipe.vegetarian")).toBe("replace")
  })

  it("tree structure has correct root", () => {
    const tree = buildFilterCondition()
    expect(tree.kind).toBe("binary")
    if (tree.kind === "binary") {
      expect(tree.op).toBe("&&")
      expect(tree.left.kind).toBe("binding-ref")
      expect(tree.right.kind).toBe("binding-ref")
    }
  })

  it("nameMatch binding has correct structure", () => {
    const tree = buildFilterCondition()
    if (tree.kind !== "binary") throw new Error("expected binary")
    const left = tree.left
    if (left.kind !== "binding-ref") throw new Error("expected binding-ref")
    expect(left.name).toBe("nameMatch")
    expect(left.expression.kind).toBe("method-call")
    if (left.expression.kind === "method-call") {
      expect(left.expression.method).toBe("includes")
    }
  })

  it("veggieMatch binding has correct structure", () => {
    const tree = buildFilterCondition()
    if (tree.kind !== "binary") throw new Error("expected binary")
    const right = tree.right
    if (right.kind !== "binding-ref") throw new Error("expected binding-ref")
    expect(right.name).toBe("veggieMatch")
    expect(right.expression.kind).toBe("binary")
    if (right.expression.kind === "binary") {
      expect(right.expression.op).toBe("||")
      expect(right.expression.left.kind).toBe("unary")
    }
  })
})

// =============================================================================
// Edge Cases
// =============================================================================

describe("Edge cases", () => {
  it("extractDeps on empty template returns empty", () => {
    // A template with no holes: `hello`
    const expr = template([literal("hello")])
    expect(extractDeps(expr)).toEqual([])
  })

  it("isReactive on empty template is not reactive", () => {
    const expr = template([literal("hello")])
    expect(isReactive(expr)).toBe(false)
  })

  it("extractDeps handles mixed snapshot and refRead for same source", () => {
    // Both a snapshot and a refRead for recipe.name — deduplication keeps first
    const expr = binary(
      snapshot(propertyAccess(identifier("recipe"), "name"), [], "text"),
      "+",
      refRead(propertyAccess(identifier("recipe"), "name"), "text"),
    )
    const deps = extractDeps(expr)
    expect(deps).toHaveLength(1)
    expect(deps[0].source).toBe("recipe.name")
  })

  it("extractDeps handles binding ref whose expression has no deps", () => {
    // A binding ref wrapping a non-reactive expression
    const expr = bindingRef("staticVal", literal("42"))
    const deps = extractDeps(expr)
    expect(deps).toEqual([])
  })

  it("isReactive returns true for binding ref even with non-reactive expression", () => {
    // BindingRefNode is always reactive (it references a binding that
    // was classified as reactive by the analysis pipeline)
    const expr = bindingRef("staticVal", literal("42"))
    expect(isReactive(expr)).toBe(true)
  })
})

// =============================================================================
// renderExpression Tests
// =============================================================================

describe("renderExpression", () => {
  const noExpand: RenderContext = { expandBindings: false }
  const expand: RenderContext = { expandBindings: true }

  // ---------------------------------------------------------------------------
  // Leaf nodes
  // ---------------------------------------------------------------------------

  it("renders a literal", () => {
    expect(renderExpression(literal("42"), noExpand)).toBe("42")
  })

  it("renders an identifier", () => {
    expect(renderExpression(identifier("foo"), noExpand)).toBe("foo")
  })

  it("renders a raw node verbatim", () => {
    expect(renderExpression(raw("some.complex[0]"), noExpand)).toBe("some.complex[0]")
  })

  // ---------------------------------------------------------------------------
  // RefReadNode — auto-read insertion (the observation morphism)
  // ---------------------------------------------------------------------------

  it("RefRead on identifier inserts ()", () => {
    const expr = refRead(identifier("filterText"), "replace")
    expect(renderExpression(expr, noExpand)).toBe("filterText()")
  })

  it("RefRead on property access inserts ()", () => {
    const expr = refRead(
      propertyAccess(identifier("recipe"), "name"),
      "text",
    )
    expect(renderExpression(expr, noExpand)).toBe("recipe.name()")
  })

  it("RefRead on nested property access inserts ()", () => {
    const expr = refRead(
      propertyAccess(
        propertyAccess(identifier("doc"), "meta"),
        "title",
      ),
      "text",
    )
    expect(renderExpression(expr, noExpand)).toBe("doc.meta.title()")
  })

  // ---------------------------------------------------------------------------
  // SnapshotNode — explicit ref() call
  // ---------------------------------------------------------------------------

  it("Snapshot with no args renders as ref()", () => {
    const expr = snapshot(
      propertyAccess(identifier("recipe"), "name"),
      [],
      "text",
    )
    expect(renderExpression(expr, noExpand)).toBe("recipe.name()")
  })

  it("Snapshot with args renders as ref(args)", () => {
    const expr = snapshot(
      identifier("someRef"),
      [literal("42"), identifier("x")],
      "replace",
    )
    expect(renderExpression(expr, noExpand)).toBe("someRef(42, x)")
  })

  // ---------------------------------------------------------------------------
  // MethodCallNode
  // ---------------------------------------------------------------------------

  it("renders method call with no args", () => {
    const expr = methodCall(identifier("str"), "toLowerCase", [])
    expect(renderExpression(expr, noExpand)).toBe("str.toLowerCase()")
  })

  it("renders method call with args", () => {
    const expr = methodCall(
      identifier("str"),
      "includes",
      [literal("\"x\"")],
    )
    expect(renderExpression(expr, noExpand)).toBe("str.includes(\"x\")")
  })

  it("renders chained method calls", () => {
    const expr = methodCall(
      methodCall(identifier("str"), "toLowerCase", []),
      "trim",
      [],
    )
    expect(renderExpression(expr, noExpand)).toBe("str.toLowerCase().trim()")
  })

  // ---------------------------------------------------------------------------
  // PropertyAccessNode
  // ---------------------------------------------------------------------------

  it("renders property access", () => {
    const expr = propertyAccess(identifier("obj"), "prop")
    expect(renderExpression(expr, noExpand)).toBe("obj.prop")
  })

  it("renders chained property access", () => {
    const expr = propertyAccess(
      propertyAccess(identifier("a"), "b"),
      "c",
    )
    expect(renderExpression(expr, noExpand)).toBe("a.b.c")
  })

  // ---------------------------------------------------------------------------
  // CallNode
  // ---------------------------------------------------------------------------

  it("renders function call with no args", () => {
    const expr = call(identifier("fn"), [])
    expect(renderExpression(expr, noExpand)).toBe("fn()")
  })

  it("renders function call with args", () => {
    const expr = call(identifier("fn"), [literal("1"), identifier("x")])
    expect(renderExpression(expr, noExpand)).toBe("fn(1, x)")
  })

  // ---------------------------------------------------------------------------
  // BinaryNode
  // ---------------------------------------------------------------------------

  it("renders binary expression", () => {
    const expr = binary(identifier("a"), "+", identifier("b"))
    expect(renderExpression(expr, noExpand)).toBe("a + b")
  })

  it("renders nested binary expressions", () => {
    const expr = binary(
      binary(identifier("a"), "+", identifier("b")),
      "*",
      identifier("c"),
    )
    expect(renderExpression(expr, noExpand)).toBe("a + b * c")
  })

  it("renders comparison operators", () => {
    const expr = binary(identifier("x"), ">=", literal("0"))
    expect(renderExpression(expr, noExpand)).toBe("x >= 0")
  })

  it("renders logical operators", () => {
    const expr = binary(identifier("a"), "&&", identifier("b"))
    expect(renderExpression(expr, noExpand)).toBe("a && b")
  })

  // ---------------------------------------------------------------------------
  // UnaryNode
  // ---------------------------------------------------------------------------

  it("renders prefix unary (symbol op)", () => {
    const expr = unary("!", identifier("x"))
    expect(renderExpression(expr, noExpand)).toBe("!x")
  })

  it("renders prefix unary (negation)", () => {
    const expr = unary("-", identifier("x"))
    expect(renderExpression(expr, noExpand)).toBe("-x")
  })

  it("renders prefix unary (word op with space)", () => {
    const expr = unary("typeof", identifier("x"))
    expect(renderExpression(expr, noExpand)).toBe("typeof x")
  })

  it("renders postfix unary", () => {
    const expr = unary("++", identifier("i"), false)
    expect(renderExpression(expr, noExpand)).toBe("i++")
  })

  // ---------------------------------------------------------------------------
  // TemplateNode
  // ---------------------------------------------------------------------------

  it("renders a simple template literal", () => {
    const expr = template([literal("hello")])
    expect(renderExpression(expr, noExpand)).toBe("`hello`")
  })

  it("renders a template literal with expression hole", () => {
    // `Hello ${name}!`
    const expr = template([
      literal("Hello "),
      identifier("name"),
      literal("!"),
    ])
    expect(renderExpression(expr, noExpand)).toBe("`Hello ${name}!`")
  })

  it("renders a template literal with multiple holes", () => {
    // `${a} + ${b} = ${c}`
    const expr = template([
      literal(""),
      identifier("a"),
      literal(" + "),
      identifier("b"),
      literal(" = "),
      identifier("c"),
      literal(""),
    ])
    expect(renderExpression(expr, noExpand)).toBe("`${a} + ${b} = ${c}`")
  })

  it("renders a template literal with reactive holes", () => {
    // `Count: ${count()}`
    const expr = template([
      literal("Count: "),
      refRead(identifier("count"), "increment"),
      literal(""),
    ])
    expect(renderExpression(expr, noExpand)).toBe("`Count: ${count()}`")
  })

  // ---------------------------------------------------------------------------
  // BindingRefNode — expandBindings: false
  // ---------------------------------------------------------------------------

  it("BindingRef with expandBindings: false renders as name", () => {
    const inner = refRead(identifier("filterText"), "replace")
    const expr = bindingRef("nameMatch", inner)
    expect(renderExpression(expr, noExpand)).toBe("nameMatch")
  })

  // ---------------------------------------------------------------------------
  // BindingRefNode — expandBindings: true
  // ---------------------------------------------------------------------------

  it("BindingRef with expandBindings: true renders the expression tree", () => {
    const inner = refRead(identifier("filterText"), "replace")
    const expr = bindingRef("nameMatch", inner)
    expect(renderExpression(expr, expand)).toBe("filterText()")
  })

  it("BindingRef expansion renders nested reactive expression", () => {
    // nameMatch = recipe.name().toLowerCase().includes(filterText().toLowerCase())
    const inner = methodCall(
      methodCall(
        refRead(propertyAccess(identifier("recipe"), "name"), "text"),
        "toLowerCase",
        [],
      ),
      "includes",
      [
        methodCall(
          refRead(identifier("filterText"), "replace"),
          "toLowerCase",
          [],
        ),
      ],
    )
    const expr = bindingRef("nameMatch", inner)
    expect(renderExpression(expr, expand)).toBe(
      "recipe.name().toLowerCase().includes(filterText().toLowerCase())",
    )
  })

  // ---------------------------------------------------------------------------
  // Compound: recipe-book filter pattern
  // ---------------------------------------------------------------------------

  it("renders full filter condition with expandBindings: false", () => {
    const nameMatchExpr = methodCall(
      methodCall(
        refRead(propertyAccess(identifier("recipe"), "name"), "text"),
        "toLowerCase",
        [],
      ),
      "includes",
      [
        methodCall(
          refRead(identifier("filterText"), "replace"),
          "toLowerCase",
          [],
        ),
      ],
    )

    const veggieMatchExpr = binary(
      unary("!", refRead(identifier("veggieOnly"), "replace")),
      "||",
      refRead(propertyAccess(identifier("recipe"), "vegetarian"), "replace"),
    )

    const condition = binary(
      bindingRef("nameMatch", nameMatchExpr),
      "&&",
      bindingRef("veggieMatch", veggieMatchExpr),
    )

    expect(renderExpression(condition, noExpand)).toBe(
      "nameMatch && veggieMatch",
    )
  })

  it("renders full filter condition with expandBindings: true", () => {
    const nameMatchExpr = methodCall(
      methodCall(
        refRead(propertyAccess(identifier("recipe"), "name"), "text"),
        "toLowerCase",
        [],
      ),
      "includes",
      [
        methodCall(
          refRead(identifier("filterText"), "replace"),
          "toLowerCase",
          [],
        ),
      ],
    )

    const veggieMatchExpr = binary(
      unary("!", refRead(identifier("veggieOnly"), "replace")),
      "||",
      refRead(propertyAccess(identifier("recipe"), "vegetarian"), "replace"),
    )

    const condition = binary(
      bindingRef("nameMatch", nameMatchExpr),
      "&&",
      bindingRef("veggieMatch", veggieMatchExpr),
    )

    expect(renderExpression(condition, expand)).toBe(
      "recipe.name().toLowerCase().includes(filterText().toLowerCase()) && !veggieOnly() || recipe.vegetarian()",
    )
  })

  // ---------------------------------------------------------------------------
  // RefRead + method chain (the core auto-read insertion pattern)
  // ---------------------------------------------------------------------------

  it("renders recipe.name.toLowerCase() with auto-read insertion", () => {
    // Developer writes: recipe.name.toLowerCase()
    // ExpressionIR: MethodCall(RefRead(PropertyAccess(recipe, name)), "toLowerCase", [])
    // Output: recipe.name().toLowerCase()
    const expr = methodCall(
      refRead(propertyAccess(identifier("recipe"), "name"), "text"),
      "toLowerCase",
      [],
    )
    expect(renderExpression(expr, noExpand)).toBe("recipe.name().toLowerCase()")
  })

  it("renders compound filter expression with auto-read insertion", () => {
    // recipe.name.toLowerCase().includes(filterText.toLowerCase())
    // → recipe.name().toLowerCase().includes(filterText().toLowerCase())
    const expr = methodCall(
      methodCall(
        refRead(propertyAccess(identifier("recipe"), "name"), "text"),
        "toLowerCase",
        [],
      ),
      "includes",
      [
        methodCall(
          refRead(identifier("filterText"), "replace"),
          "toLowerCase",
          [],
        ),
      ],
    )
    expect(renderExpression(expr, noExpand)).toBe(
      "recipe.name().toLowerCase().includes(filterText().toLowerCase())",
    )
  })

  it("renders !veggieOnly with auto-read insertion", () => {
    // !veggieOnly → !veggieOnly()
    const expr = unary("!", refRead(identifier("veggieOnly"), "replace"))
    expect(renderExpression(expr, noExpand)).toBe("!veggieOnly()")
  })

  it("renders !veggieOnly || recipe.vegetarian with auto-read insertion", () => {
    const expr = binary(
      unary("!", refRead(identifier("veggieOnly"), "replace")),
      "||",
      refRead(propertyAccess(identifier("recipe"), "vegetarian"), "replace"),
    )
    expect(renderExpression(expr, noExpand)).toBe(
      "!veggieOnly() || recipe.vegetarian()",
    )
  })
})