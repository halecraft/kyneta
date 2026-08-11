// doc-status — "does this document have data, and can I trust the answer?"
//
// Two questions get conflated constantly, with expensive results:
//
//   isPopulated(doc) === false
//
// means either "settled, and genuinely empty" (safe to write defaults) or
// "not settled yet, so of course it looks empty" (writing defaults destroys
// data). Nothing at the call site distinguishes them, so the safe-looking
// `if (!isPopulated(doc)) seed()` is a data-loss bug waiting for a slow disk.
//
// The three-state fixes that by making the dangerous state unrepresentable:
// you cannot observe "empty" before settling, because the type does not offer
// it.
//
// The gate guards only the *negative* verdict. Content is monotonic and
// arrives from any source, so "populated" needs no gate at all — as soon as
// any data shows up, that is a fact. "Empty" is a claim about absence, and
// absence of evidence is not evidence of absence until every source has been
// consulted. Hence: populated is disjunctive, empty is conjunctive.

import type { HasChangefeed } from "@kyneta/changefeed"
import { CHANGEFEED } from "@kyneta/changefeed"
import { isPopulated, populatedFeed } from "@kyneta/schema"
import type { Authority } from "./governance.js"
import { makeFeed, settledFeed, settledWith } from "./settle.js"

// ---------------------------------------------------------------------------
// The type
// ---------------------------------------------------------------------------

/**
 * What is known about a document's contents.
 *
 * - `"pending"` — not every truth source has reported. Nothing can be
 *   concluded about whether the document has data.
 * - `"empty"` — everything that could report has, and there is no data. This
 *   is the only state from which writing defaults is safe.
 * - `"populated"` — the document has data.
 */
export type DocStatus = "pending" | "empty" | "populated"

// ---------------------------------------------------------------------------
// Functional core
// ---------------------------------------------------------------------------

/**
 * The whole rule, as a three-row truth table.
 *
 * Pure and separated from the gathering so it can be exercised without an
 * Exchange, a store, or a transport — the same reasoning that put
 * `deriveConnectivity` in its own function.
 *
 * Note that `populated` wins regardless of `settled`: data that has already
 * arrived is not made less real by another source still being in flight.
 */
export function deriveDocStatus(input: {
  populated: boolean
  settled: boolean
}): DocStatus {
  if (input.populated) return "populated"
  return input.settled ? "empty" : "pending"
}

// ---------------------------------------------------------------------------
// Imperative shell
// ---------------------------------------------------------------------------

/**
 * What is known about this document's contents right now.
 *
 * Works at every layer and never throws: a standalone `createDoc` document has
 * no truth sources to await, so it reports `"empty"` or `"populated"` and
 * never `"pending"`. A document from an `Exchange` with a store and transports
 * waits for both.
 *
 * Named `docStatus` rather than `status` because "status" alone invites
 * confusion with connection state — `connectivity` and `peerStates` describe
 * the *connection*; this describes the *data*.
 *
 * @param node - A document ref (or any ref within one).
 * @param opts.authority - Whose answer settles the question. Defaults to the
 *   `Policy.authority` the Exchange was constructed with, and to `"any"` if
 *   none was declared.
 */
export function docStatus(
  node: object,
  opts?: { authority?: Authority },
): DocStatus {
  return deriveDocStatus({
    populated: isPopulated(node),
    settled: settledWith(node, opts?.authority),
  })
}

/**
 * Observable form of {@link docStatus}, composed from the document's content
 * feed and its settle conjunction.
 *
 * This is what the React bindings consume. Because it carries `[CHANGEFEED]`,
 * it needs no bespoke subscription plumbing — `useChangefeed` already speaks
 * this protocol, and so do `@kyneta/reactive` and `@kyneta/index`.
 *
 * `DocStatus` is not a boolean, so there is no `is*` form to pair with; the
 * `*Feed` half of the naming rule still applies, which is why the pair reads
 * `docStatus` / `docStatusFeed`.
 */
export function docStatusFeed(
  node: object,
  opts?: { authority?: Authority },
): (() => DocStatus) & HasChangefeed<DocStatus> {
  const content = populatedFeed(node)
  const settle = settledFeed(node)

  // Watches both inputs, because the status can move when either does: data
  // arriving flips it to "populated", and the last source reporting flips it
  // from "pending" to "empty".
  return makeFeed<DocStatus>(
    () => docStatus(node, opts),
    onChange => {
      const disposers = [
        content[CHANGEFEED].subscribe(() => onChange()),
        settle[CHANGEFEED].subscribe(() => onChange()),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
  )
}
