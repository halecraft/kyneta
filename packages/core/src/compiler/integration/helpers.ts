/**
 * Shared helpers for compiler → runtime integration tests.
 *
 * Provides:
 * - JSDOM setup and globals
 * - CHANGEFEED-based type stubs for compiler source strings
 * - compile-and-execute utilities
 * - Mock infrastructure for reactive refs
 */

import {
  CHANGEFEED,
  type ChangeBase,
  type Changeset,
  type Changefeed,
  type SequenceChangeOp,
  type TextChangeOp,
  replaceChange,
  incrementChange,
} from "@kyneta/schema"
import { JSDOM } from "jsdom"
import ts from "typescript"

import {
  conditionalRegion,
  inputTextRegion,
  listRegion,
  read,
  subscribe,
  textRegion,
  valueRegion,
  Scope,
} from "../../runtime/index.js"
import {
  activeSubscriptions,
  getActiveSubscriptionCount,
  resetSubscriptionIdCounter,
  resetScopeIdCounter,
  setRootScope,
  assertMaxMutations,
  createCountingContainer,
} from "../../testing/index.js"
import {
  mergeImports,
  transformSource,
  transformSourceInPlace,
} from "../transform.js"
import type { ListRefLike } from "../../runtime/regions.js"

// =============================================================================
// Re-exports for test convenience
// =============================================================================

export {
  CHANGEFEED,
  type ChangeBase,
  type Changefeed,
  type SequenceChangeOp,
  type TextChangeOp,
  replaceChange,
}
export {
  conditionalRegion,
  inputTextRegion,
  listRegion,
  read,
  subscribe,
  textRegion,
  valueRegion,
  Scope,
}
export {
  activeSubscriptions,
  getActiveSubscriptionCount,
  resetSubscriptionIdCounter,
  resetScopeIdCounter,
  setRootScope,
  assertMaxMutations,
  createCountingContainer,
}
export { mergeImports, transformSource, transformSourceInPlace }
export type { ListRefLike }

// =============================================================================
// DOM Setup
// =============================================================================

export const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>")

/**
 * Install JSDOM globals. Call once at module scope in each test file.
 */
export function installDOMGlobals(): void {
  global.document = dom.window.document
  global.Node = dom.window.Node
  global.Element = dom.window.Element
  global.Comment = dom.window.Comment
  global.Text = dom.window.Text
  global.Event = dom.window.Event
  global.HTMLInputElement = dom.window.HTMLInputElement
}

// =============================================================================
// CHANGEFEED Type Stubs
// =============================================================================

/**
 * Inline type declarations for CHANGEFEED-based ref types.
 *
 * Integration tests use `transformSource()` which resolves modules from the
 * real filesystem. Test source strings declare their types inline. This
 * provides stubs that mirror the schema's CHANGEFEED protocol with narrow
 * change types for proper deltaKind extraction.
 */
export const CHANGEFEED_TYPE_STUBS = `
import { CHANGEFEED, type Changefeed, type HasChangefeed } from "@kyneta/schema"

type TextChange = { readonly type: "text"; readonly ops: readonly TextChangeOp[] }
type TextChangeOp = { readonly retain: number } | { readonly insert: string } | { readonly delete: number }
type SequenceChange<T = unknown> = { readonly type: "sequence"; readonly ops: readonly SequenceChangeOp<T>[] }
type SequenceChangeOp<T = unknown> = { readonly retain: number } | { readonly insert: readonly T[] } | { readonly delete: number }
type MapChange = { readonly type: "map"; readonly set?: Record<string, unknown>; readonly delete?: readonly string[] }
type ReplaceChange<T = unknown> = { readonly type: "replace"; readonly value: T }
type IncrementChange = { readonly type: "increment"; readonly amount: number }

interface TextRef extends HasChangefeed<string, TextChange> {
  (): string
  readonly [CHANGEFEED]: Changefeed<string, TextChange>
  insert(pos: number, text: string): void
  delete(pos: number, len: number): void
  [Symbol.toPrimitive](hint: string): string
}

interface CounterRef extends HasChangefeed<number, IncrementChange> {
  (): number
  readonly [CHANGEFEED]: Changefeed<number, IncrementChange>
  increment(n: number): void
  decrement(n: number): void
  [Symbol.toPrimitive](hint: string): number | string
}

interface ListRef<T> extends HasChangefeed<T[], SequenceChange<T>> {
  (): T[]
  readonly [CHANGEFEED]: Changefeed<T[], SequenceChange<T>>
  readonly length: number
  at(index: number): T | undefined
  get(index: number): T | undefined
  push(item: T): void
  insert(index: number, item: T): void
  delete(index: number, len?: number): void
  [Symbol.iterator](): Iterator<T>
}

interface StructRef<T> extends HasChangefeed<T, MapChange> {
  (): T
  readonly [CHANGEFEED]: Changefeed<T, MapChange>
}
`

