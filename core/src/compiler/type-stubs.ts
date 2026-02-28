/**
 * Type Stubs for @loro-extended/change
 *
 * These type declarations are injected into the ts-morph in-memory filesystem
 * to enable type resolution for reactive detection.
 *
 * The Kinetic compiler uses `useInMemoryFileSystem: true` which means it
 * cannot resolve types from node_modules. By pre-loading these stubs,
 * imports like `import { createTypedDoc, Shape } from "@loro-extended/change"`
 * resolve correctly, and `isReactiveType()` can detect Loro ref types.
 *
 * Critically, these stubs model the Shape type parameter hierarchy:
 *
 *   Shape<Plain, Mutable, Draft, Placeholder>
 *     └─ DocShape<NestedShapes> maps each field's _mutable to the doc type
 *     └─ TextContainerShape has _mutable = TextRef
 *     └─ ListContainerShape<S> has _mutable = ListRef<S["_mutable"]>
 *     └─ etc.
 *
 * This enables zero-ceremony reactive detection:
 *
 *   const doc = createTypedDoc(TodoSchema)
 *   // doc.title resolves to TextRef → reactive ✓
 *   // doc.todos resolves to ListRef<...> → reactive ✓
 *
 * No explicit interface, no type annotation, no cast needed.
 *
 * @packageDocumentation
 */

/**
 * Enhanced type stubs for @loro-extended/change.
 *
 * Injected into the ts-morph Project's in-memory filesystem
 * at `node_modules/@loro-extended/change/index.d.ts`.
 */
export const LORO_CHANGE_TYPE_STUBS = `
// =============================================================================
// Core Shape Interface
// =============================================================================

export interface Shape<Plain, Mutable, Draft = Mutable, Placeholder = Plain> {
  readonly _type: string
  readonly _plain: Plain
  readonly _mutable: Mutable
  readonly _draft: Draft
  readonly _placeholder: Placeholder
}

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
  [Symbol.iterator](): Iterator<T>
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
// Container Shape Types
//
// Each container shape carries its ref type in the Mutable parameter.
// DocShape extracts _mutable from each field to build the typed doc.
// =============================================================================

export interface TextContainerShape
  extends Shape<string, TextRef, TextRef, string> {
  readonly _type: "text"
}

export interface CounterContainerShape
  extends Shape<number, CounterRef, CounterRef, number> {
  readonly _type: "counter"
}

export interface ListContainerShape<S extends Shape<any, any, any, any>>
  extends Shape<
    S["_plain"][],
    ListRef<S["_mutable"]>,
    ListRef<S["_draft"]>,
    S["_placeholder"][]
  > {
  readonly _type: "list"
}

export interface MovableListContainerShape<S extends Shape<any, any, any, any>>
  extends Shape<
    S["_plain"][],
    MovableListRef<S["_mutable"]>,
    MovableListRef<S["_draft"]>,
    S["_placeholder"][]
  > {
  readonly _type: "movableList"
}

export interface StructContainerShape<
  T extends Record<string, Shape<any, any, any, any>>
> extends Shape<
    { [K in keyof T]: T[K]["_plain"] },
    StructRef<{ [K in keyof T]: T[K]["_mutable"] }>,
    { [K in keyof T]: T[K]["_draft"] },
    { [K in keyof T]: T[K]["_placeholder"] }
  > {
  readonly _type: "struct"
}

export interface RecordContainerShape<S extends Shape<any, any, any, any>>
  extends Shape<
    Record<string, S["_plain"]>,
    RecordRef<Record<string, S["_mutable"]>>,
    Record<string, S["_draft"]>,
    Record<string, S["_placeholder"]>
  > {
  readonly _type: "record"
}

// =============================================================================
// Value Shape Types
//
// Value shapes wrap primitives. Their Mutable type is PlainValueRef<T>.
// =============================================================================

export interface StringValueShape<T extends string = string>
  extends Shape<T, PlainValueRef<T>, T, T> {
  readonly _type: "string"
  placeholder(value: T): StringValueShape<T>
}

export interface NumberValueShape<T extends number = number>
  extends Shape<T, PlainValueRef<T>, T, T> {
  readonly _type: "number"
  placeholder(value: T): NumberValueShape<T>
}

export interface BooleanValueShape<T extends boolean = boolean>
  extends Shape<T, PlainValueRef<T>, T, T> {
  readonly _type: "boolean"
  placeholder(value: T): BooleanValueShape<T>
}

export interface StructValueShape<
  T extends Record<string, Shape<any, any, any, any>>
> extends Shape<
    { [K in keyof T]: T[K]["_plain"] },
    { [K in keyof T]: T[K]["_mutable"] },
    { [K in keyof T]: T[K]["_draft"] },
    { [K in keyof T]: T[K]["_placeholder"] }
  > {
  readonly _type: "plainStruct"
}

// =============================================================================
// Doc Shape
//
// DocShape maps each field's _mutable to build the typed document interface.
// This is the key type that makes zero-ceremony work:
//   Shape.doc({ title: Shape.text() })
//     → DocShape<{ title: TextContainerShape }>
//     → _mutable = { title: TextRef }
// =============================================================================

type ContainerShape =
  | TextContainerShape
  | CounterContainerShape
  | ListContainerShape<any>
  | MovableListContainerShape<any>
  | StructContainerShape<any>
  | RecordContainerShape<any>

export interface DocShape<
  NestedShapes extends Record<string, ContainerShape> = Record<
    string,
    ContainerShape
  >
> extends Shape<
    { [K in keyof NestedShapes]: NestedShapes[K]["_plain"] },
    { [K in keyof NestedShapes]: NestedShapes[K]["_mutable"] },
    { [K in keyof NestedShapes]: NestedShapes[K]["_draft"] },
    { [K in keyof NestedShapes]: NestedShapes[K]["_placeholder"] }
  > {
  readonly _type: "doc"
  readonly shapes: NestedShapes
  readonly mergeable?: boolean
}

// =============================================================================
// Type Inference
// =============================================================================

export type InferMutableType<T> = T extends Shape<any, infer M, any, any>
  ? M
  : never

export type TypedDoc<S extends DocShape> = InferMutableType<S> & {
  toJSON(): S["_plain"]
}

// =============================================================================
// Shape Builders
// =============================================================================

export declare const Shape: {
  doc<T extends Record<string, ContainerShape>>(
    schema: T,
    options?: { mergeable?: boolean },
  ): DocShape<T>
  text(): TextContainerShape
  counter(): CounterContainerShape
  list<S extends Shape<any, any, any, any>>(itemShape: S): ListContainerShape<S>
  movableList<S extends Shape<any, any, any, any>>(
    itemShape: S,
  ): MovableListContainerShape<S>
  struct<T extends Record<string, Shape<any, any, any, any>>>(
    schema: T,
  ): StructContainerShape<T>
  record<S extends Shape<any, any, any, any>>(
    valueShape: S,
  ): RecordContainerShape<S>
  plain: {
    string(): StringValueShape<string>
    number(): NumberValueShape<number>
    boolean(): BooleanValueShape<boolean>
    struct<T extends Record<string, Shape<any, any, any, any>>>(
      schema: T,
    ): StructValueShape<T>
  }
}

// =============================================================================
// Document Creation
// =============================================================================

export declare function createTypedDoc<S extends DocShape>(
  schema: S,
  options?: { doc?: unknown; skipInitialize?: boolean; mergeable?: boolean },
): TypedDoc<S>

// =============================================================================
// Utility Functions
// =============================================================================

export declare function loro<T>(ref: T): unknown
export declare function ext<T>(ref: T): unknown
`
