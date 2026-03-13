/**
 * Ambient Element Factory Type Declarations
 *
 * These types define the element factories (div, span, h1, etc.) that users
 * write in their source code. They exist ONLY for TypeScript type checking -
 * there is no runtime implementation.
 *
 * The Kinetic compiler transforms calls to these factories into direct DOM
 * manipulation code. For example:
 *
 *   div(() => { h1("Hello") })
 *
 * Becomes:
 *
 *   const _div = document.createElement("div")
 *   const _h1 = document.createElement("h1")
 *   _h1.textContent = "Hello"
 *   _div.appendChild(_h1)
 *
 * Usage:
 *   Add to your source file:
 *   /// <reference types="@kyneta/core/types/elements" />
 *
 * @packageDocumentation
 */

import type { Binding, Builder, Child, Element, Props } from "../types.js"

// =============================================================================
// Element Factory Type
// =============================================================================

/**
 * Props that may contain Binding values.
 * Extends Props to allow bind() in value/checked properties.
 *
 * **Known limitation:** Reactive attribute values (e.g., `{ class: doc.className }`
 * where `doc.className` is `PlainValueRef<string>`) are not yet supported.
 * Attribute values must be plain strings, functions, or Binding values.
 * Reactive attribute support is a future consideration.
 */
type PropsWithBindings = Omit<Props, "value" | "checked"> & {
  value?: string | (() => string) | Binding<unknown>
  checked?: boolean | (() => boolean) | Binding<unknown>
}

/**
 * Factory function for creating elements.
 *
 * Supports multiple calling patterns:
 * - `div(() => { ... })` - Builder only
 * - `div({ class: "x" }, () => { ... })` - Props + builder
 * - `div("text", span("nested"))` - Children only
 * - `div({ class: "x" }, "text")` - Props + children
 *
 * Overload order matters for TypeScript resolution:
 * 1. Props overloads first (more specific)
 * 2. Non-props overloads last (catch-all)
 */
interface ElementFactory {
  /** Props + builder pattern */
  (props: PropsWithBindings, builder: Builder): Element
  /** Props + children pattern */
  (props: PropsWithBindings, ...children: Child[]): Element
  /** Props only pattern */
  (props: PropsWithBindings): Element
  /** Builder pattern - enables control flow */
  (builder: Builder): Element
  /** Children only pattern */
  (...children: Child[]): Element
}

// =============================================================================
// Global Declarations
// =============================================================================

declare global {
  // Document Structure Elements
  const html: ElementFactory
  const head: ElementFactory
  const body: ElementFactory
  const title: ElementFactory
  const meta: ElementFactory
  const link: ElementFactory
  const script: ElementFactory
  const style: ElementFactory
  const base: ElementFactory

  // Sectioning Elements
  const header: ElementFactory
  const footer: ElementFactory
  const main: ElementFactory
  const nav: ElementFactory
  const aside: ElementFactory
  const section: ElementFactory
  const article: ElementFactory
  const address: ElementFactory

  // Content Grouping Elements
  const div: ElementFactory
  const p: ElementFactory
  const hr: ElementFactory
  const pre: ElementFactory
  const blockquote: ElementFactory
  const figure: ElementFactory
  const figcaption: ElementFactory

  // Text Content Elements
  const h1: ElementFactory
  const h2: ElementFactory
  const h3: ElementFactory
  const h4: ElementFactory
  const h5: ElementFactory
  const h6: ElementFactory
  const span: ElementFactory
  const a: ElementFactory
  const em: ElementFactory
  const strong: ElementFactory
  const small: ElementFactory
  const s: ElementFactory
  const cite: ElementFactory
  const q: ElementFactory
  const dfn: ElementFactory
  const abbr: ElementFactory
  const code: ElementFactory
  const samp: ElementFactory
  const kbd: ElementFactory
  const sub: ElementFactory
  const sup: ElementFactory
  const i: ElementFactory
  const b: ElementFactory
  const u: ElementFactory
  const mark: ElementFactory
  const ruby: ElementFactory
  const rt: ElementFactory
  const rp: ElementFactory
  const bdi: ElementFactory
  const bdo: ElementFactory
  const br: ElementFactory
  const wbr: ElementFactory

  // List Elements
  const ul: ElementFactory
  const ol: ElementFactory
  const li: ElementFactory
  const dl: ElementFactory
  const dt: ElementFactory
  const dd: ElementFactory

  // Table Elements
  const table: ElementFactory
  const caption: ElementFactory
  const colgroup: ElementFactory
  const col: ElementFactory
  const thead: ElementFactory
  const tbody: ElementFactory
  const tfoot: ElementFactory
  const tr: ElementFactory
  const th: ElementFactory
  const td: ElementFactory

  // Form Elements
  const form: ElementFactory
  const label: ElementFactory
  const input: ElementFactory
  const button: ElementFactory
  const select: ElementFactory
  const datalist: ElementFactory
  const optgroup: ElementFactory
  const option: ElementFactory
  const textarea: ElementFactory
  const output: ElementFactory
  const progress: ElementFactory
  const meter: ElementFactory
  const fieldset: ElementFactory
  const legend: ElementFactory

  // Interactive Elements
  const details: ElementFactory
  const summary: ElementFactory
  const dialog: ElementFactory

  // Media Elements
  const img: ElementFactory
  const picture: ElementFactory
  const source: ElementFactory
  const video: ElementFactory
  const audio: ElementFactory
  const track: ElementFactory
  const map: ElementFactory
  const area: ElementFactory
  const iframe: ElementFactory
  const embed: ElementFactory
  const object: ElementFactory
  const param: ElementFactory
  const canvas: ElementFactory
  const svg: ElementFactory

  // Miscellaneous Elements
  const template: ElementFactory
  const slot: ElementFactory
  const noscript: ElementFactory
}

// Export to make this a module (required for declare global to work)
export { ElementFactory }
