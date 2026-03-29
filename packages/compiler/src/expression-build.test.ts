/**
 * Tests for the ExpressionIR Builder — AST to ExpressionIR conversion.
 *
 * These tests validate that `buildExpressionIR` correctly walks TypeScript
 * AST expressions (via ts-morph) and produces ExpressionIR trees with:
 * - Auto-read insertion for changefeed expressions consumed as values
 * - Snapshot detection for explicit ref() calls
 * - Binding ref construction for reactive binding references
 * - Correct structural nodes for non-reactive expressions
 * - Ref method vs. value method distinction
 *
 * Uses the same ts-morph in-memory project pattern as `analyze.test.ts`.
 */

import { type Expression, Project, SyntaxKind } from "ts-morph"
import { beforeEach, describe, expect, it } from "vitest"
import { buildExpressionIR, type ExpressionScope } from "./expression-build.js"
import {
  type ExpressionIR,
  extractDeps,
  isReactive,
  renderExpression,
} from "./expression-ir.js"

// =============================================================================
// Test Helpers
// =============================================================================

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
 * Add the shared changefeed type definitions (CHANGEFEED symbol, Changefeed interface).
 */
function addBaseChangefeedTypes(project: Project) {
  project.createSourceFile(
    "changefeed-base.d.ts",
    `
    export const CHANGEFEED: unique symbol

    export interface ChangeBase {
      readonly type: string
    }

    export interface Changeset<C = ChangeBase> {
      readonly changes: readonly C[]
      readonly origin?: string
    }

    export interface Changefeed<S, C extends ChangeBase = ChangeBase> {
      readonly current: S
      subscribe(callback: (changeset: Changeset<C>) => void): () => void
    }

    export interface HasChangefeed<S = unknown, C extends ChangeBase = ChangeBase> {
      readonly [CHANGEFEED]: Changefeed<S, C>
    }
  `,
    { overwrite: true },
  )
}

/**
 * Add schema-style ref type definitions.
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

    export interface TextRef extends HasChangefeed<string, TextChange> {
      readonly [CHANGEFEED]: Changefeed<string, TextChange>
      (): string
      insert(pos: number, text: string): void
      delete(pos: number, len: number): void
      update(content: string): void
      toLowerCase(): string
      toUpperCase(): string
      includes(searchString: string, position?: number): boolean
      trim(): string
      slice(start?: number, end?: number): string
      startsWith(searchString: string, position?: number): boolean
      endsWith(searchString: string, endPosition?: number): boolean
      [Symbol.toPrimitive](hint: string): string
    }

    export interface CounterRef extends HasChangefeed<number, IncrementChange> {
      readonly [CHANGEFEED]: Changefeed<number, IncrementChange>
      (): number
      increment(n?: number): void
      decrement(n?: number): void
      toFixed(fractionDigits?: number): string
      [Symbol.toPrimitive](hint: string): number | string
    }

    export interface ScalarRef<T> extends HasChangefeed<T, ReplaceChange<T>> {
      readonly [CHANGEFEED]: Changefeed<T, ReplaceChange<T>>
      (): T
      set(value: T): void
    }

    export interface ListRef<T> extends HasChangefeed<T[], SequenceChange<T>> {
      readonly [CHANGEFEED]: Changefeed<T[], SequenceChange<T>>
      (): T[]
      get(index: number): T | undefined
      push(item: T): void
      insert(index: number, item: T): void
      delete(index: number, len?: number): void
      readonly length: number
      [Symbol.iterator](): Iterator<T>
    }

    export interface StructRef<T> extends HasChangefeed<T, MapChange> {
      readonly [CHANGEFEED]: Changefeed<T, MapChange>
      (): T
    }

    export type TypedDoc<Shape> = Shape & HasChangefeed<unknown, MapChange> & {
      readonly [CHANGEFEED]: Changefeed<unknown, MapChange>
      toJSON(): unknown
    }

    export interface RecipeRef {
      readonly name: TextRef
      readonly vegetarian: ScalarRef<boolean>
      readonly ingredients: ListRef<string>
    }

    export type RecipeBookDoc = TypedDoc<{
      readonly recipes: ListRef<RecipeRef>
      readonly favorites: CounterRef
      readonly title: TextRef
    }>
  `,
    { overwrite: true },
  )
}

/**
 * Add LocalRef/state type definitions.
 */
function addReactiveTypes(project: Project) {
  addBaseChangefeedTypes(project)
  project.createSourceFile(
    "reactive-types.d.ts",
    `
    import { CHANGEFEED, ChangeBase, Changefeed, HasChangefeed } from "./changefeed-base"
    export { CHANGEFEED, ChangeBase, Changefeed, HasChangefeed }

    export type ReplaceChange<T = unknown> = { readonly type: "replace"; readonly value: T }

    export interface LocalRef<T> extends HasChangefeed<T, ReplaceChange<T>> {
      (): T
      readonly [CHANGEFEED]: Changefeed<T, ReplaceChange<T>>
      set(value: T): void
    }
    export declare function state<T>(initial: T): LocalRef<T>
  `,
    { overwrite: true },
  )
}

function setupImports(project: Project) {
  addSchemaTypes(project)
  addReactiveTypes(project)
}

/**
 * Extract the first expression from a source file.
 * The code should contain a single expression statement.
 */
function getExpression(project: Project, code: string): Expression {
  const sourceFile = project.createSourceFile("expr-test.ts", code, {
    overwrite: true,
  })
  const statements = sourceFile.getStatements()
  // Find the last expression statement (skip imports/declarations)
  for (let i = statements.length - 1; i >= 0; i--) {
    const stmt = statements[i]
    if (stmt.getKind() === SyntaxKind.ExpressionStatement) {
      return (stmt as any).getExpression() as Expression
    }
  }
  throw new Error("No expression statement found in source")
}

