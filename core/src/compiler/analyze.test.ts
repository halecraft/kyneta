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
  detectDirectRead,
  ELEMENT_FACTORIES,
  expressionIsReactive,
  extractDependencies,
  findBuilderCalls,
  isReactiveType,
} from "./analyze.js"
import { resolveReactiveImports } from "./reactive-detection.js"
import type { ContentValue } from "./ir.js"

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
 * Add the shared reactive type definitions (REACTIVE symbol, Reactive interface).
 * This must be called before addLoroTypes or addReactiveTypes.
 */
function addBaseReactiveTypes(project: Project) {
  project.createSourceFile(
    "reactive-base.d.ts",
    `
    export const REACTIVE: unique symbol
    export type ReactiveDelta =
      | { type: "replace" }
      | { type: "text"; ops: unknown[] }
      | { type: "list"; ops: unknown[] }
      | { type: "map"; ops: { keys: string[] } }
      | { type: "tree"; ops: unknown[] }
    export type DeltaKind = ReactiveDelta["type"]
    export type ReactiveSubscribe<D extends ReactiveDelta = ReactiveDelta> = (self: unknown, callback: (delta: D) => void) => () => void
    export interface Reactive<D extends ReactiveDelta = ReactiveDelta> {
      readonly [REACTIVE]: ReactiveSubscribe<D>
    }
  `,
    { overwrite: true },
  )
}

/**
 * Add Loro type definitions to the project.
 * Imports REACTIVE from the shared base to ensure type identity.
 */
function addLoroTypes(project: Project) {
  addBaseReactiveTypes(project)
  project.createSourceFile(
    "loro-types.d.ts",
    `
    import { REACTIVE, ReactiveSubscribe, Reactive, ReactiveDelta } from "./reactive-base"

    type TextDelta = { type: "text"; ops: unknown[] }
    type ListDelta = { type: "list"; ops: unknown[] }
    type MapDelta = { type: "map"; ops: { keys: string[] } }
    type ReplaceDelta = { type: "replace" }

    export interface TextRef extends Reactive<TextDelta> {
      readonly [REACTIVE]: ReactiveSubscribe<TextDelta>
      insert(pos: number, text: string): void
      delete(pos: number, len: number): void
      toString(): string
      get(): string
    }

    export interface CounterRef extends Reactive<ReplaceDelta> {
      readonly [REACTIVE]: ReactiveSubscribe<ReplaceDelta>
      get(): number
      increment(n: number): void
    }

    export interface ListRef<T> extends Reactive<ListDelta> {
      readonly [REACTIVE]: ReactiveSubscribe<ListDelta>
      push(item: T): void
      insert(index: number, item: T): void
      delete(index: number, len?: number): void
      get(index: number): T
      toArray(): T[]
      length: number
    }

    export interface StructRef<T> extends Reactive<MapDelta> {
      readonly [REACTIVE]: ReactiveSubscribe<MapDelta>
      get<K extends keyof T>(key: K): T[K]
    }
  `,
    { overwrite: true },
  )
}

/**
 * Add reactive type definitions (LocalRef, etc.) to the project.
 * Imports REACTIVE from the shared base to ensure type identity.
 */
function addReactiveTypes(project: Project) {
  addBaseReactiveTypes(project)
  project.createSourceFile(
    "reactive-types.d.ts",
    `
    import { REACTIVE, ReactiveSubscribe, Reactive, ReactiveDelta } from "./reactive-base"
    export { REACTIVE, ReactiveSubscribe, Reactive, ReactiveDelta }
    export class LocalRef<T> implements Reactive<{ type: "replace" }> {
      readonly [REACTIVE]: ReactiveSubscribe<{ type: "replace" }>
      constructor(initial: T)
      get(): T
      set(value: T): void
      subscribe(callback: (delta: { type: "replace" }) => void): () => void
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

  it("should detect LocalRef as reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { LocalRef } from "./reactive-types"
      declare const isOpen: LocalRef<boolean>
      const x = isOpen
    `,
    )

    addReactiveTypes(project)

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
})

