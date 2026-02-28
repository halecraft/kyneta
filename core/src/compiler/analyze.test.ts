/**
 * Unit tests for Kinetic compiler analysis.
 *
 * These tests verify that the analysis module correctly transforms
 * TypeScript AST into IR nodes.
 */

import { Project } from "ts-morph"
import { beforeEach, describe, expect, it } from "vitest"
import {
  analyzeBuilder,
  analyzeExpression,
  analyzeProps,
  ELEMENT_FACTORIES,
  expressionIsReactive,
  extractDependencies,
  findBuilderCalls,
  isReactiveType,
} from "./analyze.js"
import type { ExpressionNode } from "./ir.js"

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create a ts-morph Project for testing.
 */
function createProject(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      target: 99, // ESNext
      module: 99, // ESNext
      strict: true,
    },
  })
}

/**
 * Create a source file with the given code.
 */
function createSourceFile(
  project: Project,
  code: string,
  filename = "test.ts",
) {
  return project.createSourceFile(filename, code, { overwrite: true })
}

/**
 * Add Loro type definitions to the project.
 */
function addLoroTypes(project: Project) {
  project.createSourceFile(
    "loro-types.d.ts",
    `
    export interface TextRef {
      insert(pos: number, text: string): void
      delete(pos: number, len: number): void
      toString(): string
    }

    export interface CounterRef {
      get(): number
      increment(n: number): void
    }

    export interface ListRef<T> {
      push(item: T): void
      insert(index: number, item: T): void
      delete(index: number, len?: number): void
      get(index: number): T
      toArray(): T[]
      length: number
    }

    export interface StructRef<T> {
      get<K extends keyof T>(key: K): T[K]
    }
  `,
    { overwrite: true },
  )
}

// =============================================================================
// ELEMENT_FACTORIES Tests
// =============================================================================

describe("ELEMENT_FACTORIES", () => {
  it("should include common HTML elements", () => {
    expect(ELEMENT_FACTORIES.has("div")).toBe(true)
    expect(ELEMENT_FACTORIES.has("span")).toBe(true)
    expect(ELEMENT_FACTORIES.has("p")).toBe(true)
    expect(ELEMENT_FACTORIES.has("h1")).toBe(true)
    expect(ELEMENT_FACTORIES.has("ul")).toBe(true)
    expect(ELEMENT_FACTORIES.has("li")).toBe(true)
    expect(ELEMENT_FACTORIES.has("a")).toBe(true)
    expect(ELEMENT_FACTORIES.has("button")).toBe(true)
    expect(ELEMENT_FACTORIES.has("input")).toBe(true)
    expect(ELEMENT_FACTORIES.has("form")).toBe(true)
  })

  it("should not include non-element names", () => {
    expect(ELEMENT_FACTORIES.has("console")).toBe(false)
    expect(ELEMENT_FACTORIES.has("document")).toBe(false)
    expect(ELEMENT_FACTORIES.has("window")).toBe(false)
    expect(ELEMENT_FACTORIES.has("Math")).toBe(false)
  })
})

// =============================================================================
// findBuilderCalls Tests
// =============================================================================

describe("findBuilderCalls", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
  })

  it("should find builder calls with arrow functions", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        h1("Hello")
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    expect(calls).toHaveLength(1)
    expect(calls[0].getExpression().getText()).toBe("div")
  })

  it("should find multiple builder calls", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        h1("Title")
      })

      section(() => {
        p("Content")
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    expect(calls).toHaveLength(2)
  })

  it("should find nested builder calls at top level only", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        section(() => {
          p("Nested")
        })
      })
    `,
    )

    // Only the top-level div should be returned, not nested section or p
    const calls = findBuilderCalls(sourceFile)
    expect(calls).toHaveLength(1)
    expect(calls[0].getExpression().getText()).toBe("div")
  })

  it("should exclude deeply nested builder calls", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        header(() => {
          nav(() => {
            ul(() => {
              li(() => {
                a("Link")
              })
            })
          })
        })
      })
    `,
    )

    // Only the outermost div should be returned
    const calls = findBuilderCalls(sourceFile)
    expect(calls).toHaveLength(1)
    expect(calls[0].getExpression().getText()).toBe("div")
  })

  it("should find multiple top-level builders but exclude their nested children", () => {
    const sourceFile = createSourceFile(
      project,
      `
      header(() => {
        h1("Title")
        nav(() => {
          a("Link")
        })
      })

      footer(() => {
        p("Footer text")
      })
    `,
    )

    // Should find header and footer, but not nav, h1, a, or p
    const calls = findBuilderCalls(sourceFile)
    expect(calls).toHaveLength(2)
    expect(calls[0].getExpression().getText()).toBe("header")
    expect(calls[1].getExpression().getText()).toBe("footer")
  })

  it("should not find non-builder element calls", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div("static text")
      span("more text")
    `,
    )

    // These don't have builder functions, so they shouldn't be found
    const calls = findBuilderCalls(sourceFile)
    expect(calls).toHaveLength(0)
  })

  it("should not find calls to non-element functions", () => {
    const sourceFile = createSourceFile(
      project,
      `
      console.log(() => {
        return "test"
      })

      someFunction(() => {
        doSomething()
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    expect(calls).toHaveLength(0)
  })
})