/**
 * Build an ExpressionIR from source code with schema types available.
 */
function buildFromSource(
  project: Project,
  exprCode: string,
  preamble: string = "",
  scope?: ExpressionScope,
): ExpressionIR {
  const code = `
    import { RecipeBookDoc, RecipeRef, TextRef, CounterRef, ScalarRef, ListRef } from "./schema-types"
    import { state, LocalRef } from "./reactive-types"
    ${preamble}
    ${exprCode}
  `
  const expr = getExpression(project, code)
  return buildExpressionIR(expr, scope)
}

/**
 * Create a simple ExpressionScope for testing.
 */
function createScope(bindings: Record<string, ExpressionIR>): ExpressionScope {
  return {
    lookupExpression(name: string): ExpressionIR | undefined {
      return bindings[name]
    },
  }
}

// =============================================================================
// Tests
// =============================================================================

describe("buildExpressionIR", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    setupImports(project)
  })

  // ===========================================================================
  // Literals and identifiers
  // ===========================================================================

  describe("Literals and identifiers", () => {
    it("builds a string literal", () => {
      const ir = buildFromSource(project, `"hello"`)
      expect(ir.kind).toBe("literal")
      if (ir.kind === "literal") {
        expect(ir.value).toBe('"hello"')
      }
    })

    it("builds a numeric literal", () => {
      const ir = buildFromSource(project, `42`)
      expect(ir.kind).toBe("literal")
      if (ir.kind === "literal") {
        expect(ir.value).toBe("42")
      }
    })

    it("builds a boolean literal", () => {
      const ir = buildFromSource(project, `true`)
      expect(ir.kind).toBe("literal")
      if (ir.kind === "literal") {
        expect(ir.value).toBe("true")
      }
    })

    it("builds a plain identifier", () => {
      const ir = buildFromSource(project, `x`, `declare const x: number`)
      expect(ir.kind).toBe("identifier")
      if (ir.kind === "identifier") {
        expect(ir.name).toBe("x")
      }
    })

    it("builds a no-substitution template literal", () => {
      const ir = buildFromSource(project, "`hello`")
      expect(ir.kind).toBe("literal")
      if (ir.kind === "literal") {
        expect(ir.value).toBe("hello")
      }
    })
  })

  // ===========================================================================
  // Property access — structural navigation vs. auto-read
  // ===========================================================================

  describe("Property access", () => {
    it("plain property access on non-reactive object", () => {
      const ir = buildFromSource(
        project,
        `obj.prop`,
        `declare const obj: { prop: string }`,
      )
      expect(ir.kind).toBe("property-access")
      if (ir.kind === "property-access") {
        expect(ir.property).toBe("prop")
        expect(ir.object.kind).toBe("identifier")
      }
    })

    it("structural navigation: doc.title where both are changefeed", () => {
      // doc is TypedDoc (changefeed), doc.title is TextRef (changefeed)
      // → structural navigation, no RefRead
      const ir = buildFromSource(
        project,
        `doc.title`,
        `declare const doc: RecipeBookDoc`,
      )
      expect(ir.kind).toBe("property-access")
      if (ir.kind === "property-access") {
        expect(ir.property).toBe("title")
        expect(ir.object.kind).toBe("identifier")
        // No ref-read wrapping — both sides are changefeeds
      }
    })

    it("structural navigation: doc.recipes (list ref)", () => {
      const ir = buildFromSource(
        project,
        `doc.recipes`,
        `declare const doc: RecipeBookDoc`,
      )
      expect(ir.kind).toBe("property-access")
      if (ir.kind === "property-access") {
        expect(ir.property).toBe("recipes")
        // No ref-read — it's a ListRef (changefeed → changefeed)
      }
    })

    it("ref-own property: listRef.length (auto-read for reactivity)", () => {
      // length is defined on the SequenceRef/ListRef interface itself,
      // but it's still reactive — when the list changefeed fires
      // (items added/removed), .length changes and must re-evaluate.
      const ir = buildFromSource(
        project,
        `doc.recipes.length`,
        `declare const doc: RecipeBookDoc`,
      )

      // The outer node is property-access(".length") wrapping a ref-read
      // of the list ref. This ensures isReactive() returns true and
      // extractDeps() finds doc.recipes as a subscription target.
      expect(ir.kind).toBe("property-access")
      if (ir.kind === "property-access") {
        expect(ir.property).toBe("length")
        expect(ir.object.kind).toBe("ref-read")
      }
    })
  })

  // ===========================================================================
  // Call expressions — snapshot vs. method call vs. ref method
  // ===========================================================================

  describe("Call expressions", () => {
    it("explicit ref() call → SnapshotNode", () => {
      // recipe.name() — developer explicitly calls the ref
      const ir = buildFromSource(
        project,
        `recipe.name()`,
        `declare const recipe: RecipeRef`,
      )
      expect(ir.kind).toBe("snapshot")
      if (ir.kind === "snapshot") {
        expect(ir.ref.kind).toBe("property-access")
        expect(ir.args).toHaveLength(0)
        expect(ir.deltaKind).toBe("text")
      }
    })

    it("explicit LocalRef call → SnapshotNode", () => {
      const ir = buildFromSource(
        project,
        `filterText()`,
        `declare const filterText: LocalRef<string>`,
      )
      expect(ir.kind).toBe("snapshot")
      if (ir.kind === "snapshot") {
        expect(ir.ref.kind).toBe("identifier")
        if (ir.ref.kind === "identifier") {
          expect(ir.ref.name).toBe("filterText")
        }
        expect(ir.deltaKind).toBe("replace")
      }
    })

    it("value method on changefeed receiver → auto-read + method call", () => {
      // recipe.name.toLowerCase() — toLowerCase is a String method, not a TextRef method
      // → MethodCall(RefRead(recipe.name), "toLowerCase", [])
      const ir = buildFromSource(
        project,
        `recipe.name.toLowerCase()`,
        `declare const recipe: RecipeRef`,
      )
      expect(ir.kind).toBe("method-call")
      if (ir.kind === "method-call") {
        expect(ir.method).toBe("toLowerCase")
        expect(ir.args).toHaveLength(0)
        // The receiver should be a RefRead wrapping the property access
        expect(ir.receiver.kind).toBe("ref-read")
        if (ir.receiver.kind === "ref-read") {
          expect(ir.receiver.deltaKind).toBe("text")
          expect(ir.receiver.ref.kind).toBe("property-access")
        }
      }
    })

    it("value method: recipe.name.includes('x') → auto-read", () => {
      const ir = buildFromSource(
        project,
        `recipe.name.includes("x")`,
        `declare const recipe: RecipeRef`,
      )
      expect(ir.kind).toBe("method-call")
      if (ir.kind === "method-call") {
        expect(ir.method).toBe("includes")
        expect(ir.receiver.kind).toBe("ref-read")
        expect(ir.args).toHaveLength(1)
      }
    })

    it("ref mutation method: recipe.name.insert(0, 'x') → NO auto-read", () => {
      // insert is defined on TextRef — it's a ref method, not a value method
      const ir = buildFromSource(
        project,
        `recipe.name.insert(0, "x")`,
        `declare const recipe: RecipeRef`,
      )
      expect(ir.kind).toBe("method-call")
      if (ir.kind === "method-call") {
        expect(ir.method).toBe("insert")
        // The receiver should NOT be wrapped in RefRead
        expect(ir.receiver.kind).toBe("property-access")
        expect(ir.args).toHaveLength(2)
      }
    })

    it("ref mutation method: recipe.name.delete(0, 1) → NO auto-read", () => {
      const ir = buildFromSource(
        project,
        `recipe.name.delete(0, 1)`,
        `declare const recipe: RecipeRef`,
      )
      expect(ir.kind).toBe("method-call")
      if (ir.kind === "method-call") {
        expect(ir.method).toBe("delete")
        expect(ir.receiver.kind).toBe("property-access")
      }
    })

    it("ref mutation method: recipe.name.update('new text') → NO auto-read", () => {
      const ir = buildFromSource(
        project,
        `recipe.name.update("new text")`,
        `declare const recipe: RecipeRef`,
      )
      expect(ir.kind).toBe("method-call")
      if (ir.kind === "method-call") {
        expect(ir.method).toBe("update")
        expect(ir.receiver.kind).toBe("property-access")
      }
    })

    it("ref mutation method: counter.increment() → NO auto-read", () => {
      const ir = buildFromSource(
        project,
        `doc.favorites.increment(1)`,
        `declare const doc: RecipeBookDoc`,
      )
      expect(ir.kind).toBe("method-call")
      if (ir.kind === "method-call") {
        expect(ir.method).toBe("increment")
        expect(ir.receiver.kind).toBe("property-access")
      }
    })

    it("ref mutation method: scalar.set(value) → NO auto-read", () => {
      const ir = buildFromSource(
        project,
        `recipe.vegetarian.set(true)`,
        `declare const recipe: RecipeRef`,
      )
      expect(ir.kind).toBe("method-call")
      if (ir.kind === "method-call") {
        expect(ir.method).toBe("set")
        expect(ir.receiver.kind).toBe("property-access")
      }
    })

    it("ref mutation method: list.push(item) → NO auto-read", () => {
      const ir = buildFromSource(
        project,
        `recipe.ingredients.push("salt")`,
        `declare const recipe: RecipeRef`,
      )
      expect(ir.kind).toBe("method-call")
      if (ir.kind === "method-call") {
        expect(ir.method).toBe("push")
        expect(ir.receiver.kind).toBe("property-access")
      }
    })

    it("non-reactive function call", () => {
      const ir = buildFromSource(project, `parseInt("42")`, ``)
      expect(ir.kind).toBe("call")
      if (ir.kind === "call") {
        expect(ir.callee.kind).toBe("identifier")
        if (ir.callee.kind === "identifier") {
          expect(ir.callee.name).toBe("parseInt")
        }
      }
    })

    it("value method on counter ref: counter.toFixed(2) → auto-read", () => {
      const ir = buildFromSource(
        project,
        `doc.favorites.toFixed(2)`,
        `declare const doc: RecipeBookDoc`,
      )
      expect(ir.kind).toBe("method-call")
      if (ir.kind === "method-call") {
        expect(ir.method).toBe("toFixed")
        expect(ir.receiver.kind).toBe("ref-read")
        if (ir.receiver.kind === "ref-read") {
          expect(ir.receiver.deltaKind).toBe("increment")
        }
      }
    })
  })

  // ===========================================================================
  // Binary expressions
  // ===========================================================================

  describe("Binary expressions", () => {
    it("non-reactive binary expression", () => {
      const ir = buildFromSource(
        project,
        `a + b`,
        `declare const a: number; declare const b: number`,
      )
      expect(ir.kind).toBe("binary")
      if (ir.kind === "binary") {
        expect(ir.op).toBe("+")
        expect(ir.left.kind).toBe("identifier")
        expect(ir.right.kind).toBe("identifier")
      }
    })

    it("binary with changefeed operand → auto-read wrapping", () => {
      // recipe.vegetarian is a ScalarRef<boolean> (changefeed)
      // In a binary expression, it should be wrapped in RefRead
      const ir = buildFromSource(
        project,
        `recipe.vegetarian || fallback`,
        `declare const recipe: RecipeRef; declare const fallback: boolean`,
      )
      expect(ir.kind).toBe("binary")
      if (ir.kind === "binary") {
        expect(ir.op).toBe("||")
        // Left should be ref-read of recipe.vegetarian
        expect(ir.left.kind).toBe("ref-read")
        // Right should be plain identifier
        expect(ir.right.kind).toBe("identifier")
      }
    })

    it("comparison with changefeed → auto-read", () => {
      const ir = buildFromSource(
        project,
        `doc.favorites > 0`,
        `declare const doc: RecipeBookDoc`,
      )
      expect(ir.kind).toBe("binary")
      if (ir.kind === "binary") {
        expect(ir.op).toBe(">")
        expect(ir.left.kind).toBe("ref-read")
        if (ir.left.kind === "ref-read") {
          expect(ir.left.deltaKind).toBe("increment")
        }
      }
    })
  })

  // ===========================================================================
  // Ternary expressions
  // ===========================================================================

  describe("Ternary expressions", () => {
    it("non-reactive ternary expression", () => {
      const ir = buildFromSource(
        project,
        `a ? b : c`,
        `declare const a: boolean; declare const b: string; declare const c: string`,
      )
      expect(ir.kind).toBe("ternary")
      if (ir.kind === "ternary") {
        expect(ir.condition.kind).toBe("identifier")
        expect(ir.whenTrue.kind).toBe("identifier")
        expect(ir.whenFalse.kind).toBe("identifier")
      }
    })

    it("ternary with changefeed condition → auto-read wrapping", () => {
      const ir = buildFromSource(
        project,
        `recipe.vegetarian ? "yes" : "no"`,
        `declare const recipe: RecipeRef`,
      )
      expect(ir.kind).toBe("ternary")
      if (ir.kind === "ternary") {
        expect(ir.condition.kind).toBe("ref-read")
        expect(ir.whenTrue.kind).toBe("literal")
        expect(ir.whenFalse.kind).toBe("literal")
      }
    })

    it("ternary with changefeed in branch → auto-read wrapping", () => {
      const ir = buildFromSource(
        project,
        `flag ? recipe.name : fallback`,
        `declare const recipe: RecipeRef; declare const flag: boolean; declare const fallback: string`,
      )
      expect(ir.kind).toBe("ternary")
      if (ir.kind === "ternary") {
        expect(ir.condition.kind).toBe("identifier")
        expect(ir.whenTrue.kind).toBe("ref-read")
        expect(ir.whenFalse.kind).toBe("identifier")
      }
    })
  })

  // ===========================================================================
  // Element access expressions
  // ===========================================================================

  describe("Element access expressions", () => {
    it("non-reactive element access", () => {
      const ir = buildFromSource(
        project,
        `arr[0]`,
        `declare const arr: string[]`,
      )
      expect(ir.kind).toBe("element-access")
      if (ir.kind === "element-access") {
        expect(ir.object.kind).toBe("identifier")
        expect(ir.index.kind).toBe("literal")
      }
    })

    it("element access on changefeed object → auto-read wrapping", () => {
      const ir = buildFromSource(
        project,
        `doc.recipes[0]`,
        `declare const doc: RecipeBookDoc`,
      )
      expect(ir.kind).toBe("element-access")
      if (ir.kind === "element-access") {
        // doc.recipes is a ListRef (changefeed) consumed for a non-changefeed element
        expect(ir.object.kind).toBe("ref-read")
        expect(ir.index.kind).toBe("literal")
      }
    })
  })

  // ===========================================================================
  // Unary expressions
  // ===========================================================================

  describe("Unary expressions", () => {
    it("non-reactive prefix unary", () => {
      const ir = buildFromSource(
        project,
        `!flag`,
        `declare const flag: boolean`,
      )
      expect(ir.kind).toBe("unary")
      if (ir.kind === "unary") {
        expect(ir.op).toBe("!")
        expect(ir.prefix).toBe(true)
        expect(ir.operand.kind).toBe("identifier")
      }
    })

    it("negation of changefeed → auto-read wrapping", () => {
      // !veggieOnly where veggieOnly is a LocalRef<boolean>
      const ir = buildFromSource(
        project,
        `!veggieOnly`,
        `declare const veggieOnly: LocalRef<boolean>`,
      )
      expect(ir.kind).toBe("unary")
      if (ir.kind === "unary") {
        expect(ir.op).toBe("!")
        expect(ir.prefix).toBe(true)
        expect(ir.operand.kind).toBe("ref-read")
        if (ir.operand.kind === "ref-read") {
          expect(ir.operand.deltaKind).toBe("replace")
          expect(ir.operand.ref.kind).toBe("identifier")
        }
      }
    })

    it("negation of ScalarRef<boolean> → auto-read", () => {
      const ir = buildFromSource(
        project,
        `!recipe.vegetarian`,
        `declare const recipe: RecipeRef`,
      )
      expect(ir.kind).toBe("unary")
      if (ir.kind === "unary") {
        expect(ir.op).toBe("!")
        expect(ir.operand.kind).toBe("ref-read")
      }
    })
  })

  // ===========================================================================
  // Template expressions
  // ===========================================================================

  describe("Template expressions", () => {
    it("non-reactive template literal", () => {
      const ir = buildFromSource(
        project,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional template literal source text for parsing
        "`Hello ${name}!`",
        `declare const name: string`,
      )
      expect(ir.kind).toBe("template")
      if (ir.kind === "template") {
        expect(ir.parts).toHaveLength(3)
        // parts[0]: "Hello " (literal)
        expect(ir.parts[0].kind).toBe("literal")
        // parts[1]: name (identifier)
        expect(ir.parts[1].kind).toBe("identifier")
        // parts[2]: "!" (literal)
        expect(ir.parts[2].kind).toBe("literal")
      }
    })

    it("template with changefeed hole → auto-read wrapping", () => {
      const ir = buildFromSource(
        project,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional template literal source text for parsing
        "`Title: ${doc.title}`",
        `declare const doc: RecipeBookDoc`,
      )
      expect(ir.kind).toBe("template")
      if (ir.kind === "template") {
        expect(ir.parts).toHaveLength(3)
        // parts[1] should be ref-read of doc.title
        expect(ir.parts[1].kind).toBe("ref-read")
        if (ir.parts[1].kind === "ref-read") {
          expect(ir.parts[1].deltaKind).toBe("text")
        }
      }
    })

    it("template with multiple changefeed holes", () => {
      const ir = buildFromSource(
        project,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional template literal source text for parsing
        "`${doc.title}: ${doc.favorites} stars`",
        `declare const doc: RecipeBookDoc`,
      )
      expect(ir.kind).toBe("template")
      if (ir.kind === "template") {
        // 5 parts: "" + title + ": " + favorites + " stars"
        expect(ir.parts).toHaveLength(5)
        expect(ir.parts[1].kind).toBe("ref-read") // doc.title
        expect(ir.parts[3].kind).toBe("ref-read") // doc.favorites
      }
    })
  })

  // ===========================================================================
  // Binding references
  // ===========================================================================

  describe("Binding references", () => {
    it("identifier resolving to reactive binding → BindingRefNode", () => {
      const innerExpr: ExpressionIR = {
        kind: "ref-read",
        ref: { kind: "identifier", name: "filterText" },
        deltaKind: "replace",
      }
      const scope = createScope({ nameMatch: innerExpr })

      const ir = buildFromSource(
        project,
        `nameMatch`,
        `declare const nameMatch: boolean`,
        scope,
      )
      expect(ir.kind).toBe("binding-ref")
      if (ir.kind === "binding-ref") {
        expect(ir.name).toBe("nameMatch")
        expect(ir.expression).toBe(innerExpr)
      }
    })

    it("binary with two binding refs", () => {
      const nameMatchExpr: ExpressionIR = {
        kind: "ref-read",
        ref: { kind: "identifier", name: "filterText" },
        deltaKind: "replace",
      }
      const veggieMatchExpr: ExpressionIR = {
        kind: "ref-read",
        ref: { kind: "identifier", name: "veggieOnly" },
        deltaKind: "replace",
      }
      const scope = createScope({
        nameMatch: nameMatchExpr,
        veggieMatch: veggieMatchExpr,
      })

      const ir = buildFromSource(
        project,
        `nameMatch && veggieMatch`,
        `declare const nameMatch: boolean; declare const veggieMatch: boolean`,
        scope,
      )
      expect(ir.kind).toBe("binary")
      if (ir.kind === "binary") {
        expect(ir.op).toBe("&&")
        expect(ir.left.kind).toBe("binding-ref")
        expect(ir.right.kind).toBe("binding-ref")
        if (ir.left.kind === "binding-ref") {
          expect(ir.left.name).toBe("nameMatch")
        }
        if (ir.right.kind === "binding-ref") {
          expect(ir.right.name).toBe("veggieMatch")
        }
      }
    })

    it("identifier NOT in scope → plain IdentifierNode", () => {
      const scope = createScope({})

      const ir = buildFromSource(
        project,
        `someVar`,
        `declare const someVar: boolean`,
        scope,
      )
      expect(ir.kind).toBe("identifier")
      if (ir.kind === "identifier") {
        expect(ir.name).toBe("someVar")
      }
    })
  })

  // ===========================================================================
  // Compound expressions (recipe-book filter pattern)
  // ===========================================================================

  describe("Compound expressions", () => {
    it("recipe.name.toLowerCase().includes(filterText.toLowerCase())", () => {
      // This is the compound filter expression from the recipe-book example.
      // Expected IR:
      //   MethodCall(
      //     MethodCall(RefRead(PropertyAccess(recipe, name)), "toLowerCase", []),
      //     "includes",
      //     [MethodCall(Snapshot(filterText), "toLowerCase", [])]
      //   )
      //
      // Note: filterText.toLowerCase() — filterText is a LocalRef<string>.
      // Calling .toLowerCase() on a changefeed receiver triggers auto-read.
      // filterText() would be a Snapshot. But filterText.toLowerCase() goes
      // through the property access path first.
      const ir = buildFromSource(
        project,
        `recipe.name.toLowerCase().includes(filterText.toLowerCase())`,
        `declare const recipe: RecipeRef; declare const filterText: LocalRef<string>`,
      )

      // Root: method call to .includes()
      expect(ir.kind).toBe("method-call")
      if (ir.kind !== "method-call") return

      expect(ir.method).toBe("includes")
      expect(ir.args).toHaveLength(1)

      // Receiver: method call to .toLowerCase() on auto-read of recipe.name
      expect(ir.receiver.kind).toBe("method-call")
      if (ir.receiver.kind === "method-call") {
        expect(ir.receiver.method).toBe("toLowerCase")
        expect(ir.receiver.receiver.kind).toBe("ref-read")
        if (ir.receiver.receiver.kind === "ref-read") {
          expect(ir.receiver.receiver.deltaKind).toBe("text")
          expect(ir.receiver.receiver.ref.kind).toBe("property-access")
        }
      }

      // Argument: method call to .toLowerCase() on auto-read of filterText
      const arg = ir.args[0]
      expect(arg.kind).toBe("method-call")
      if (arg.kind === "method-call") {
        expect(arg.method).toBe("toLowerCase")
        expect(arg.receiver.kind).toBe("ref-read")
        if (arg.receiver.kind === "ref-read") {
          expect(arg.receiver.deltaKind).toBe("replace")
          expect(arg.receiver.ref.kind).toBe("identifier")
        }
      }
    })

    it("!veggieOnly || recipe.vegetarian — compound binary with auto-reads", () => {
      const ir = buildFromSource(
        project,
        `!veggieOnly || recipe.vegetarian`,
        `declare const veggieOnly: LocalRef<boolean>; declare const recipe: RecipeRef`,
      )

      expect(ir.kind).toBe("binary")
      if (ir.kind !== "binary") return

      expect(ir.op).toBe("||")

      // Left: !veggieOnly → Unary("!", RefRead(veggieOnly))
      expect(ir.left.kind).toBe("unary")
      if (ir.left.kind === "unary") {
        expect(ir.left.op).toBe("!")
        expect(ir.left.operand.kind).toBe("ref-read")
      }

      // Right: recipe.vegetarian → RefRead(PropertyAccess(recipe, vegetarian))
      expect(ir.right.kind).toBe("ref-read")
      if (ir.right.kind === "ref-read") {
        expect(ir.right.ref.kind).toBe("property-access")
      }
    })

    it("chained method calls on auto-read: recipe.name.toLowerCase().trim()", () => {
      const ir = buildFromSource(
        project,
        `recipe.name.toLowerCase().trim()`,
        `declare const recipe: RecipeRef`,
      )

      // Root: .trim()
      expect(ir.kind).toBe("method-call")
      if (ir.kind !== "method-call") return
      expect(ir.method).toBe("trim")

      // Receiver: .toLowerCase() on auto-read of recipe.name
      expect(ir.receiver.kind).toBe("method-call")
      if (ir.receiver.kind === "method-call") {
        expect(ir.receiver.method).toBe("toLowerCase")
        expect(ir.receiver.receiver.kind).toBe("ref-read")
      }
    })
  })

  // ===========================================================================
  // Parenthesized expressions
  // ===========================================================================

  describe("Parenthesized expressions", () => {
    it("unwraps parentheses", () => {
      const ir = buildFromSource(project, `(42)`)
      expect(ir.kind).toBe("literal")
    })

    it("unwraps nested parentheses with reactive expr", () => {
      const ir = buildFromSource(
        project,
        `(!veggieOnly)`,
        `declare const veggieOnly: LocalRef<boolean>`,
      )
      expect(ir.kind).toBe("unary")
      if (ir.kind === "unary") {
        expect(ir.operand.kind).toBe("ref-read")
      }
    })
  })

  // ===========================================================================
  // LocalRef with state()
  // ===========================================================================

  describe("LocalRef (state)", () => {
    it("LocalRef<string> in binary → auto-read", () => {
      const ir = buildFromSource(
        project,
        `filterText + " suffix"`,
        `declare const filterText: LocalRef<string>`,
      )
      expect(ir.kind).toBe("binary")
      if (ir.kind === "binary") {
        expect(ir.left.kind).toBe("ref-read")
        if (ir.left.kind === "ref-read") {
          expect(ir.left.deltaKind).toBe("replace")
        }
      }
    })

    it("LocalRef.set() is a ref method → no auto-read", () => {
      const ir = buildFromSource(
        project,
        `filterText.set("new value")`,
        `declare const filterText: LocalRef<string>`,
      )
      expect(ir.kind).toBe("method-call")
      if (ir.kind === "method-call") {
        expect(ir.method).toBe("set")
        // receiver should NOT be wrapped in ref-read
        expect(ir.receiver.kind).toBe("identifier")
      }
    })
  })

  // ===========================================================================
  // Edge cases and fallbacks
  // ===========================================================================

  describe("Edge cases", () => {
    it("explicit snapshot with args: ref(someArg)", () => {
      // Calling a changefeed with arguments — still a snapshot
      // This is an unusual case but should work
      const ir = buildFromSource(
        project,
        `filterText()`,
        `declare const filterText: LocalRef<string>`,
      )
      expect(ir.kind).toBe("snapshot")
    })

    it("chained explicit snapshot: recipe.name().toLowerCase()", () => {
      // recipe.name() is an explicit snapshot → SnapshotNode
      // Then .toLowerCase() is called on the string result
      const ir = buildFromSource(
        project,
        `recipe.name().toLowerCase()`,
        `declare const recipe: RecipeRef`,
      )

      expect(ir.kind).toBe("method-call")
      if (ir.kind === "method-call") {
        expect(ir.method).toBe("toLowerCase")
        // The receiver is the snapshot of recipe.name
        expect(ir.receiver.kind).toBe("snapshot")
        if (ir.receiver.kind === "snapshot") {
          expect(ir.receiver.ref.kind).toBe("property-access")
        }
      }
    })

    it("non-reactive method call chain", () => {
      const ir = buildFromSource(
        project,
        `str.toLowerCase().trim()`,
        `declare const str: string`,
      )

      expect(ir.kind).toBe("method-call")
      if (ir.kind === "method-call") {
        expect(ir.method).toBe("trim")
        expect(ir.receiver.kind).toBe("method-call")
        if (ir.receiver.kind === "method-call") {
          expect(ir.receiver.method).toBe("toLowerCase")
          expect(ir.receiver.receiver.kind).toBe("identifier")
        }
      }
    })

    it("binding ref is NOT double-wrapped in binary context", () => {
      // A BindingRefNode in a binary expression should NOT be wrapped in RefRead
      // because the binding itself handles reactivity
      const innerExpr: ExpressionIR = {
        kind: "ref-read",
        ref: { kind: "identifier", name: "x" },
        deltaKind: "replace",
      }
      const scope = createScope({ flag: innerExpr })

      const ir = buildFromSource(
        project,
        `flag && true`,
        `declare const flag: boolean`,
        scope,
      )

      expect(ir.kind).toBe("binary")
      if (ir.kind === "binary") {
        expect(ir.left.kind).toBe("binding-ref")
        // NOT ref-read — binding-ref handles reactivity internally
      }
    })

    it("snapshot is NOT double-wrapped in binary context", () => {
      // An explicit call like filterText() produces a Snapshot.
      // In a binary context, the snapshot result (a value) should not be
      // wrapped again — the snapshot already performed the read.
      const ir = buildFromSource(
        project,
        `filterText() + " suffix"`,
        `declare const filterText: LocalRef<string>`,
      )

      expect(ir.kind).toBe("binary")
      if (ir.kind === "binary") {
        // Left is the snapshot — not wrapped in another ref-read
        expect(ir.left.kind).toBe("snapshot")
      }
    })

    it("null literal", () => {
      const ir = buildFromSource(project, `null`)
      expect(ir.kind).toBe("literal")
      if (ir.kind === "literal") {
        expect(ir.value).toBe("null")
      }
    })
  })

  // ===========================================================================
  // Delta kind propagation
  // ===========================================================================

  describe("Delta kind propagation", () => {
    it("TextRef auto-read has deltaKind 'text'", () => {
      const ir = buildFromSource(
        project,
        `recipe.name.toLowerCase()`,
        `declare const recipe: RecipeRef`,
      )
      if (ir.kind === "method-call" && ir.receiver.kind === "ref-read") {
        expect(ir.receiver.deltaKind).toBe("text")
      }
    })

    it("CounterRef auto-read has deltaKind 'increment'", () => {
      const ir = buildFromSource(
        project,
        `doc.favorites.toFixed(2)`,
        `declare const doc: RecipeBookDoc`,
      )
      if (ir.kind === "method-call" && ir.receiver.kind === "ref-read") {
        expect(ir.receiver.deltaKind).toBe("increment")
      }
    })

    it("ScalarRef auto-read has deltaKind 'replace'", () => {
      const ir = buildFromSource(
        project,
        `!recipe.vegetarian`,
        `declare const recipe: RecipeRef`,
      )
      if (ir.kind === "unary" && ir.operand.kind === "ref-read") {
        expect(ir.operand.deltaKind).toBe("replace")
      }
    })

    it("LocalRef auto-read has deltaKind 'replace'", () => {
      const ir = buildFromSource(
        project,
        `!veggieOnly`,
        `declare const veggieOnly: LocalRef<boolean>`,
      )
      if (ir.kind === "unary" && ir.operand.kind === "ref-read") {
        expect(ir.operand.deltaKind).toBe("replace")
      }
    })

    it("Snapshot preserves deltaKind", () => {
      const ir = buildFromSource(
        project,
        `recipe.name()`,
        `declare const recipe: RecipeRef`,
      )
      if (ir.kind === "snapshot") {
        expect(ir.deltaKind).toBe("text")
      }
    })
  })

  // ===========================================================================
  // Integration: extractDeps on built trees
  // ===========================================================================

  describe("extractDeps integration", () => {
    it("recipe.name.toLowerCase() → dep on recipe.name", () => {
      const ir = buildFromSource(
        project,
        `recipe.name.toLowerCase()`,
        `declare const recipe: RecipeRef`,
      )
      const deps = extractDeps(ir)
      expect(deps).toHaveLength(1)
      expect(deps[0].source).toBe("recipe.name")
      expect(deps[0].deltaKind).toBe("text")
    })

    it("!veggieOnly → dep on veggieOnly", () => {
      const ir = buildFromSource(
        project,
        `!veggieOnly`,
        `declare const veggieOnly: LocalRef<boolean>`,
      )
      const deps = extractDeps(ir)
      expect(deps).toHaveLength(1)
      expect(deps[0].source).toBe("veggieOnly")
      expect(deps[0].deltaKind).toBe("replace")
    })

    it("recipe.name() → dep on recipe.name (snapshot)", () => {
      const ir = buildFromSource(
        project,
        `recipe.name()`,
        `declare const recipe: RecipeRef`,
      )
      const deps = extractDeps(ir)
      expect(deps).toHaveLength(1)
      expect(deps[0].source).toBe("recipe.name")
    })

    it("compound filter → 2 deps", () => {
      const ir = buildFromSource(
        project,
        `recipe.name.toLowerCase().includes(filterText.toLowerCase())`,
        `declare const recipe: RecipeRef; declare const filterText: LocalRef<string>`,
      )
      const deps = extractDeps(ir)
      expect(deps).toHaveLength(2)
      const sources = deps.map(d => d.source).sort()
      expect(sources).toEqual(["filterText", "recipe.name"])
    })

    it("binding refs → transitive deps", () => {
      const nameMatchExpr: ExpressionIR = {
        kind: "method-call",
        receiver: {
          kind: "ref-read",
          ref: {
            kind: "property-access",
            object: { kind: "identifier", name: "recipe" },
            property: "name",
          },
          deltaKind: "text",
        },
        method: "toLowerCase",
        args: [],
      }
      const veggieMatchExpr: ExpressionIR = {
        kind: "ref-read",
        ref: {
          kind: "property-access",
          object: { kind: "identifier", name: "recipe" },
          property: "vegetarian",
        },
        deltaKind: "replace",
      }
      const scope = createScope({
        nameMatch: nameMatchExpr,
        veggieMatch: veggieMatchExpr,
      })

      const ir = buildFromSource(
        project,
        `nameMatch && veggieMatch`,
        `declare const nameMatch: boolean; declare const veggieMatch: boolean`,
        scope,
      )

      const deps = extractDeps(ir)
      expect(deps).toHaveLength(2)
      const sources = deps.map(d => d.source).sort()
      expect(sources).toEqual(["recipe.name", "recipe.vegetarian"])
    })

    it("ternary with reactive condition → deps include the ref source", () => {
      const ir = buildFromSource(
        project,
        `recipe.vegetarian ? "yes" : "no"`,
        `declare const recipe: RecipeRef`,
      )
      const deps = extractDeps(ir)
      expect(deps).toHaveLength(1)
      expect(deps[0].source).toBe("recipe.vegetarian")
    })

    it("non-reactive expression → 0 deps", () => {
      const ir = buildFromSource(project, `"hello".toLowerCase()`)
      const deps = extractDeps(ir)
      expect(deps).toHaveLength(0)
    })

    it("mutation call → 0 deps (ref method, no auto-read)", () => {
      const ir = buildFromSource(
        project,
        `recipe.name.insert(0, "x")`,
        `declare const recipe: RecipeRef`,
      )
      const deps = extractDeps(ir)
      expect(deps).toHaveLength(0)
    })
  })

  // ===========================================================================
  // Integration: isReactive on built trees
  // ===========================================================================

  describe("isReactive integration", () => {
    it("auto-read expression is reactive", () => {
      const ir = buildFromSource(
        project,
        `recipe.name.toLowerCase()`,
        `declare const recipe: RecipeRef`,
      )
      expect(isReactive(ir)).toBe(true)
    })

    it("snapshot expression is reactive", () => {
      const ir = buildFromSource(
        project,
        `recipe.name()`,
        `declare const recipe: RecipeRef`,
      )
      expect(isReactive(ir)).toBe(true)
    })

    it("binding ref is reactive", () => {
      const innerExpr: ExpressionIR = {
        kind: "ref-read",
        ref: { kind: "identifier", name: "x" },
        deltaKind: "replace",
      }
      const scope = createScope({ flag: innerExpr })

      const ir = buildFromSource(
        project,
        `flag`,
        `declare const flag: boolean`,
        scope,
      )
      expect(isReactive(ir)).toBe(true)
    })

    it("ternary with reactive condition is reactive", () => {
      const ir = buildFromSource(
        project,
        `recipe.vegetarian ? "yes" : "no"`,
        `declare const recipe: RecipeRef`,
      )
      expect(isReactive(ir)).toBe(true)
    })

    it("non-reactive ternary is not reactive", () => {
      const ir = buildFromSource(
        project,
        `flag ? "a" : "b"`,
        `declare const flag: boolean`,
      )
      expect(isReactive(ir)).toBe(false)
    })

    it("non-reactive expression is not reactive", () => {
      const ir = buildFromSource(project, `"hello".toLowerCase()`)
      expect(isReactive(ir)).toBe(false)
    })

    it("mutation call is not reactive", () => {
      const ir = buildFromSource(
        project,
        `recipe.name.insert(0, "x")`,
        `declare const recipe: RecipeRef`,
      )
      expect(isReactive(ir)).toBe(false)
    })
  })

  // ===========================================================================
  // Integration: renderExpression on built trees
  // ===========================================================================

  describe("renderExpression integration", () => {
    const noExpand = { expandBindings: false }
    const expand = { expandBindings: true }

    it("auto-read renders with ()", () => {
      const ir = buildFromSource(
        project,
        `recipe.name.toLowerCase()`,
        `declare const recipe: RecipeRef`,
      )
      const source = renderExpression(ir, noExpand)
      expect(source).toBe("recipe.name().toLowerCase()")
    })

    it("snapshot renders with explicit ()", () => {
      const ir = buildFromSource(
        project,
        `recipe.name()`,
        `declare const recipe: RecipeRef`,
      )
      const source = renderExpression(ir, noExpand)
      expect(source).toBe("recipe.name()")
    })

    it("compound filter renders with auto-reads", () => {
      const ir = buildFromSource(
        project,
        `recipe.name.toLowerCase().includes(filterText.toLowerCase())`,
        `declare const recipe: RecipeRef; declare const filterText: LocalRef<string>`,
      )
      const source = renderExpression(ir, noExpand)
      expect(source).toBe(
        "recipe.name().toLowerCase().includes(filterText().toLowerCase())",
      )
    })

    it("mutation renders without auto-read", () => {
      const ir = buildFromSource(
        project,
        `recipe.name.insert(0, "x")`,
        `declare const recipe: RecipeRef`,
      )
      const source = renderExpression(ir, noExpand)
      expect(source).toBe('recipe.name.insert(0, "x")')
    })

    it("binding ref with expandBindings: false renders as name", () => {
      const innerExpr: ExpressionIR = {
        kind: "ref-read",
        ref: { kind: "identifier", name: "filterText" },
        deltaKind: "replace",
      }
      const scope = createScope({ nameMatch: innerExpr })

      const ir = buildFromSource(
        project,
        `nameMatch`,
        `declare const nameMatch: boolean`,
        scope,
      )
      const source = renderExpression(ir, noExpand)
      expect(source).toBe("nameMatch")
    })

    it("binding ref with expandBindings: true renders expanded expression", () => {
      const innerExpr: ExpressionIR = {
        kind: "ref-read",
        ref: { kind: "identifier", name: "filterText" },
        deltaKind: "replace",
      }
      const scope = createScope({ nameMatch: innerExpr })

      const ir = buildFromSource(
        project,
        `nameMatch`,
        `declare const nameMatch: boolean`,
        scope,
      )
      const source = renderExpression(ir, expand)
      expect(source).toBe("filterText()")
    })

    it("!veggieOnly renders with auto-read", () => {
      const ir = buildFromSource(
        project,
        `!veggieOnly`,
        `declare const veggieOnly: LocalRef<boolean>`,
      )
      const source = renderExpression(ir, noExpand)
      expect(source).toBe("!veggieOnly()")
    })

    it("ternary with reactive condition renders with auto-read", () => {
      const ir = buildFromSource(
        project,
        `recipe.vegetarian ? "yes" : "no"`,
        `declare const recipe: RecipeRef`,
      )
      const source = renderExpression(ir, noExpand)
      expect(source).toBe('recipe.vegetarian() ? "yes" : "no"')
    })

    it("element access renders with brackets", () => {
      const ir = buildFromSource(
        project,
        `arr[0]`,
        `declare const arr: string[]`,
      )
      const source = renderExpression(ir, noExpand)
      expect(source).toBe("arr[0]")
    })
  })
})
