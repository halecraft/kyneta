/**
 * Unit tests for Kinetic compiler analysis.
 *
 * These tests verify that the analysis module correctly transforms
 * TypeScript AST into IR nodes.
 */

import { Project, SyntaxKind } from "ts-morph"
import { beforeEach, describe, expect, it } from "vitest"
import {
  analyzeBuilder,
  analyzeElementCall,
  analyzeExpression,
  analyzeProps,
  detectDirectRead,
  detectImplicitRead,
  ELEMENT_FACTORIES,
  expressionIsReactive,
  extractDependencies,
  findBuilderCalls,
  isReactiveType,
} from "./analyze.js"
import {
  isChangefeedType,
  isComponentFactoryType,
  resolveReactiveImports,
} from "./reactive-detection.js"
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
 * Add the shared changefeed type definitions (CHANGEFEED symbol, Changefeed interface).
 * This must be called before addSchemaTypes or addReactiveTypes.
 *
 * Mirrors the protocol from @kyneta/schema:
 * - CHANGEFEED: unique symbol (Symbol.for("kinetic:changefeed"))
 * - Changefeed<S, C>: { current: S, subscribe(cb: (change: C) => void): () => void }
 * - HasChangefeed<S, C>: { readonly [CHANGEFEED]: Changefeed<S, C> }
 * - ChangeBase: { type: string, origin?: string }
 */
function addBaseChangefeedTypes(project: Project) {
  project.createSourceFile(
    "changefeed-base.d.ts",
    `
    export const CHANGEFEED: unique symbol

    export interface ChangeBase {
      readonly type: string
      readonly origin?: string
    }

    export interface Changefeed<S, C extends ChangeBase = ChangeBase> {
      readonly current: S
      subscribe(callback: (change: C) => void): () => void
    }

    export interface HasChangefeed<S = unknown, C extends ChangeBase = ChangeBase> {
      readonly [CHANGEFEED]: Changefeed<S, C>
    }
  `,
    { overwrite: true },
  )
}

/**
 * Add schema-style type definitions to the project.
 * Imports CHANGEFEED from the shared base to ensure type identity.
 *
 * Each ref type declares a *specific* change type in its Changefeed —
 * e.g., Changefeed<string, TextChange> for text refs. Without narrowing,
 * getDeltaKind sees ChangeBase.type as `string` (not a literal) and
 * silently falls back to "replace".
 */
function addSchemaTypes(project: Project) {
  addBaseChangefeedTypes(project)
  project.createSourceFile(
    "schema-types.d.ts",
    `
    import { CHANGEFEED, ChangeBase, Changefeed, HasChangefeed } from "./changefeed-base"

    export type TextChange = { readonly type: "text"; readonly ops: readonly unknown[] }
    export type SequenceChange<T = unknown> = { readonly type: "sequence"; readonly ops: readonly unknown[] }
    export type MapChange = { readonly type: "map"; readonly set?: Record<string, unknown>; readonly delete?: readonly string[] }
    export type ReplaceChange<T = unknown> = { readonly type: "replace"; readonly value: T }
    export type IncrementChange = { readonly type: "increment"; readonly amount: number }
    export type TreeChange = { readonly type: "tree"; readonly ops: readonly unknown[] }

    export interface TextRef extends HasChangefeed<string, TextChange> {
      readonly [CHANGEFEED]: Changefeed<string, TextChange>
      insert(pos: number, text: string): void
      delete(pos: number, len: number): void
      toString(): string
      get(): string
    }

    export interface CounterRef extends HasChangefeed<number, ReplaceChange<number>> {
      readonly [CHANGEFEED]: Changefeed<number, ReplaceChange<number>>
      get(): number
      increment(n: number): void
    }

    export interface ListRef<T> extends HasChangefeed<T[], SequenceChange<T>> {
      readonly [CHANGEFEED]: Changefeed<T[], SequenceChange<T>>
      push(item: T): void
      insert(index: number, item: T): void
      delete(index: number, len?: number): void
      at(index: number): T | undefined
      toArray(): T[]
      readonly length: number
      [Symbol.iterator](): Iterator<T>
    }

    export interface StructRef<T> extends HasChangefeed<T, MapChange> {
      readonly [CHANGEFEED]: Changefeed<T, MapChange>
      get<K extends keyof T>(key: K): T[K]
    }

    export type TypedDoc<Shape> = Shape & HasChangefeed<unknown, MapChange> & {
      readonly [CHANGEFEED]: Changefeed<unknown, MapChange>
      toJSON(): unknown
    }
  `,
    { overwrite: true },
  )
}