/**
 * Wrap source code with the inline type stubs.
 * Use when a test source string needs TextRef, CounterRef, ListRef, etc.
 */
export function withTypes(source: string): string {
  return CHANGEFEED_TYPE_STUBS + "\n" + source
}

// =============================================================================
// Compile & Execute Utilities
// =============================================================================

/**
 * Execute generated DOM code and return the created element.
 *
 * The generated code is wrapped in a function that takes a scope parameter.
 * We create a scope and call the function to get the DOM element.
 */
export function executeGeneratedCode(code: string, scope: Scope): Node {
  // biome-ignore lint/security/noGlobalEval: test utility
  const fn = eval(`(${code})`)
  return fn(scope)
}

/**
 * Compile source and execute it, returning the DOM element.
 */
export function compileAndExecute(source: string): {
  node: Node
  scope: Scope
} {
  const result = transformSource(source, { target: "dom" })

  if (result.ir.length === 0) {
    throw new Error("No builder calls found in source")
  }

  const code = result.code

  const assignmentMatch = code.match(/const element\d+ = /)
  if (!assignmentMatch || assignmentMatch.index === undefined) {
    throw new Error(
      `Could not find element definition in generated code:\n${code}`,
    )
  }

  const startIndex = assignmentMatch.index + assignmentMatch[0].length
  const fnCode = code.slice(startIndex).trim()

  const scope = new Scope()
  const node = executeGeneratedCode(fnCode, scope)

  return { node, scope }
}

/**
 * Compile source in-place and return executable JS.
 *
 * Uses transformSourceInPlace to preserve the full source (component
 * definitions + usage sites), mergeImports to add runtime imports,
 * ts.transpileModule to strip TypeScript syntax, and a line filter
 * to remove import statements (eval doesn't support ES imports;
 * runtime symbols are provided by the caller via `new Function`).
 */
export function compileInPlace(
  source: string,
  target: "dom" | "html" = "dom",
): string {
  const result = transformSourceInPlace(source, { target })
  mergeImports(result.sourceFile, result.requiredImports)
  const fullTs = result.sourceFile.getFullText()

  const { outputText } = ts.transpileModule(fullTs, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
  })

  return outputText
    .split("\n")
    .filter(line => !line.trimStart().startsWith("import "))
    .join("\n")
}

/**
 * Wrap source so the last top-level builder call is assigned to a variable.
 */
export function wrapLastBuilder(source: string): string {
  const lines = source.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trimStart()
    if (/^[a-z]\w*\s*\(\s*(\{[^}]*\}\s*,\s*)?\(\)\s*=>\s*\{/.test(trimmed)) {
      const indent = lines[i].length - trimmed.length
      lines[i] = " ".repeat(indent) + "const __lastBuilder = " + trimmed
      return lines.join("\n")
    }
  }
  return source
}

/**
 * Runtime dependencies injected into compiled component code via
 * `new Function` parameters.
 */
export function getRuntimeDeps(): Record<string, unknown> {
  return {
    subscribe,
    valueRegion,
    read,
    listRegion,
    conditionalRegion,
    textRegion,
    inputTextRegion,
    Scope,
    document,
  }
}
export function getRuntimeDepNames(): string[] {
  return Object.keys(getRuntimeDeps())
}
export function getRuntimeDepValues(): unknown[] {
  return Object.values(getRuntimeDeps())
}

/**
 * Compile source in-place and execute the last builder factory.
 */
export function compileAndExecuteComponent(
  source: string,
): { node: Node; scope: Scope } {
  const wrapped = wrapLastBuilder(source)
  const js = compileInPlace(wrapped)

  const body = `${js}\nreturn __lastBuilder;`
  const fn = new Function(...getRuntimeDepNames(), body)
  const factory = fn(...getRuntimeDepValues()) as (scope: Scope) => Node

  const scope = new Scope()
  const node = factory(scope)
  return { node, scope }
}

/**
 * ComponentFactory and Element type preamble for ts-morph resolution.
 */
export const COMPONENT_PREAMBLE = `
type Element = (scope: any) => Node
type ComponentFactory<P extends Record<string, unknown> = {}> =
  | ((props: P, builder: () => void) => Element)
  | ((props: P) => Element)
  | ((builder: () => void) => Element)
  | (() => Element)
`