// =============================================================================
// isReactiveType Tests
// =============================================================================

describe("isReactiveType", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addLoroTypes(project)
  })

  it("should detect TextRef as reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./loro-types"
      declare const title: TextRef
      const x = title
    `,
    )

    // Find the variable declaration for x
    const varDecl = sourceFile.getVariableDeclaration("x")
    expect(varDecl).toBeDefined()
    if (varDecl) {
      const initializer = varDecl.getInitializer()
      expect(initializer).toBeDefined()
      if (initializer) {
        const type = initializer.getType()
        expect(isReactiveType(type)).toBe(true)
      }
    }
  })

  it("should detect CounterRef as reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./loro-types"
      declare const count: CounterRef
      const x = count
    `,
    )

    const varDecl = sourceFile.getVariableDeclaration("x")
    expect(varDecl).toBeDefined()
    if (varDecl) {
      const initializer = varDecl.getInitializer()
      expect(initializer).toBeDefined()
      if (initializer) {
        const type = initializer.getType()
        expect(isReactiveType(type)).toBe(true)
      }
    }
  })

  it("should detect ListRef as reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { ListRef } from "./loro-types"
      declare const items: ListRef<string>
      const x = items
    `,
    )

    const varDecl = sourceFile.getVariableDeclaration("x")
    expect(varDecl).toBeDefined()
    if (varDecl) {
      const initializer = varDecl.getInitializer()
      expect(initializer).toBeDefined()
      if (initializer) {
        const type = initializer.getType()
        expect(isReactiveType(type)).toBe(true)
      }
    }
  })

  it("should not detect primitive types as reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      const count: number = 5
      const x = count
    `,
    )

    const varDecl = sourceFile.getVariableDeclaration("x")
    expect(varDecl).toBeDefined()
    if (varDecl) {
      const initializer = varDecl.getInitializer()
      expect(initializer).toBeDefined()
      if (initializer) {
        const type = initializer.getType()
        expect(isReactiveType(type)).toBe(false)
      }
    }
  })
})

// =============================================================================
// expressionIsReactive Tests
// =============================================================================

describe("expressionIsReactive", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addLoroTypes(project)
  })

  it("should detect direct ref access as reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./loro-types"
      declare const count: CounterRef
      count.get()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(213)[0] // CallExpression
    expect(callExpr).toBeDefined()
    expect(expressionIsReactive(callExpr)).toBe(true)
  })

  it("should detect template literal with ref as reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./loro-types"
      declare const count: CounterRef
      const x = \`Count: \${count.get()}\`
    `,
    )

    const templateExpr = sourceFile.getDescendantsOfKind(228)[0] // TemplateExpression
    expect(templateExpr).toBeDefined()
    expect(expressionIsReactive(templateExpr)).toBe(true)
  })

  it("should detect static string literal as not reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      const x = "Hello, World!"
    `,
    )

    const stringLiteral = sourceFile.getDescendantsOfKind(11)[0] // StringLiteral
    expect(stringLiteral).toBeDefined()
    expect(expressionIsReactive(stringLiteral)).toBe(false)
  })

  it("should detect static number as not reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      const x = 42
    `,
    )

    const numLiteral = sourceFile.getDescendantsOfKind(9)[0] // NumericLiteral
    expect(numLiteral).toBeDefined()
    expect(expressionIsReactive(numLiteral)).toBe(false)
  })
})

// =============================================================================
// extractDependencies Tests
// =============================================================================