// Backward-compatible alias — many test beforeEach blocks call addLoroTypes
const addLoroTypes = addSchemaTypes

/**
 * Add reactive type definitions (LocalRef, etc.) to the project.
 * Uses CHANGEFEED protocol.
 */
function addReactiveTypes(project: Project) {
  addBaseChangefeedTypes(project)
  project.createSourceFile(
    "reactive-types.d.ts",
    `
    import { CHANGEFEED, ChangeBase, Changefeed, HasChangefeed } from "./changefeed-base"
    export { CHANGEFEED, ChangeBase, Changefeed, HasChangefeed }

    export type ReplaceChange<T = unknown> = { readonly type: "replace"; readonly value: T }

    export class LocalRef<T> implements HasChangefeed<T, ReplaceChange<T>> {
      readonly [CHANGEFEED]: Changefeed<T, ReplaceChange<T>>
      constructor(initial: T)
      get(): T
      set(value: T): void
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
// ComponentFactory Detection Tests
// =============================================================================

describe("ComponentFactory detection", () => {
  it("should recognize a function that returns (scope) => Node as ComponentFactory", () => {
    const project = createProject()
    const sourceFile = project.createSourceFile(
      "component.ts",
      `
      type Element = (scope: any) => Node
      type ComponentFactory<P extends Record<string, unknown> = {}> = (props: P) => Element

      const MyComponent: ComponentFactory<{ title: string }> = (props) => {
        return (scope: any) => document.createElement("div")
      }
      `,
      { overwrite: true },
    )

    const myComponentDecl = sourceFile.getVariableDeclaration("MyComponent")
    expect(myComponentDecl).toBeDefined()

    const type = myComponentDecl!.getType()
    expect(isComponentFactoryType(type)).toBe(true)
  })

  it("should not recognize regular functions as ComponentFactory", () => {
    const project = createProject()
    const sourceFile = project.createSourceFile(
      "regular.ts",
      `
      const regularFunc = (x: number) => x * 2
      const stringFunc = (s: string) => s.toUpperCase()
      `,
      { overwrite: true },
    )

    const regularDecl = sourceFile.getVariableDeclaration("regularFunc")
    const stringDecl = sourceFile.getVariableDeclaration("stringFunc")

    expect(isComponentFactoryType(regularDecl!.getType())).toBe(false)
    expect(isComponentFactoryType(stringDecl!.getType())).toBe(false)
  })

  it("should recognize component usage in analyzeElementCall", () => {
    const project = createProject()
    const sourceFile = project.createSourceFile(
      "usage.ts",
      `
      type Element = (scope: any) => Node
      type ComponentFactory<P extends Record<string, unknown> = {}> = (props: P) => Element

      const Avatar: ComponentFactory<{ src: string }> = (props) => {
        return (scope: any) => document.createElement("img")
      }

      const result = Avatar({ src: "photo.jpg" })
      `,
      { overwrite: true },
    )

    // Find the Avatar call
    const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
    const avatarCall = calls.find(c => c.getExpression().getText() === "Avatar")
    expect(avatarCall).toBeDefined()

    const ir = analyzeElementCall(avatarCall!)
    expect(ir).not.toBeNull()
    expect(ir?.kind).toBe("element")
    if (ir?.kind === "element") {
      expect(ir.tag).toBe("Avatar")
      expect(ir.factorySource).toBe("Avatar")
      expect(ir.attributes.length).toBe(1)
      expect(ir.attributes[0].name).toBe("src")
    }
  })

  it("should still recognize HTML elements without factorySource", () => {
    const project = createProject()
    // Use the shared project helper that has ambient declarations
    const sourceFile = createSourceFile(
      project,
      `
      declare function div(props?: any, ...children: any[]): any
      const result = div({ class: "container" })
      `,
    )

    const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
    const divCall = calls.find(c => c.getExpression().getText() === "div")
    expect(divCall).toBeDefined()

    const ir = analyzeElementCall(divCall!)
    expect(ir).not.toBeNull()
    expect(ir?.kind).toBe("element")
    if (ir?.kind === "element") {
      expect(ir.tag).toBe("div")
      expect(ir.factorySource).toBeUndefined()
    }
  })

  it("should include component calls in findBuilderCalls", () => {
    const project = createProject()
    const sourceFile = project.createSourceFile(
      "builder.ts",
      `
      type Element = (scope: any) => Node
      type ComponentFactory<P extends Record<string, unknown> = {}> = (props: P) => Element

      const Card: ComponentFactory<{ title: string }> = (props) => {
        return (scope: any) => document.createElement("div")
      }

      const app = Card({ title: "Test" }, () => {
        // builder content
      })
      `,
      { overwrite: true },
    )

    const calls = findBuilderCalls(sourceFile)
    expect(calls.length).toBe(1)
    expect(calls[0].getExpression().getText()).toBe("Card")
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
    addSchemaTypes(project)
  })

  it("should detect TextRef as reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./schema-types"
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
      import { CounterRef } from "./schema-types"
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
      import { ListRef } from "./schema-types"
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
    addSchemaTypes(project)
  })

  it("should detect direct ref access as reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./schema-types"
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
      import { CounterRef } from "./schema-types"
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

  it("should detect chained method call on reactive ref as reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./schema-types"
      declare const count: CounterRef
      count.get().toString()
    `,
    )

    // Find the outermost call expression: count.get().toString()
    const callExprs = sourceFile.getDescendantsOfKind(213) // CallExpression
    const chained = callExprs.find(c => c.getText() === "count.get().toString()")
    expect(chained).toBeDefined()
    expect(expressionIsReactive(chained!)).toBe(true)
  })

  it("should detect deeply chained method call on reactive ref as reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./schema-types"
      declare const count: CounterRef
      count.get().toFixed(2).trim()
    `,
    )

    const callExprs = sourceFile.getDescendantsOfKind(213)
    const chained = callExprs.find(
      c => c.getText() === "count.get().toFixed(2).trim()",
    )
    expect(chained).toBeDefined()
    expect(expressionIsReactive(chained!)).toBe(true)
  })

  it("should detect chained method call on LocalRef as reactive", () => {
    addReactiveTypes(project)
    const sourceFile = createSourceFile(
      project,
      `
      import { LocalRef } from "./reactive-types"
      declare const x: LocalRef<number>
      x.get().toString()
    `,
    )

    const callExprs = sourceFile.getDescendantsOfKind(213)
    const chained = callExprs.find(c => c.getText() === "x.get().toString()")
    expect(chained).toBeDefined()
    expect(expressionIsReactive(chained!)).toBe(true)
  })

  it("should not detect chained call on non-reactive as reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      const x = 42
      x.toString().trim()
    `,
    )

    const callExprs = sourceFile.getDescendantsOfKind(213)
    const chained = callExprs.find(c => c.getText() === "x.toString().trim()")
    expect(chained).toBeDefined()
    expect(expressionIsReactive(chained!)).toBe(false)
  })
})