// =============================================================================
// Standard beforeEach for integration tests
// =============================================================================

/**
 * Standard reset for integration test `beforeEach` blocks.
 */
export function resetTestState(): void {
  resetScopeIdCounter()
  resetSubscriptionIdCounter()
  activeSubscriptions.clear()
  setRootScope(null)
}

// =============================================================================
// Mock Reactive Infrastructure
// =============================================================================

/**
 * A mock text ref with CHANGEFEED protocol.
 *
 * Provides `.insert()`, `.delete()` and emits text changes via CHANGEFEED.
 */
export function createMockTextRef(initial: string = ""): {
  ref: {
    insert(pos: number, text: string): void
    delete(pos: number, len: number): void
    readonly [CHANGEFEED]: Changefeed<string, ChangeBase>
  }
  /** Access current value */
  value(): string
} {
  let content = initial
  const subscribers = new Set<(changeset: Changeset<ChangeBase>) => void>()

  const ref = {
    insert(pos: number, text: string): void {
      content = content.slice(0, pos) + text + content.slice(pos)
      const ops: TextChangeOp[] = []
      if (pos > 0) ops.push({ retain: pos })
      ops.push({ insert: text })
      const changeset: Changeset<ChangeBase> = {
        changes: [{ type: "text", ops } as ChangeBase],
        origin: "local",
      }
      for (const cb of subscribers) {
        cb(changeset)
      }
    },
    delete(pos: number, len: number): void {
      content = content.slice(0, pos) + content.slice(pos + len)
      const ops: TextChangeOp[] = []
      if (pos > 0) ops.push({ retain: pos })
      ops.push({ delete: len })
      const changeset: Changeset<ChangeBase> = {
        changes: [{ type: "text", ops } as ChangeBase],
        origin: "local",
      }
      for (const cb of subscribers) {
        cb(changeset)
      }
    },

    get [CHANGEFEED](): Changefeed<string, ChangeBase> {
      return {
        get current(): string {
          return content
        },
        subscribe(cb: (changeset: Changeset<ChangeBase>) => void): () => void {
          subscribers.add(cb)
          return () => {
            subscribers.delete(cb)
          }
        },
      }
    },
  }

  return {
    ref,
    value: () => content,
  }
}

/**
 * A mock counter ref with CHANGEFEED protocol.
 *
 * Provides `.get()`, `.increment()` and emits increment changes.
 * Replaces the old `Shape.counter()` pattern.
 */
export function createMockCounterRef(initial: number = 0): {
  ref: {
    get(): number
    increment(n: number): void
    readonly [CHANGEFEED]: Changefeed<number, ChangeBase>
  }
} {
  let count = initial
  const subscribers = new Set<(changeset: Changeset<ChangeBase>) => void>()

  const ref = {
    get(): number {
      return count
    },
    increment(n: number): void {
      count += n
      const change = incrementChange(n) as ChangeBase
      const changeset: Changeset<ChangeBase> = { changes: [change] }
      for (const cb of subscribers) {
        cb(changeset)
      }
    },
    get [CHANGEFEED](): Changefeed<number, ChangeBase> {
      return {
        get current(): number {
          return count
        },
        subscribe(cb: (changeset: Changeset<ChangeBase>) => void): () => void {
          subscribers.add(cb)
          return () => {
            subscribers.delete(cb)
          }
        },
      }
    },
  }

  return { ref }
}

/**
 * A mock sequence (list) ref with CHANGEFEED protocol.
 *
 * Provides `.push()`, `.insert()`, `.delete()`, `.at()`, `.get()`, `.length`,
 * `[Symbol.iterator]`, and emits sequence changes. Replaces the old
 * `Shape.list()` pattern.
 */
