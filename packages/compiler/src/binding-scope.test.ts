/**
 * Unit tests for BindingScope — lexical scope for tracking analyzed variable bindings.
 *
 * Tests verify:
 * - Basic bind and lookup
 * - Lookup miss returns undefined
 * - Parent chain traversal
 * - Shadowing (child overrides parent)
 * - Isolation (child bindings not visible in parent)
 * - Deep nesting (grandchild resolves through two levels)
 */

import { describe, expect, it } from "vitest"
import { createBindingScope } from "./binding-scope.js"
import { createContent, createSpan } from "./ir.js"

function span() {
  return createSpan(1, 0, 1, 10)
}

/** Helper to create a reactive ContentNode with given source */
function reactive(source: string) {
  return createContent(source, "reactive", [{ source, deltaKind: "replace" }], span())
}

/** Helper to create a render-time ContentNode with given source */
function render(source: string) {
  return createContent(source, "render", [], span())
}

describe("BindingScope", () => {
  it("basic bind and lookup", () => {
    const scope = createBindingScope()
    const node = reactive("x.get()")
    scope.bind("x", node)

    const result = scope.lookup("x")
    expect(result).toBe(node)
    expect(result?.source).toBe("x.get()")
    expect(result?.bindingTime).toBe("reactive")
  })

  it("lookup miss returns undefined", () => {
    const scope = createBindingScope()
    expect(scope.lookup("unknown")).toBeUndefined()
  })

  it("parent chain — child scope looks up bindings from parent", () => {
    const parent = createBindingScope()
    const node = reactive("count.get()")
    parent.bind("count", node)

    const child = parent.child()
    const result = child.lookup("count")
    expect(result).toBe(node)
    expect(result?.source).toBe("count.get()")
  })

  it("shadowing — child scope binding shadows parent binding with same name", () => {
    const parent = createBindingScope()
    const parentNode = reactive("outer.get()")
    parent.bind("x", parentNode)

    const child = parent.child()
    const childNode = render("42")
    child.bind("x", childNode)

    // Child sees the shadow
    expect(child.lookup("x")).toBe(childNode)
    expect(child.lookup("x")?.source).toBe("42")

    // Parent still sees the original
    expect(parent.lookup("x")).toBe(parentNode)
    expect(parent.lookup("x")?.source).toBe("outer.get()")
  })

  it("isolation — binding in child scope is not visible in parent", () => {
    const parent = createBindingScope()
    const child = parent.child()

    const node = reactive("inner.get()")
    child.bind("inner", node)

    expect(child.lookup("inner")).toBe(node)
    expect(parent.lookup("inner")).toBeUndefined()
  })

  it("deep nesting — grandchild scope resolves through two levels of parent chain", () => {
    const root = createBindingScope()
    const rootNode = reactive("a.get()")
    root.bind("a", rootNode)

    const child = root.child()
    const childNode = reactive("b.get()")
    child.bind("b", childNode)

    const grandchild = child.child()
    const grandchildNode = reactive("c.get()")
    grandchild.bind("c", grandchildNode)

    // Grandchild sees all three
    expect(grandchild.lookup("a")).toBe(rootNode)
    expect(grandchild.lookup("b")).toBe(childNode)
    expect(grandchild.lookup("c")).toBe(grandchildNode)

    // Child sees root and own, but not grandchild
    expect(child.lookup("a")).toBe(rootNode)
    expect(child.lookup("b")).toBe(childNode)
    expect(child.lookup("c")).toBeUndefined()

    // Root sees only own
    expect(root.lookup("a")).toBe(rootNode)
    expect(root.lookup("b")).toBeUndefined()
    expect(root.lookup("c")).toBeUndefined()
  })
})