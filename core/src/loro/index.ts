/**
 * Loro-specific extensions for Kinetic.
 *
 * This subpath contains functionality that requires direct access to Loro
 * containers, primarily two-way bindings for form inputs.
 *
 * Two-way bindings are Loro-specific because they need to mutate Loro
 * containers directly on input events. The core Kinetic runtime uses the
 * `[REACTIVE]` symbol for subscriptions, which works with any reactive
 * type (LocalRef, custom types, Loro refs), but writes require Loro access.
 *
 * @example
 * ```ts
 * // In compiled code:
 * import { __subscribe } from "@loro-extended/kinetic"
 * import { __bindTextValue } from "@loro-extended/kinetic/loro"
 * ```
 *
 * @packageDocumentation
 */

export {
  __bindChecked,
  __bindNumericValue,
  __bindTextValue,
  bind,
  isBinding,
} from "./binding.js"
