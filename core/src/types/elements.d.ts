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
 * @packageDocumentation
 */

import type { Builder, Child, Element, Props } from "../types.js"

// =============================================================================
// Element Factory Type
// =============================================================================

/**
 * Factory function for creating elements.
 *
 * Supports multiple calling patterns:
 * - `div(() => { ... })` - Builder only
 * - `div({ class: "x" }, () => { ... })` - Props + builder
 * - `div("text", span("nested"))` - Children only
 * - `div({ class: "x" }, "text")` - Props + children
 */
interface ElementFactory {
  /** Builder pattern - enables control flow */
  (builder: Builder): Element
  /** Props + builder pattern */
  (props: Props, builder: Builder): Element
  /** Props + children pattern */
  (props: Props, ...children: Child[]): Element
  /** Children only pattern */
  (...children: Child[]): Element
}

// =============================================================================
// Document Structure Elements
// =============================================================================

declare const html: ElementFactory
declare const head: ElementFactory
declare const body: ElementFactory
declare const title: ElementFactory
declare const meta: ElementFactory
declare const link: ElementFactory
declare const script: ElementFactory
declare const style: ElementFactory
declare const base: ElementFactory

// =============================================================================
// Sectioning Elements
// =============================================================================

declare const header: ElementFactory
declare const footer: ElementFactory
declare const main: ElementFactory
declare const nav: ElementFactory
declare const aside: ElementFactory
declare const section: ElementFactory
declare const article: ElementFactory
declare const address: ElementFactory

// =============================================================================
// Content Grouping Elements
// =============================================================================

declare const div: ElementFactory
declare const p: ElementFactory
declare const hr: ElementFactory
declare const pre: ElementFactory
declare const blockquote: ElementFactory
declare const figure: ElementFactory
declare const figcaption: ElementFactory

// =============================================================================
// Text Content Elements
// =============================================================================

declare const h1: ElementFactory
declare const h2: ElementFactory
declare const h3: ElementFactory
declare const h4: ElementFactory
declare const h5: ElementFactory
declare const h6: ElementFactory
declare const span: ElementFactory
declare const a: ElementFactory
declare const em: ElementFactory
declare const strong: ElementFactory
declare const small: ElementFactory
declare const s: ElementFactory
declare const cite: ElementFactory
declare const q: ElementFactory
declare const dfn: ElementFactory
declare const abbr: ElementFactory
declare const code: ElementFactory
declare const samp: ElementFactory
declare const kbd: ElementFactory
declare const sub: ElementFactory
declare const sup: ElementFactory
declare const i: ElementFactory
declare const b: ElementFactory
declare const u: ElementFactory
declare const mark: ElementFactory
declare const ruby: ElementFactory
declare const rt: ElementFactory
declare const rp: ElementFactory
declare const bdi: ElementFactory
declare const bdo: ElementFactory
declare const br: ElementFactory
declare const wbr: ElementFactory

// Note: `var` is a reserved keyword, use `variable` or skip
// declare const var: ElementFactory

// =============================================================================
// List Elements
// =============================================================================

declare const ul: ElementFactory
declare const ol: ElementFactory
declare const li: ElementFactory
declare const dl: ElementFactory
declare const dt: ElementFactory
declare const dd: ElementFactory

// =============================================================================
// Table Elements
// =============================================================================

declare const table: ElementFactory
declare const caption: ElementFactory
declare const colgroup: ElementFactory
declare const col: ElementFactory
declare const thead: ElementFactory
declare const tbody: ElementFactory
declare const tfoot: ElementFactory
declare const tr: ElementFactory
declare const th: ElementFactory
declare const td: ElementFactory

// =============================================================================
// Form Elements
// =============================================================================

declare const form: ElementFactory
declare const label: ElementFactory
declare const input: ElementFactory
declare const button: ElementFactory
declare const select: ElementFactory
declare const datalist: ElementFactory
declare const optgroup: ElementFactory
declare const option: ElementFactory
declare const textarea: ElementFactory
declare const output: ElementFactory
declare const progress: ElementFactory
declare const meter: ElementFactory
declare const fieldset: ElementFactory
declare const legend: ElementFactory

// =============================================================================
// Interactive Elements
// =============================================================================

declare const details: ElementFactory
declare const summary: ElementFactory
declare const dialog: ElementFactory

// =============================================================================
// Media Elements
// =============================================================================

declare const img: ElementFactory
declare const picture: ElementFactory
declare const source: ElementFactory
declare const video: ElementFactory
declare const audio: ElementFactory
declare const track: ElementFactory
declare const map: ElementFactory
declare const area: ElementFactory
declare const iframe: ElementFactory
declare const embed: ElementFactory
declare const object: ElementFactory
declare const param: ElementFactory
declare const canvas: ElementFactory
declare const svg: ElementFactory

// =============================================================================
// Miscellaneous Elements
// =============================================================================

declare const template: ElementFactory
declare const slot: ElementFactory
declare const noscript: ElementFactory

// =============================================================================
// Export for module augmentation
// =============================================================================

export {
  // Document structure
  html,
  head,
  body,
  title,
  meta,
  link,
  script,
  style,
  base,
  // Sectioning
  header,
  footer,
  main,
  nav,
  aside,
  section,
  article,
  address,
  // Content grouping
  div,
  p,
  hr,
  pre,
  blockquote,
  figure,
  figcaption,
  // Text content
  h1,
  h2,
  h3,
  h4,
  h5,
  h6,
  span,
  a,
  em,
  strong,
  small,
  s,
  cite,
  q,
  dfn,
  abbr,
  code,
  samp,
  kbd,
  sub,
  sup,
  i,
  b,
  u,
  mark,
  ruby,
  rt,
  rp,
  bdi,
  bdo,
  br,
  wbr,
  // Lists
  ul,
  ol,
  li,
  dl,
  dt,
  dd,
  // Tables
  table,
  caption,
  colgroup,
  col,
  thead,
  tbody,
  tfoot,
  tr,
  th,
  td,
  // Forms
  form,
  label,
  input,
  button,
  select,
  datalist,
  optgroup,
  option,
  textarea,
  output,
  progress,
  meter,
  fieldset,
  legend,
  // Interactive
  details,
  summary,
  dialog,
  // Media
  img,
  picture,
  source,
  video,
  audio,
  track,
  map,
  area,
  iframe,
  embed,
  object,
  param,
  canvas,
  svg,
  // Misc
  template,
  slot,
  noscript,
  // Type
  ElementFactory,
}