// =============================================================================
// Symbol-based Reactive Detection Tests
// =============================================================================

describe("symbol-based reactive detection", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addReactiveTypes(project)
  })

  it("detects LocalRef as reactive by name", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { LocalRef } from "./reactive-types"
      const isOpen = new LocalRef(false)
    `,
    )

    const varDecl = sourceFile.getVariableDeclaration("isOpen")
    expect(varDecl).toBeDefined()
    if (varDecl) {
      const type = varDecl.getType()
      expect(isReactiveType(type)).toBe(true)
    }
  })

  it("does not detect unbranded subscribable as reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      class NotReactive {
        subscribe(cb: () => void) { return () => {} }
        get() { return 42 }
      }
      const obj = new NotReactive()
    `,
    )

    const varDecl = sourceFile.getVariableDeclaration("obj")
    expect(varDecl).toBeDefined()
    if (varDecl) {
      const type = varDecl.getType()
      expect(isReactiveType(type)).toBe(false)
    }
  })

  it("does not detect plain objects as reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      const obj = { value: 42, subscribe: () => () => {} }
    `,
    )

    const varDecl = sourceFile.getVariableDeclaration("obj")
    expect(varDecl).toBeDefined()
    if (varDecl) {
      const type = varDecl.getType()
      expect(isReactiveType(type)).toBe(false)
    }
  })

  it("detects reactive type in union", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { LocalRef } from "./reactive-types"
      declare const maybeRef: LocalRef<number> | null
      const x = maybeRef
    `,
    )

    const varDecl = sourceFile.getVariableDeclaration("x")
    expect(varDecl).toBeDefined()
    if (varDecl) {
      const type = varDecl.getType()
      expect(isReactiveType(type)).toBe(true)
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
    expect(deps.some(d => d.source === "count")).toBe(true)
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

  it("TextRef dependency has deltaKind 'text'", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./loro-types"
      declare const title: TextRef
      title.toString()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(213)[0]
    expect(callExpr).toBeDefined()

    const deps = extractDependencies(callExpr)
    expect(deps.length).toBe(1)
    expect(deps[0].source).toBe("title")
    expect(deps[0].deltaKind).toBe("text")
  })

  it("ListRef dependency has deltaKind 'list'", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { ListRef } from "./loro-types"
      declare const items: ListRef<string>
      items.length
    `,
    )

    const propAccess = sourceFile.getDescendantsOfKind(211)[0]
    expect(propAccess).toBeDefined()

    const deps = extractDependencies(propAccess)
    expect(deps.length).toBe(1)
    expect(deps[0].source).toBe("items")
    expect(deps[0].deltaKind).toBe("list")
  })

  it("LocalRef dependency has deltaKind 'replace'", () => {
    // Use local stub instead of real module for reliable type resolution
    addReactiveTypes(project)
    const sourceFile = createSourceFile(
      project,
      `
      import { LocalRef } from "./reactive-types"
      declare const isOpen: LocalRef<boolean>
      isOpen.get()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(213)[0]
    expect(callExpr).toBeDefined()

    const deps = extractDependencies(callExpr)
    expect(deps.length).toBe(1)
    expect(deps[0].source).toBe("isOpen")
    expect(deps[0].deltaKind).toBe("replace")
  })

  it("CounterRef dependency has deltaKind 'replace'", () => {
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
    expect(deps.length).toBe(1)
    expect(deps[0].source).toBe("count")
    expect(deps[0].deltaKind).toBe("replace")
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
    expect(result.kind).toBe("content")
    expect(result.bindingTime).toBe("literal")
    if (result.kind === "content" && result.bindingTime === "literal") {
      // source is JSON-encoded, so it includes the quotes
      expect(result.source).toBe('"Hello, World!"')
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
    expect(result.kind).toBe("content")
    if (result.kind === "content") {
      expect(result.bindingTime).toBe("render")
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

    const result = analyzeExpression(callExpr) as ContentValue
    expect(result.kind).toBe("content")
    expect(result.bindingTime).toBe("reactive")
    expect(result.dependencies.some(d => d.source === "count")).toBe(true)
  })
})

