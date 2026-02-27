/**
 * Type Stubs for @loro-extended/change
 *
 * These minimal type declarations are injected into the ts-morph in-memory
 * filesystem to enable type resolution for reactive detection.
 *
 * The Kinetic compiler uses `useInMemoryFileSystem: true` which means it
 * cannot resolve types from node_modules. By pre-loading these stubs,
 * imports like `import { ListRef } from "@loro-extended/change"` resolve
 * correctly, and `isReactiveType()` can detect Loro ref types.
 *
 * These stubs only need interface names and method signatures — just enough
 * for the TypeScript type checker to identify reactive types. Implementation
 * details are not needed.
 *
 * @packageDocumentation
 */

/**
 * Minimal type stubs for @loro-extended/change.
 *
 * This string is injected into the ts-morph Project's in-memory filesystem
 * at `node_modules/@loro-extended/change/index.d.ts`.
 */
export const LORO_CHANGE_TYPE_STUBS = `
// =============================================================================
// Ref Types (used for reactive detection)
// =============================================================================

export interface TextRef {
  toString(): string
  insert(pos: number, text: string): void
  delete(pos: number, len: number): void
}

export interface CounterRef {
  get(): number
  increment(delta?: number): void
  decrement(delta?: number): void
}

export interface ListRef<T> {
  toArray(): T[]
  push(item: T): void
  insert(index: number, item: T): void
  delete(index: number, len?: number): void
  get(index: number): T | undefined
}

export interface MovableListRef<T> extends ListRef<T> {
  move(from: number, to: number): void
}

export interface RecordRef<T> {
  get<K extends keyof T>(key: K): T[K]
  set<K extends keyof T>(key: K, value: T[K]): void
}

export interface StructRef<T> {
  readonly [K in keyof T]: T[K]
}

export interface MapRef<K extends string, V> {
  get(key: K): V | undefined
  set(key: K, value: V): void
  delete(key: K): void
  keys(): K[]
}

export interface TreeRef<T> {
  roots(): T[]
}

export interface PlainValueRef<T> {
  get(): T
  set(value: T): void
}

// =============================================================================
// Schema Builders
// =============================================================================

export interface StringValueShape<T = string> {
  placeholder(value: T): StringValueShape<T>
}

export interface NumberValueShape<T = number> {
  placeholder(value: T): NumberValueShape<T>
}

export interface BooleanValueShape<T = boolean> {
  placeholder(value: T): BooleanValueShape<T>
}

export declare const Shape: {
  doc<T extends Record<string, unknown>>(schema: T): T
  text(): TextRef
  counter(): CounterRef
  list<T>(itemShape: T): ListRef<T>
  movableList<T>(itemShape: T): MovableListRef<T>
  record<T>(): RecordRef<T>
  struct<T extends Record<string, unknown>>(schema: T): StructRef<T>
  map<K extends string, V>(keyShape: K, valueShape: V): MapRef<K, V>
  tree<T>(): TreeRef<T>
  plain: {
    string(): StringValueShape<string>
    number(): NumberValueShape<number>
    boolean(): BooleanValueShape<boolean>
  }
}

// =============================================================================
// Document Creation
// =============================================================================

export declare function createTypedDoc<T>(
  schema: T,
  options?: { doc?: unknown; skipInitialize?: boolean }
): T

// =============================================================================
// Utility Functions
// =============================================================================

export declare function loro<T>(ref: T): unknown
export declare function ext<T>(ref: T): unknown
`