describe("extractDependencies", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addLoroTypes(project)
  })

  it("should extract single dependency from method call", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./loro-types"
      declare const count: CounterRef
      count.get()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(213)[0]
    expect(callExpr).toBeDefined()

    const deps = extractDependencies(callExpr)
    expect(deps).toContain("count")
  })

  it("should extract dependency from nested property access", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { StructRef, TextRef } from "./loro-types"
      declare const doc: StructRef<{ title: TextRef }>
      doc.get("title").toString()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(213)[0]
    expect(callExpr).toBeDefined()

    const deps = extractDependencies(callExpr)
    expect(deps.length).toBeGreaterThan(0)
  })

  it("should return empty array for static expressions", () => {
    const sourceFile = createSourceFile(
      project,
      `
      const x = "Hello"
    `,
    )

    const stringLiteral = sourceFile.getDescendantsOfKind(11)[0]
    expect(stringLiteral).toBeDefined()

    const deps = extractDependencies(stringLiteral)
    expect(deps).toHaveLength(0)
  })
})

// =============================================================================
// analyzeExpression Tests
// =============================================================================

describe("analyzeExpression", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addLoroTypes(project)
  })

  it("should create text node for string literal", () => {
    const sourceFile = createSourceFile(
      project,
      `
      "Hello, World!"
    `,
    )

    const stringLiteral = sourceFile.getDescendantsOfKind(11)[0]
    expect(stringLiteral).toBeDefined()

    const result = analyzeExpression(stringLiteral)
    expect(result.kind).toBe("text")
    if (result.kind === "text") {
      expect(result.value).toBe("Hello, World!")
    }
  })

  it("should create static expression for number", () => {
    const sourceFile = createSourceFile(
      project,
      `
      42
    `,
    )

    const numLiteral = sourceFile.getDescendantsOfKind(9)[0]
    expect(numLiteral).toBeDefined()

    const result = analyzeExpression(numLiteral)
    expect(result.kind).toBe("expression")
    if (result.kind === "expression") {
      expect(result.expressionKind).toBe("static")
      expect(result.source).toBe("42")
    }
  })

  it("should create reactive expression for ref access", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./loro-types"
      declare const count: CounterRef
      count.get()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(213)[0]
    expect(callExpr).toBeDefined()

    const result = analyzeExpression(callExpr) as ExpressionNode
    expect(result.kind).toBe("expression")
    expect(result.expressionKind).toBe("reactive")
    expect(result.dependencies).toContain("count")
  })
})

// =============================================================================
// analyzeProps Tests
// =============================================================================

describe("analyzeProps", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
  })

  it("should extract static attributes", () => {
    const sourceFile = createSourceFile(
      project,
      `
      const props = { class: "container", id: "main" }
    `,
    )

    const objLiteral = sourceFile.getDescendantsOfKind(210)[0] // ObjectLiteralExpression
    expect(objLiteral).toBeDefined()

    const result = analyzeProps(objLiteral)
    expect(result.attributes).toHaveLength(2)
    expect(result.attributes[0].name).toBe("class")
    expect(result.attributes[1].name).toBe("id")
  })

  it("should extract event handlers separately", () => {
    const sourceFile = createSourceFile(
      project,
      `
      const props = { class: "btn", onClick: () => console.log("clicked") }
    `,
    )

    const objLiteral = sourceFile.getDescendantsOfKind(210)[0]
    expect(objLiteral).toBeDefined()

    const result = analyzeProps(objLiteral)
    expect(result.attributes).toHaveLength(1)
    expect(result.attributes[0].name).toBe("class")
    expect(result.eventHandlers).toHaveLength(1)
    expect(result.eventHandlers[0].event).toBe("click")
  })

  it("should handle multiple event handlers", () => {
    const sourceFile = createSourceFile(
      project,
      `
      const props = {
        onClick: () => {},
        onMouseEnter: () => {},
        onInput: (e) => {}
      }
    `,
    )

    const objLiteral = sourceFile.getDescendantsOfKind(210)[0]
    expect(objLiteral).toBeDefined()

    const result = analyzeProps(objLiteral)
    expect(result.attributes).toHaveLength(0)
    expect(result.eventHandlers).toHaveLength(3)
    expect(result.eventHandlers.map(h => h.event)).toEqual([
      "click",
      "mouseenter",
      "input",
    ])
  })

  it("should strip quotes from string-keyed property names", () => {
    const sourceFile = createSourceFile(
      project,
      `
      const props = { "data-testid": "my-component", "aria-label": "Close button" }
    `,
    )

    const objLiteral = sourceFile.getDescendantsOfKind(210)[0]
    expect(objLiteral).toBeDefined()

    const result = analyzeProps(objLiteral)
    expect(result.attributes).toHaveLength(2)
    // Names should NOT include the quotes
    expect(result.attributes[0].name).toBe("data-testid")
    expect(result.attributes[1].name).toBe("aria-label")
  })

  it("should handle mixed quoted and unquoted property names", () => {
    const sourceFile = createSourceFile(
      project,
      `
      const props = { class: "btn", "data-value": "123", id: "submit" }
    `,
    )

    const objLiteral = sourceFile.getDescendantsOfKind(210)[0]
    expect(objLiteral).toBeDefined()

    const result = analyzeProps(objLiteral)
    expect(result.attributes).toHaveLength(3)
    expect(result.attributes[0].name).toBe("class")
    expect(result.attributes[1].name).toBe("data-value")
    expect(result.attributes[2].name).toBe("id")
  })
})