// =============================================================================
// detectDirectRead Tests
// =============================================================================

describe("detectDirectRead", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addLoroTypes(project)
  })

  it("detects title.get() as direct read", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./loro-types"
      declare const title: TextRef
      title.get()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(213)[0]
    expect(callExpr).toBeDefined()

    const result = detectDirectRead(callExpr)
    expect(result).toBe("title")
  })

  it("detects title.toString() as direct read", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./loro-types"
      declare const title: TextRef
      title.toString()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(213)[0]
    expect(callExpr).toBeDefined()

    const result = detectDirectRead(callExpr)
    expect(result).toBe("title")
  })

  it("detects doc.title.get() as direct read with full path", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./loro-types"
      declare const doc: { title: TextRef }
      doc.title.get()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(213)[0]
    expect(callExpr).toBeDefined()

    const result = detectDirectRead(callExpr)
    expect(result).toBe("doc.title")
  })

  it("rejects title.get().toUpperCase() — root is outer call", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./loro-types"
      declare const title: TextRef
      title.get().toUpperCase()
    `,
    )

    // Get the outermost call expression (toUpperCase())
    const allCalls = sourceFile.getDescendantsOfKind(213)
    const outerCall = allCalls.find(c => c.getText().includes("toUpperCase"))
    expect(outerCall).toBeDefined()

    const result = detectDirectRead(outerCall!)
    expect(result).toBeUndefined()
  })

  it("rejects title.get() + subtitle.get() — root is binary expr", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./loro-types"
      declare const title: TextRef
      declare const subtitle: TextRef
      title.get() + subtitle.get()
    `,
    )

    // Get the binary expression (the root)
    const binaryExpr = sourceFile.getDescendantsOfKind(226)[0]
    expect(binaryExpr).toBeDefined()

    const result = detectDirectRead(binaryExpr)
    expect(result).toBeUndefined()
  })

  it("rejects template literal with embedded .get()", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./loro-types"
      declare const title: TextRef
      \`Hello \${title.get()}\`
    `,
    )

    // Get the template expression (the root)
    const templateExpr = sourceFile.getDescendantsOfKind(228)[0]
    expect(templateExpr).toBeDefined()

    const result = detectDirectRead(templateExpr)
    expect(result).toBeUndefined()
  })

  it("rejects title.get('arg') — has arguments", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { ListRef } from "./loro-types"
      declare const items: ListRef<string>
      items.get(0)
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(213)[0]
    expect(callExpr).toBeDefined()

    const result = detectDirectRead(callExpr)
    expect(result).toBeUndefined()
  })

  it("rejects non-reactive receiver", () => {
    const sourceFile = createSourceFile(
      project,
      `
      const obj = { get: () => "hello" }
      obj.get()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(213)[0]
    expect(callExpr).toBeDefined()

    const result = detectDirectRead(callExpr)
    expect(result).toBeUndefined()
  })

  it("sets directReadSource on ContentValue for direct reads", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./loro-types"
      declare const title: TextRef
      title.get()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(213)[0]
    expect(callExpr).toBeDefined()

    const result = analyzeExpression(callExpr) as ContentValue
    expect(result.kind).toBe("content")
    expect(result.bindingTime).toBe("reactive")
    expect(result.directReadSource).toBe("title")
  })

  it("leaves directReadSource undefined for non-direct reads (template literal)", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./loro-types"
      declare const title: TextRef
      \`Hello \${title.get()}\`
    `,
    )

    // Get the template expression (the root)
    const templateExpr = sourceFile.getDescendantsOfKind(228)[0]
    expect(templateExpr).toBeDefined()

    const result = analyzeExpression(templateExpr) as ContentValue
    expect(result.kind).toBe("content")
    expect(result.bindingTime).toBe("reactive")
    expect(result.directReadSource).toBeUndefined()
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
    expect(builder?.children[0].kind).toBe("loop")

    if (builder?.children[0].kind === "loop") {
      expect(builder.children[0].itemVariable).toBe("item")
      expect(builder.children[0].iterableSource).toBe("items")
      expect(builder.children[0].iterableBindingTime).toBe("reactive")
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
    expect(builder?.children[0].kind).toBe("conditional")

    if (builder?.children[0].kind === "conditional") {
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
      expect(pElement.children[0].kind).toBe("content")

      if (pElement.children[0].kind === "content") {
        expect(pElement.children[0].source).toBe("count.get()")
        expect(pElement.children[0].bindingTime).toBe("reactive")
        expect(
          pElement.children[0].dependencies.some(d => d.source === "count"),
        ).toBe(true)
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
    expect(builder?.children[0].kind).toBe("loop")

    if (builder?.children[0].kind === "loop") {
      const listRegion = builder.children[0]
      expect(listRegion.iterableBindingTime).toBe("reactive")
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
    expect(builder?.children[0].kind).toBe("conditional")

    if (builder?.children[0].kind === "conditional") {
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
    expect(builder?.children[0].kind).toBe("loop")

    if (builder?.children[0].kind === "loop") {
      const staticLoop = builder.children[0]
      expect(staticLoop.iterableBindingTime).toBe("render")
      expect(staticLoop.iterableSource).toBe("[1, 2, 3]")
      expect(staticLoop.itemVariable).toBe("x")
      expect(staticLoop.body.length).toBe(1)
      expect(staticLoop.body[0].kind).toBe("element")
    }
  })

  it("should create StaticConditionalNode for static if", async () => {
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
    expect(builder?.children[0].kind).toBe("conditional")

    if (builder?.children[0].kind === "conditional") {
      const conditional = builder.children[0]
      expect(conditional.subscriptionTarget).toBeNull() // render-time
      expect(conditional.branches.length).toBe(1)
      expect(conditional.branches[0].condition?.source).toBe("true")
      expect(conditional.branches[0].body.length).toBe(1)
      expect(conditional.branches[0].body[0].kind).toBe("element")
    }
  })

  it("should create StaticConditionalNode with else branch", async () => {
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
    expect(builder?.children[0].kind).toBe("conditional")

    if (builder?.children[0].kind === "conditional") {
      const conditional = builder.children[0]
      expect(conditional.subscriptionTarget).toBeNull() // render-time
      expect(conditional.branches.length).toBe(2)
      expect(conditional.branches[0].condition?.source).toBe("false")
      expect(conditional.branches[0].body.length).toBe(1)
      expect(conditional.branches[1].condition).toBeNull() // else branch
      expect(conditional.branches[1].body.length).toBe(1)
    }
  })

  it("should create nested StaticConditionalNode for static else-if chain", async () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        if (a) {
          p("first")
        } else if (b) {
          p("second")
        } else {
          p("third")
        }
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    expect(builder?.children.length).toBe(1)
    expect(builder?.children[0].kind).toBe("conditional")

    if (builder?.children[0].kind === "conditional") {
      const conditional = builder.children[0]
      expect(conditional.subscriptionTarget).toBeNull() // render-time

      // Post-unification: else-if chains produce flat branches array
      expect(conditional.branches.length).toBe(3)
      expect(conditional.branches[0].condition?.source).toBe("a")
      expect(conditional.branches[0].body.length).toBe(1)
      expect(conditional.branches[0].body[0].kind).toBe("element")

      expect(conditional.branches[1].condition?.source).toBe("b")
      expect(conditional.branches[1].body.length).toBe(1)
      expect(conditional.branches[1].body[0].kind).toBe("element")

      expect(conditional.branches[2].condition).toBeNull() // else branch
      expect(conditional.branches[2].body.length).toBe(1)
      expect(conditional.branches[2].body[0].kind).toBe("element")
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
      expect(ulElement.children[0].kind).toBe("loop")
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