export function createMockSequenceRef<T>(initialItems: T[]): {
  ref: ListRefLike<T> & {
    push(item: T): void
    insert(index: number, item: T): void
    delete(index: number, len?: number): void
    get(index: number): T | undefined
    set(index: number, value: T): void
    toArray(): T[]
    entries(): IterableIterator<[number, T]>
    readonly [CHANGEFEED]: Changefeed<T[], ChangeBase>
    [Symbol.iterator](): Iterator<T>
  }
  /** Manually emit a change (bypasses mutation methods) */
  emit: (change: ChangeBase) => void
  /** Replace the backing array */
  setItems: (items: T[]) => void
} {
  let items = [...initialItems]
  const subscribers = new Set<(changeset: Changeset<ChangeBase>) => void>()

  function emitChange(change: ChangeBase): void {
    const changeset: Changeset<ChangeBase> = { changes: [change] }
    for (const cb of subscribers) {
      cb(changeset)
    }
  }

  const ref = {
    get length() {
      return items.length
    },
    at(index: number): T | undefined {
      return items[index]
    },
    get(index: number): T | undefined {
      return items[index]
    },
    set(index: number, value: T): void {
      items[index] = value
    },
    push(item: T): void {
      const index = items.length
      items.push(item)
      const ops: SequenceChangeOp<T>[] = []
      if (index > 0) ops.push({ retain: index })
      ops.push({ insert: [item] })
      emitChange({ type: "sequence", ops } as ChangeBase)
    },
    insert(index: number, item: T): void {
      items.splice(index, 0, item)
      const ops: SequenceChangeOp<T>[] = []
      if (index > 0) ops.push({ retain: index })
      ops.push({ insert: [item] })
      emitChange({ type: "sequence", ops } as ChangeBase)
    },
    delete(index: number, len: number = 1): void {
      items.splice(index, len)
      const ops: SequenceChangeOp<T>[] = []
      if (index > 0) ops.push({ retain: index })
      ops.push({ delete: len })
      emitChange({ type: "sequence", ops } as ChangeBase)
    },
    toArray(): T[] {
      return [...items]
    },
    *entries(): IterableIterator<[number, T]> {
      for (let i = 0; i < items.length; i++) {
        yield [i, items[i]]
      }
    },
    [Symbol.iterator](): Iterator<T> {
      let i = 0
      return {
        next(): IteratorResult<T> {
          if (i < items.length) {
            return { value: items[i++], done: false }
          }
          return { value: undefined as unknown as T, done: true }
        },
      }
    },
    get [CHANGEFEED](): Changefeed<T[], ChangeBase> {
      return {
        get current(): T[] {
          return items
        },
        subscribe(cb: (changeset: Changeset<ChangeBase>) => void): () => void {
          subscribers.add(cb)
          return () => {
            subscribers.delete(cb)
          }
        },
      }
    },
  }

  return {
    ref,
    emit: emitChange,
    setItems: (newItems: T[]) => {
      items = [...newItems]
    },
  }
}

/**
 * Create a mock "typed doc" — a plain object with mock refs as properties,
 * plus a top-level CHANGEFEED for detection.
 *
 * This replaces the old `createTypedDoc(schema)` pattern. Each field is
 * a mock ref; the doc itself has [CHANGEFEED] so the compiler can detect it.
 */
export function createMockDoc<T extends Record<string, { [CHANGEFEED]: Changefeed<unknown, ChangeBase> }>>(
  fields: T,
): T & { readonly [CHANGEFEED]: Changefeed<unknown, ChangeBase> } {
  const subscribers = new Set<(changeset: Changeset<ChangeBase>) => void>()

  return Object.assign(Object.create(null), fields, {
    get [CHANGEFEED](): Changefeed<unknown, ChangeBase> {
      return {
        get current(): unknown {
          return fields
        },
        subscribe(cb: (changeset: Changeset<ChangeBase>) => void): () => void {
          subscribers.add(cb)
          return () => {
            subscribers.delete(cb)
          }
        },
      }
    },
  })
}

/**
 * Create a mock "plain value ref" — wraps a value with get/set and CHANGEFEED.
 *
 * This replaces the old `Shape.plain.string()` / `Shape.plain.number()` items
 * used inside lists. The ref has `.get()` and `.set()` like PlainValueRef.
 */
export function createMockPlainRef<T>(initial: T): {
  ref: {
    get(): T
    set(value: T): void
    readonly [CHANGEFEED]: Changefeed<T, ChangeBase>
  }
} {
  let value = initial
  const subscribers = new Set<(changeset: Changeset<ChangeBase>) => void>()

  const ref = {
    get(): T {
      return value
    },
    set(v: T): void {
      value = v
      const changeset: Changeset<ChangeBase> = { changes: [replaceChange(v) as ChangeBase] }
      for (const cb of subscribers) {
        cb(changeset)
      }
    },
    get [CHANGEFEED](): Changefeed<T, ChangeBase> {
      return {
        get current(): T {
          return value
        },
        subscribe(cb: (changeset: Changeset<ChangeBase>) => void): () => void {
          subscribers.add(cb)
          return () => {
            subscribers.delete(cb)
          }
        },
      }
    },
  }

  return { ref }
}