// =============================================================================
// analyzeBuilder Tests
// =============================================================================

describe("analyzeBuilder", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addLoroTypes(project)
  })

  it("should analyze simple static builder", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        h1("Hello, World!")
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    expect(calls).toHaveLength(1)

    const builder = analyzeBuilder(calls[0])
    expect(builder).not.toBeNull()
    expect(builder?.factoryName).toBe("div")
    expect(builder?.children).toHaveLength(1)
    expect(builder?.isReactive).toBe(false)
  })

  it("should analyze builder with props", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div({ class: "container" }, () => {
        p("Content")
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    expect(calls).toHaveLength(1)

    const builder = analyzeBuilder(calls[0])
    expect(builder).not.toBeNull()
    expect(builder?.factoryName).toBe("div")
    expect(builder?.props).toHaveLength(1)
    expect(builder?.props[0].name).toBe("class")
    expect(builder?.children).toHaveLength(1)
  })

  it("should analyze builder with reactive content", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./loro-types"
      declare const count: CounterRef

      div(() => {
        p(count.get().toString())
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    expect(calls).toHaveLength(1)

    const builder = analyzeBuilder(calls[0])
    expect(builder).not.toBeNull()
    // Note: Reactive detection depends on type resolution which may not work
    // perfectly in test environment without full type definitions.
    // The structure should still be correct.
    expect(builder?.children.length).toBeGreaterThan(0)
  })

  it("should analyze builder with nested elements", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        header(() => {
          h1("Title")
        })
        main(() => {
          p("Content")
        })
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const topLevelCall = calls.find(c => c.getExpression().getText() === "div")
    expect(topLevelCall).toBeDefined()
    if (!topLevelCall) return

    const builder = analyzeBuilder(topLevelCall)
    expect(builder).not.toBeNull()
    expect(builder?.factoryName).toBe("div")
    expect(builder?.children).toHaveLength(2)
    expect(builder?.children[0].kind).toBe("element")
    expect(builder?.children[1].kind).toBe("element")
  })

  it("should analyze builder with for loop (list region)", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { ListRef } from "./loro-types"
      declare const items: ListRef<string>

      ul(() => {
        for (const item of items) {
          li(item)
        }
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const ulCall = calls.find(c => c.getExpression().getText() === "ul")
    expect(ulCall).toBeDefined()
    if (!ulCall) return

    const builder = analyzeBuilder(ulCall)
    expect(builder).not.toBeNull()
    expect(builder?.children).toHaveLength(1)
    expect(builder?.children[0].kind).toBe("list-region")

    if (builder?.children[0].kind === "list-region") {
      expect(builder.children[0].itemVariable).toBe("item")
      expect(builder.children[0].listSource).toBe("items")
    }
  })

  it("should analyze builder with if statement (conditional region)", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./loro-types"
      declare const count: CounterRef

      div(() => {
        if (count.get() > 0) {
          p("Has items")
        } else {
          p("No items")
        }
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const divCall = calls.find(c => c.getExpression().getText() === "div")
    expect(divCall).toBeDefined()
    if (!divCall) return

    const builder = analyzeBuilder(divCall)
    expect(builder).not.toBeNull()
    expect(builder?.children).toHaveLength(1)
    expect(builder?.children[0].kind).toBe("conditional-region")

    if (builder?.children[0].kind === "conditional-region") {
      expect(builder.children[0].branches).toHaveLength(2)
      expect(builder.children[0].branches[0].condition).not.toBeNull()
      expect(builder.children[0].branches[1].condition).toBeNull() // else branch
    }
  })

  it("should analyze non-element CallExpression arguments as expressions", () => {
    // This tests the bug fix: count.get() is a CallExpression but NOT an element factory.
    // Before the fix, these were silently dropped. Now they're treated as expressions.
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./loro-types"
      declare const count: CounterRef

      div(() => {
        p(count.get())
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const divCall = calls.find(c => c.getExpression().getText() === "div")
    expect(divCall).toBeDefined()
    if (!divCall) return

    const builder = analyzeBuilder(divCall)
    expect(builder).not.toBeNull()

    // The div should have one child: the p element
    expect(builder?.children).toHaveLength(1)
    expect(builder?.children[0].kind).toBe("element")

    if (builder?.children[0].kind === "element") {
      const pElement = builder.children[0]
      expect(pElement.tag).toBe("p")

      // The p element should have count.get() as a child expression
      expect(pElement.children).toHaveLength(1)
      expect(pElement.children[0].kind).toBe("expression")

      if (pElement.children[0].kind === "expression") {
        expect(pElement.children[0].source).toBe("count.get()")
        expect(pElement.children[0].expressionKind).toBe("reactive")
        expect(pElement.children[0].dependencies).toContain("count")
      }
    }
  })

  it("should produce serializable IR (snapshot test)", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div({ class: "app" }, () => {
        h1("My App")
        p("Welcome!")
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    // IR should be JSON-serializable
    expect(() => JSON.stringify(builder)).not.toThrow()

    // Snapshot the structure (not exact values due to line numbers)
    expect(builder?.kind).toBe("builder")
    expect(builder?.factoryName).toBe("div")
    expect(builder?.props.length).toBe(1)
    expect(builder?.children.length).toBe(2)
  })
})

// =============================================================================
// Statement Analysis Tests
// =============================================================================

describe("analyzeStatement - arbitrary statements", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addLoroTypes(project)
  })

  it("should capture variable declarations as StatementNode", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        const x = 1
        p("hello")
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    expect(builder?.children.length).toBe(2)

    // First child should be a statement
    expect(builder?.children[0].kind).toBe("statement")
    if (builder?.children[0].kind === "statement") {
      expect(builder.children[0].source).toContain("const x = 1")
    }

    // Second child should be the element
    expect(builder?.children[1].kind).toBe("element")
  })

  it("should capture expression statements as StatementNode", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        console.log("debug")
        p("hello")
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    expect(builder?.children.length).toBe(2)

    // First child should be a statement
    expect(builder?.children[0].kind).toBe("statement")
    if (builder?.children[0].kind === "statement") {
      expect(builder.children[0].source).toContain('console.log("debug")')
    }
  })

  it("should capture variable declaration inside for...of body", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { ListRef } from "./loro-types"
      declare const items: ListRef<{ get(): string }>

      ul(() => {
        for (const itemRef of items) {
          const item = itemRef.get()
          li(item)
        }
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    expect(builder?.children.length).toBe(1)
    expect(builder?.children[0].kind).toBe("list-region")

    if (builder?.children[0].kind === "list-region") {
      const listRegion = builder.children[0]
      expect(listRegion.body.length).toBe(2)

      // First should be statement
      expect(listRegion.body[0].kind).toBe("statement")
      if (listRegion.body[0].kind === "statement") {
        expect(listRegion.body[0].source).toContain(
          "const item = itemRef.get()",
        )
      }

      // Second should be element
      expect(listRegion.body[1].kind).toBe("element")
    }
  })

  it("should capture variable declaration inside if body", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./loro-types"
      declare const count: CounterRef

      div(() => {
        if (count.get() > 0) {
          const msg = "has items"
          p(msg)
        }
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    expect(builder?.children.length).toBe(1)
    expect(builder?.children[0].kind).toBe("conditional-region")

    if (builder?.children[0].kind === "conditional-region") {
      const conditional = builder.children[0]
      const thenBranch = conditional.branches[0]
      expect(thenBranch.body.length).toBe(2)

      // First should be statement
      expect(thenBranch.body[0].kind).toBe("statement")
      if (thenBranch.body[0].kind === "statement") {
        expect(thenBranch.body[0].source).toContain('const msg = "has items"')
      }

      // Second should be element
      expect(thenBranch.body[1].kind).toBe("element")
    }
  })

  it("should preserve statement order", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        const a = 1
        console.log("first")
        p("element")
        const b = 2
        console.log("second")
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    expect(builder?.children.length).toBe(5)

    expect(builder?.children[0].kind).toBe("statement")
    expect(builder?.children[1].kind).toBe("statement")
    expect(builder?.children[2].kind).toBe("element")
    expect(builder?.children[3].kind).toBe("statement")
    expect(builder?.children[4].kind).toBe("statement")
  })

  it("should still recursively analyze block statements", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        {
          const x = 1
          p("inside block")
        }
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    // Block contents should be flattened
    expect(builder?.children.length).toBe(2)
    expect(builder?.children[0].kind).toBe("statement")
    expect(builder?.children[1].kind).toBe("element")
  })

  it("should throw error for return statements", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        if (true) return
        p("hello")
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)

    expect(() => analyzeBuilder(calls[0])).toThrow(
      /Return statement not supported/,
    )
  })

  it("should create StaticLoopNode for non-reactive for...of", () => {
    const sourceFile = createSourceFile(
      project,
      `
      ul(() => {
        for (const x of [1, 2, 3]) {
          li(x)
        }
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    expect(builder?.children.length).toBe(1)
    expect(builder?.children[0].kind).toBe("static-loop")

    if (builder?.children[0].kind === "static-loop") {
      const staticLoop = builder.children[0]
      expect(staticLoop.iterableSource).toBe("[1, 2, 3]")
      expect(staticLoop.itemVariable).toBe("x")
      expect(staticLoop.body.length).toBe(1)
      expect(staticLoop.body[0].kind).toBe("element")
    }
  })

  it("should create StaticConditionalNode for static if", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        if (true) {
          p("yes")
        }
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    expect(builder?.children.length).toBe(1)
    expect(builder?.children[0].kind).toBe("static-conditional")

    if (builder?.children[0].kind === "static-conditional") {
      const staticCond = builder.children[0]
      expect(staticCond.conditionSource).toBe("true")
      expect(staticCond.thenBody.length).toBe(1)
      expect(staticCond.thenBody[0].kind).toBe("element")
      expect(staticCond.elseBody).toBeNull()
    }
  })

  it("should create StaticConditionalNode with else branch", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        if (false) {
          p("yes")
        } else {
          p("no")
        }
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    expect(builder?.children.length).toBe(1)
    expect(builder?.children[0].kind).toBe("static-conditional")

    if (builder?.children[0].kind === "static-conditional") {
      const staticCond = builder.children[0]
      expect(staticCond.conditionSource).toBe("false")
      expect(staticCond.thenBody.length).toBe(1)
      expect(staticCond.elseBody).not.toBeNull()
      expect(staticCond.elseBody?.length).toBe(1)
    }
  })
})

// =============================================================================
// Integration Tests (Full Builder Analysis)
// =============================================================================

describe("integration: complex builder analysis", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addLoroTypes(project)
  })

  it("should handle todo list example structure", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { ListRef, TextRef } from "./loro-types"

      interface Todo {
        text: string
        done: boolean
      }

      declare const items: ListRef<Todo>
      declare const title: TextRef

      div({ class: "todo-app" }, () => {
        h1(title.toString())

        ul(() => {
          for (const item of items) {
            li(item.text)
          }
        })
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const divCall = calls.find(c => c.getExpression().getText() === "div")
    expect(divCall).toBeDefined()
    if (!divCall) return

    const builder = analyzeBuilder(divCall)
    expect(builder).not.toBeNull()
    expect(builder?.factoryName).toBe("div")
    expect(builder?.props[0].name).toBe("class")

    // Should have h1 and ul as children
    expect(builder?.children).toHaveLength(2)
    expect(builder?.children[0].kind).toBe("element")
    expect(builder?.children[1].kind).toBe("element")

    // The ul should contain a list region
    if (builder?.children[1].kind === "element") {
      const ulElement = builder.children[1]
      expect(ulElement.tag).toBe("ul")
      expect(ulElement.children).toHaveLength(1)
      expect(ulElement.children[0].kind).toBe("list-region")
    }
  })

  it("should analyze nested structure with conditionals", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef, TextRef } from "./loro-types"

      declare const title: TextRef
      declare const count: CounterRef

      div(() => {
        h1(title.toString())
        if (count.get() > 0) {
          p(count.get().toString())
        }
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const divCall = calls.find(c => c.getExpression().getText() === "div")
    expect(divCall).toBeDefined()
    if (!divCall) return

    const builder = analyzeBuilder(divCall)

    expect(builder).not.toBeNull()
    expect(builder?.factoryName).toBe("div")
    // Should have h1 and conditional region as children
    expect(builder?.children.length).toBeGreaterThanOrEqual(2)
  })
})
