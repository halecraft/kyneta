// === Arity: one shape per predicate ===
//
// The law this module enforces, in one sentence:
//
//   A predicate has one arity, and every mention of it agrees.
//
// "Arity" is just the width of a relation — how many values each of its rows
// carries. `dist(X, Y, D)` is arity 3.
//
// Why the engine has to care. In classic Datalog `p/2` and `p/3` are two
// different predicates, told apart by their width. This engine keys relations
// by *name alone*, so a program that mentions `foo` at two widths is not
// describing two relations — it is describing one relation incoherently, and
// the incoherence is invisible at run time. `matchAtomWithTuple` (`unify.ts`)
// returns `null` the moment an atom's width differs from a tuple's, so a rule
// heading `foo/3` in a program whose readers expect `foo/2` writes facts that
// no body atom can ever match. They are not rejected and not merged. They sit
// in the relation, counted by `size`, matching nothing, forever.
//
// That is the failure this module turns into a link error. It matters most
// where rule heads are *generated*: a rewrite that emits a head at the wrong
// width has nothing else to catch it.
//
// Declared and inferred arity. A `ForeignRelation` (see `host.ts`) states its
// arity, because its rows come from host code the engine cannot read. Every
// other predicate's arity is inferred from the rules that mention it. Both are
// the same law — a declaration is simply the case where the arity is stated
// rather than worked out — which is why `foreignArityMismatch` lives here and
// not with the "the host is missing something" errors in `host.ts`.

import { foreignRelations, type Host } from "./host.js"
import type {
  ArityError,
  ArityMention,
  Atom,
  BodyElement,
  Rule,
} from "./types.js"

/**
 * The atom a body element matches against a stored relation: a positive atom,
 * a negated one, or an aggregation's source. A guard and a compute element
 * match no relation, so neither has an arity to get wrong.
 *
 * This is the one place that answers "which relation does this body element
 * read?". `stratify.ts`'s `bodyPredicates` goes through it too, so the answer
 * cannot drift between the two.
 */
export function matchedAtom(element: BodyElement): Atom | undefined {
  switch (element.kind) {
    case "atom":
    case "negation":
      return element.atom
    case "aggregation":
      return element.agg.source
    case "guard":
    case "compute":
      return undefined
  }
}

/** What the program says about shapes: the map, and every contradiction in it. */
export interface ArityAnalysis {
  /** Every predicate the program mentions, mapped to its one arity. */
  readonly arity: ReadonlyMap<string, number>
  readonly errors: readonly ArityError[]
}

/**
 * Read every shape claim the program makes, and every disagreement between
 * them.
 *
 * Returns the map and the errors **together**, deliberately. Split into an
 * `arityOf` and an `arityErrors` they would have to agree, silently, on what
 * the map reports for a predicate that *has* a conflict — first mention wins?
 * declared wins? absent? Returning both from one call makes the property the
 * rest of the engine relies on structural rather than documentary:
 *
 *   **You cannot obtain the map without also obtaining the reasons it might
 *   be meaningless.**
 *
 * That is what lets `createEvaluator` hold the map and trust it: by the time
 * anything reads it, `stratify` has already refused the program if `errors`
 * was non-empty.
 */
export function analyzeArity(
  rules: readonly Rule[],
  host?: Host,
): ArityAnalysis {
  const errors: ArityError[] = []
  const arity = new Map<string, number>()

  // A declared arity is authoritative, so seed the map with declarations
  // before looking at a single rule.
  for (const relation of foreignRelations(host)) {
    arity.set(relation.predicate, relation.arity)
  }

  // The first rule-side mention of each predicate, kept so that a later
  // disagreement can name both places rather than just the one that broke.
  //
  // Its *absence* carries information too: a predicate whose width is known
  // but which has no first mention can only have got that width from a
  // declaration. That is what tells the two errors apart below.
  const firstSeen = new Map<string, ArityMention>()

  /** Record one mention, or report it disagreeing with what is already known. */
  const note = (atom: Atom, rule: Rule, position: "head" | "body"): void => {
    const width = atom.terms.length
    const known = arity.get(atom.predicate)

    if (known === undefined) {
      arity.set(atom.predicate, width)
      firstSeen.set(atom.predicate, { arity: width, rule, position })
      return
    }
    if (known === width) return

    const first = firstSeen.get(atom.predicate)
    if (first === undefined) {
      // No rule ever mentioned it, so `known` came from a host declaration —
      // and a declaration is an authority, so there is a right answer to name.
      errors.push({
        kind: "foreignArityMismatch",
        predicate: atom.predicate,
        declared: known,
        found: width,
        rule,
      })
      return
    }

    // Two rules disagreeing with each other have no authority between them,
    // so name both sites and let the author decide which was meant.
    errors.push({
      kind: "arityConflict",
      predicate: atom.predicate,
      first,
      second: { arity: width, rule, position },
    })
  }

  // Point functions declare an arity too, and a compute element calling one at
  // another width is the same law: a name that resolves, a shape that does not.
  const functions = host?.functions ?? {}

  for (const rule of rules) {
    // The head is a mention like any other. A rule that *writes* `foo` at a
    // width its readers do not expect is the case this whole check exists for,
    // and it is the one a rule generator gets wrong.
    note(rule.head, rule, "head")
    for (const element of rule.body) {
      const matched = matchedAtom(element)
      if (matched !== undefined) {
        note(matched, rule, "body")
        continue
      }
      if (element.kind !== "compute") continue
      const fn = functions[element.fn]
      // An unregistered name is `hostErrors`' business, not ours.
      if (fn === undefined || fn.arity === element.args.length) continue
      errors.push({
        kind: "hostFunctionArityMismatch",
        fn: element.fn,
        declared: fn.arity,
        found: element.args.length,
        rule,
      })
    }
  }

  return { arity, errors }
}