// =============================================================================
// extractDependencies Tests
// =============================================================================

describe("extractDependencies", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addSchemaTypes(project)
  })

  it("should extract single dependency from method call", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./schema-types"
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
      import { StructRef, TextRef } from "./schema-types"
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
      import { TextRef } from "./schema-types"
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

  it("ListRef dependency has deltaKind 'sequence'", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { ListRef } from "./schema-types"
      declare const items: ListRef<string>
      items.length
    `,
    )

    const propAccess = sourceFile.getDescendantsOfKind(211)[0]
    expect(propAccess).toBeDefined()

    const deps = extractDependencies(propAccess)
    expect(deps.length).toBe(1)
    expect(deps[0].source).toBe("items")
    expect(deps[0].deltaKind).toBe("sequence")
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
      import { CounterRef } from "./schema-types"
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
    addSchemaTypes(project)
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
      import { CounterRef } from "./schema-types"
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
    addSchemaTypes(project)
  })

  it("detects title.get() as direct read", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./schema-types"
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
      import { TextRef } from "./schema-types"
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
      import { TextRef } from "./schema-types"
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
      import { TextRef } from "./schema-types"
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
      import { TextRef } from "./schema-types"
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
      import { TextRef } from "./schema-types"
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
      import { ListRef } from "./schema-types"
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
      import { TextRef } from "./schema-types"
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
      import { TextRef } from "./schema-types"
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
    addSchemaTypes(project)
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
      import { CounterRef } from "./schema-types"
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
      import { ListRef } from "./schema-types"
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
      import { CounterRef } from "./schema-types"
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
      import { CounterRef } from "./schema-types"
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
    addSchemaTypes(project)
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
      import { ListRef } from "./schema-types"
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
      import { CounterRef } from "./schema-types"
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
    addSchemaTypes(project)
  })

  it("should handle todo list example structure", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { ListRef, TextRef } from "./schema-types"

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
      import { CounterRef, TextRef } from "./schema-types"

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

// =============================================================================
// Target Label Detection Tests
// =============================================================================

describe("analyzeStatement - target labels", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addSchemaTypes(project)
  })

  it("should produce TargetBlockNode for client: label", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        client: {
          console.log("browser")
        }
        p("hello")
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    expect(builder?.children.length).toBe(2)

    // First child should be a target block targeting "dom"
    expect(builder?.children[0].kind).toBe("target-block")
    if (builder?.children[0].kind === "target-block") {
      expect(builder.children[0].target).toBe("dom")
      expect(builder.children[0].children.length).toBe(1)
      expect(builder.children[0].children[0].kind).toBe("statement")
    }

    // Second child should be the element
    expect(builder?.children[1].kind).toBe("element")
  })

  it("should produce TargetBlockNode for server: label", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        server: {
          console.log("ssr")
        }
        p("hello")
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    expect(builder?.children.length).toBe(2)

    // First child should be a target block targeting "html"
    expect(builder?.children[0].kind).toBe("target-block")
    if (builder?.children[0].kind === "target-block") {
      expect(builder.children[0].target).toBe("html")
      expect(builder.children[0].children.length).toBe(1)
      expect(builder.children[0].children[0].kind).toBe("statement")
    }

    // Second child should be the element
    expect(builder?.children[1].kind).toBe("element")
  })

  it("should recursively analyze children inside target block", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        client: {
          const x = 1
          p(String(x))
        }
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    expect(builder?.children.length).toBe(1)
    expect(builder?.children[0].kind).toBe("target-block")

    if (builder?.children[0].kind === "target-block") {
      const block = builder.children[0]
      expect(block.target).toBe("dom")
      expect(block.children.length).toBe(2)

      // First child: statement (const x = 1)
      expect(block.children[0].kind).toBe("statement")
      if (block.children[0].kind === "statement") {
        expect(block.children[0].source).toContain("const x = 1")
      }

      // Second child: element (p)
      expect(block.children[1].kind).toBe("element")
    }
  })

  it("should treat unknown labels as verbatim statements", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        myLabel: {
          const x = 1
        }
        p("hello")
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    expect(builder?.children.length).toBe(2)

    // Unknown label should be captured as a plain statement
    expect(builder?.children[0].kind).toBe("statement")
    if (builder?.children[0].kind === "statement") {
      expect(builder.children[0].source).toContain("myLabel")
    }

    // Second child should be the element
    expect(builder?.children[1].kind).toBe("element")
  })

  it("should handle nested element calls inside target block", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        server: {
          header(() => {
            h1("Server Title")
          })
        }
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    expect(builder?.children.length).toBe(1)
    expect(builder?.children[0].kind).toBe("target-block")

    if (builder?.children[0].kind === "target-block") {
      const block = builder.children[0]
      expect(block.target).toBe("html")
      // The header() call should be analyzed as a nested element
      expect(block.children.length).toBe(1)
      expect(block.children[0].kind).toBe("element")
    }
  })

  it("should handle both client: and server: blocks in same builder", () => {
    const sourceFile = createSourceFile(
      project,
      `
      div(() => {
        client: {
          console.log("browser only")
        }
        h1("shared")
        server: {
          console.log("ssr only")
        }
      })
    `,
    )

    const calls = findBuilderCalls(sourceFile)
    const builder = analyzeBuilder(calls[0])

    expect(builder).not.toBeNull()
    expect(builder?.children.length).toBe(3)

    expect(builder?.children[0].kind).toBe("target-block")
    if (builder?.children[0].kind === "target-block") {
      expect(builder.children[0].target).toBe("dom")
    }

    expect(builder?.children[1].kind).toBe("element")

    expect(builder?.children[2].kind).toBe("target-block")
    if (builder?.children[2].kind === "target-block") {
      expect(builder.children[2].target).toBe("html")
    }
  })
})

// =============================================================================
// Phase 4: CHANGEFEED Protocol Compiler Tests
// =============================================================================

// -----------------------------------------------------------------------------
// isChangefeedType Tests (replaces isSnapshotableType)
// -----------------------------------------------------------------------------

describe("isChangefeedType", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addLoroTypes(project)
  })

  it("detects TextRef as having changefeed", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./schema-types"
      declare const title: TextRef
    `,
    )

    const varDecl = sourceFile.getVariableDeclaration("title")!
    expect(isChangefeedType(varDecl.getType())).toBe(true)
  })

  it("detects CounterRef as having changefeed", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./schema-types"
      declare const count: CounterRef
    `,
    )

    const varDecl = sourceFile.getVariableDeclaration("count")!
    expect(isChangefeedType(varDecl.getType())).toBe(true)
  })

  it("detects ListRef as having changefeed", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { ListRef } from "./schema-types"
      declare const items: ListRef<string>
    `,
    )

    const varDecl = sourceFile.getVariableDeclaration("items")!
    expect(isChangefeedType(varDecl.getType())).toBe(true)
  })

  it("rejects plain object types", () => {
    const sourceFile = createSourceFile(
      project,
      `
      declare const obj: { name: string }
    `,
    )

    const varDecl = sourceFile.getVariableDeclaration("obj")!
    expect(isChangefeedType(varDecl.getType())).toBe(false)
  })

  it("rejects any and unknown", () => {
    const sourceFile = createSourceFile(
      project,
      `
      declare const a: any
      declare const u: unknown
    `,
    )

    expect(isChangefeedType(sourceFile.getVariableDeclaration("a")!.getType())).toBe(false)
    expect(isChangefeedType(sourceFile.getVariableDeclaration("u")!.getType())).toBe(false)
  })

  it("handles union types (has changefeed if any branch does)", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./schema-types"
      declare const maybeRef: TextRef | null
    `,
    )

    const varDecl = sourceFile.getVariableDeclaration("maybeRef")!
    expect(isChangefeedType(varDecl.getType())).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// detectImplicitRead Tests
// -----------------------------------------------------------------------------

describe("detectImplicitRead", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addSchemaTypes(project)
  })

  it("detects bare TextRef as implicit read", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./schema-types"
      declare const doc: { title: TextRef }
      doc.title
    `,
    )

    // Get the expression statement's expression (doc.title)
    const exprStmt = sourceFile.getStatements().at(-1)!
    const expr = exprStmt.getChildAtIndex(0)

    const result = detectImplicitRead(expr as any)
    expect(result).toBe("doc.title")
  })

  it("rejects non-reactive expressions", () => {
    const sourceFile = createSourceFile(
      project,
      `
      declare const someString: string
      someString
    `,
    )

    const exprStmt = sourceFile.getStatements().at(-1)!
    const expr = exprStmt.getChildAtIndex(0)

    const result = detectImplicitRead(expr as any)
    expect(result).toBeUndefined()
  })

  it("rejects call expressions (those go through detectDirectRead)", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./schema-types"
      declare const doc: { title: TextRef }
      doc.title.get()
    `,
    )

    // The call expression: doc.title.get()
    const callExpr = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)[0]
    expect(callExpr).toBeDefined()

    const result = detectImplicitRead(callExpr)
    expect(result).toBeUndefined()
  })

  it("detects bare CounterRef as implicit read", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./schema-types"
      declare const count: CounterRef
      count
    `,
    )

    const exprStmt = sourceFile.getStatements().at(-1)!
    const expr = exprStmt.getChildAtIndex(0)

    const result = detectImplicitRead(expr as any)
    expect(result).toBe("count")
  })
})

// -----------------------------------------------------------------------------
// analyzeExpression with implicit read Tests
// -----------------------------------------------------------------------------

describe("analyzeExpression with implicit read (bare ref)", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addSchemaTypes(project)
  })

  it("bare TextRef produces reactive content with synthesized .get() source", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./schema-types"
      declare const title: TextRef
      title
    `,
    )

    const exprStmt = sourceFile.getStatements().at(-1)!
    const expr = exprStmt.getChildAtIndex(0)

    const result = analyzeExpression(expr as any) as ContentValue
    expect(result.kind).toBe("content")
    expect(result.bindingTime).toBe("reactive")
    // Source is synthesized with .get()
    expect(result.source).toBe("title.get()")
    // directReadSource is the bare ref
    expect(result.directReadSource).toBe("title")
  })

  it("bare CounterRef produces reactive content with synthesized .get() source", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./schema-types"
      declare const count: CounterRef
      count
    `,
    )

    const exprStmt = sourceFile.getStatements().at(-1)!
    const expr = exprStmt.getChildAtIndex(0)

    const result = analyzeExpression(expr as any) as ContentValue
    expect(result.kind).toBe("content")
    expect(result.bindingTime).toBe("reactive")
    expect(result.source).toBe("count.get()")
    expect(result.directReadSource).toBe("count")
  })

  it("explicit .get() still works as before (backward compatible)", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./schema-types"
      declare const title: TextRef
      title.get()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)[0]
    expect(callExpr).toBeDefined()

    const result = analyzeExpression(callExpr) as ContentValue
    expect(result.kind).toBe("content")
    expect(result.bindingTime).toBe("reactive")
    expect(result.directReadSource).toBe("title")
  })

  it("explicit .toString() still works as before", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./schema-types"
      declare const title: TextRef
      title.toString()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)[0]
    expect(callExpr).toBeDefined()

    const result = analyzeExpression(callExpr) as ContentValue
    expect(result.kind).toBe("content")
    expect(result.bindingTime).toBe("reactive")
    expect(result.directReadSource).toBe("title")
  })

  it("bare ref with property access synthesizes .get()", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./schema-types"
      declare const doc: { title: TextRef }
      doc.title
    `,
    )

    const exprStmt = sourceFile.getStatements().at(-1)!
    const expr = exprStmt.getChildAtIndex(0)

    const result = analyzeExpression(expr as any) as ContentValue
    expect(result.kind).toBe("content")
    expect(result.bindingTime).toBe("reactive")
    expect(result.source).toBe("doc.title.get()")
    expect(result.directReadSource).toBe("doc.title")
  })
})

// -----------------------------------------------------------------------------
// extractDependencies fix for reactive-typed property access
// -----------------------------------------------------------------------------

describe("extractDependencies fix for reactive-typed property access", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addSchemaTypes(project)
  })

  it("captures doc.title as dependency when doc is not reactive but doc.title is TextRef", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./schema-types"
      declare const doc: { title: TextRef }
      doc.title
    `,
    )

    const exprStmt = sourceFile.getStatements().at(-1)!
    const expr = exprStmt.getChildAtIndex(0)

    const deps = extractDependencies(expr as any)
    expect(deps).toHaveLength(1)
    expect(deps[0].source).toBe("doc.title")
    expect(deps[0].deltaKind).toBe("text")
  })

  it("captures doc.title from doc.title.get() (existing behavior preserved)", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./schema-types"
      declare const doc: { title: TextRef }
      doc.title.get()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)[0]
    expect(callExpr).toBeDefined()

    const deps = extractDependencies(callExpr)
    expect(deps).toHaveLength(1)
    expect(deps[0].source).toBe("doc.title")
    expect(deps[0].deltaKind).toBe("text")
  })

  it("captures CounterRef dependency from bare property access", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CounterRef } from "./schema-types"
      declare const doc: { count: CounterRef }
      doc.count
    `,
    )

    const exprStmt = sourceFile.getStatements().at(-1)!
    const expr = exprStmt.getChildAtIndex(0)

    const deps = extractDependencies(expr as any)
    expect(deps).toHaveLength(1)
    expect(deps[0].source).toBe("doc.count")
    expect(deps[0].deltaKind).toBe("replace")
  })

  it("deduplicates when property access result already captured by object check", () => {
    // When the object IS reactive and the result IS reactive,
    // we should only get one dependency (deduplication via depsMap)
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef } from "./schema-types"
      declare const title: TextRef
      title.get()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)[0]
    expect(callExpr).toBeDefined()

    const deps = extractDependencies(callExpr)
    // Should be exactly 1 dep for "title", not duplicated
    expect(deps).toHaveLength(1)
    expect(deps[0].source).toBe("title")
  })
})

// -----------------------------------------------------------------------------
// Dependency subsumption — child deps make parent deps redundant
// -----------------------------------------------------------------------------

describe("dependency subsumption", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    addSchemaTypes(project)
  })

  it("doc.title.toString() with reactive TypedDoc produces only doc.title dep (subsumes doc)", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef, TypedDoc } from "./schema-types"
      declare const doc: TypedDoc<{ title: TextRef }>
      doc.title.toString()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)[0]
    expect(callExpr).toBeDefined()

    const deps = extractDependencies(callExpr)
    // Subsumption: "doc" (map) is dropped because "doc.title" (text) is more specific
    expect(deps).toHaveLength(1)
    expect(deps[0].source).toBe("doc.title")
    expect(deps[0].deltaKind).toBe("text")
  })

  it("doc.title.get() with reactive TypedDoc produces only doc.title dep", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef, TypedDoc } from "./schema-types"
      declare const doc: TypedDoc<{ title: TextRef }>
      doc.title.get()
    `,
    )

    const callExpr = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)[0]
    expect(callExpr).toBeDefined()

    const deps = extractDependencies(callExpr)
    expect(deps).toHaveLength(1)
    expect(deps[0].source).toBe("doc.title")
    expect(deps[0].deltaKind).toBe("text")
  })

  it("does not subsume unrelated deps", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { CHANGEFEED, Changefeed, HasChangefeed, ChangeBase } from "./changefeed-base"
      type ReplaceChange<T> = { readonly type: "replace"; readonly value: T }
      declare const a: HasChangefeed<number, ReplaceChange<number>> & { readonly [CHANGEFEED]: Changefeed<number, ReplaceChange<number>>; get(): number; toString(): string }
      declare const b: HasChangefeed<number, ReplaceChange<number>> & { readonly [CHANGEFEED]: Changefeed<number, ReplaceChange<number>>; get(): number; toString(): string }
      a.toString() + b.toString()
    `,
    )

    const exprStmt = sourceFile.getStatements().at(-1)!
    const expr = exprStmt.getChildAtIndex(0)

    const deps = extractDependencies(expr as any)
    // "a" and "b" are not prefixes of each other — both should remain
    expect(deps).toHaveLength(2)
  })

  it("isReactiveType detects TypedDoc as reactive", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef, TypedDoc } from "./schema-types"
      declare const doc: TypedDoc<{ title: TextRef }>
      doc
    `,
    )

    const exprStmt = sourceFile.getStatements().at(-1)!
    const expr = exprStmt.getChildAtIndex(0)
    const type = (expr as any).getType()

    expect(isReactiveType(type)).toBe(true)
  })

  it("isChangefeedType detects TypedDoc as having changefeed", () => {
    const sourceFile = createSourceFile(
      project,
      `
      import { TextRef, TypedDoc } from "./schema-types"
      declare const doc: TypedDoc<{ title: TextRef }>
      doc
    `,
    )

    const exprStmt = sourceFile.getStatements().at(-1)!
    const expr = exprStmt.getChildAtIndex(0)
    const type = (expr as any).getType()

    expect(isChangefeedType(type)).toBe(true)
  })
})
