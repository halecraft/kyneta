// === Host relations and functions ===
//
// Some relations a program reads cannot be written as rules: a breadth-first
// distance field, a keyed hash per tile. The host supplies those as code, and
// the evaluator treats them as strata (foreign relations) or as body elements
// (compute elements). Both are referenced from rules **by name only**.
//
// Why by name. Rules are data: they travel in the constraint store, and any
// two correct implementations must compute the same reality from the same
// store (TECHNICAL.md, key invariants 1 and 2). Code cannot travel, and can
// differ between peers. So the split is: the *declaration* of a foreign
// relation (its name, inputs and version) is data and may live in a pack or a
// store; the *implementation* is registered on the engine at creation. The
// specification faced the same problem for native solvers and answered it the
// same way, with an engine version pinned in the reality's creation
// constraint (`packages/perspective/theory/unified-engine.md` §B.7). This
// module extends that.
//
// What the engine can and cannot check. It verifies that every name a rule
// needs is registered, and refuses to run otherwise (`hostErrors`). It cannot
// verify that two peers' registrations agree; that is the author's obligation,
// stated once here: same inputs, same output, on every peer, or the reality
// diverges silently.

import type {
  BodyElement,
  FactTuple,
  HostError,
  ReadonlyDatabase,
  Rule,
  Value,
} from "./types.js"

// ---------------------------------------------------------------------------
// Declarations (data) and registrations (code)
// ---------------------------------------------------------------------------

/**
 * The data half of a foreign relation: enough for a pack or a store to say
 * what it expects, and for `declarationErrors` to check a host against it.
 */
export interface ForeignDeclaration {
  readonly predicate: string
  /**
   * The relations the function reads. The stratifier places the relation
   * strictly above all of them, and the function may read nothing else.
   */
  readonly inputs: readonly string[]
  /**
   * The declaration's version. A mismatch between what a pack declares and
   * what a host registers is detectable; agreement of two hosts is not.
   */
  readonly version: string
}

/** A foreign declaration with its implementation: a stratum whose body is code. */
export interface ForeignRelation extends ForeignDeclaration {
  /**
   * The whole relation for the current inputs, as tuples of the declared
   * predicate. Must be pure and total: a function of `read` alone.
   *
   * `changed` names the inputs whose presence changed since the last run, so
   * a memo inside the function knows what it may keep. It is a hint, not a
   * contract: the output must not depend on it, and on the first run and
   * after a rule change it names every input.
   */
  compute(
    read: ReadonlyDatabase,
    changed: ReadonlySet<string>,
  ): Iterable<FactTuple>
}

/**
 * A point function over bound values, used by a `compute` body element.
 * Must be pure and deterministic. `undefined` means no result: the row is
 * dropped, the way a failed guard drops it.
 */
export type HostFunction = (args: readonly Value[]) => Value | undefined

/** What the engine receives at creation. Both parts optional. */
export interface Host {
  readonly relations?: readonly ForeignRelation[]
  readonly functions?: Readonly<Record<string, HostFunction>>
}

/** No host code. The default everywhere a host is optional. */
export const EMPTY_HOST: Host = {}

/** Shared empty registry for the evaluation functions' default parameter. */
export const NO_FUNCTIONS: ReadonlyMap<string, HostFunction> = new Map()

/** The host's point functions as a map, built once per evaluator. */
export function hostFunctions(
  host: Host | undefined,
): ReadonlyMap<string, HostFunction> {
  if (host?.functions === undefined) return NO_FUNCTIONS
  return new Map(Object.entries(host.functions))
}

/** The host's foreign relations, or none. */
export function foreignRelations(
  host: Host | undefined,
): readonly ForeignRelation[] {
  return host?.relations ?? []
}

// ---------------------------------------------------------------------------
// The engine's check: do these rules have everything they need?
// ---------------------------------------------------------------------------

/**
 * Every way a rule set can fail to match a host, as values. Runs before any
 * evaluation, on construction and on every rule change; `stratify` returns
 * the first one through the error channel it already has.
 *
 * The third kind is static safety. A compute element whose argument nothing
 * binds would otherwise be scheduled last by the planner and drop every row,
 * which for a compute whose result the head needs is an empty relation with
 * no error. Binding is computed to a fixed point, so a compute may feed
 * another compute in either textual order, but never itself or a cycle.
 */
export function hostErrors(
  rules: readonly Rule[],
  host: Host | undefined,
): HostError[] {
  const errors: HostError[] = []
  const functions = host?.functions ?? {}
  const foreign = new Set(foreignRelations(host).map(f => f.predicate))

  for (const rule of rules) {
    if (foreign.has(rule.head.predicate)) {
      errors.push({
        kind: "foreignPredicateDerived",
        predicate: rule.head.predicate,
        rule,
      })
    }

    const computes = rule.body.filter(el => el.kind === "compute")
    if (computes.length === 0) continue

    for (const el of computes) {
      if (!(el.fn in functions)) {
        errors.push({ kind: "unknownHostFunction", fn: el.fn, rule })
      }
    }

    const bound = structurallyBound(rule.body)
    const pending = new Set(computes)
    let progressed = true
    while (progressed) {
      progressed = false
      for (const el of pending) {
        const ready = el.args.every(t => t.kind !== "var" || bound.has(t.name))
        if (!ready) continue
        if (el.result.kind === "var") bound.add(el.result.name)
        pending.delete(el)
        progressed = true
      }
    }
    for (const el of pending) {
      const variable = el.args.find(t => t.kind === "var" && !bound.has(t.name))
      if (variable?.kind === "var") {
        errors.push({
          kind: "unboundComputeArgument",
          fn: el.fn,
          variable: variable.name,
          rule,
        })
      }
    }
  }

  return errors
}

/** Variables a body binds without any compute element: atoms and aggregation. */
function structurallyBound(body: readonly BodyElement[]): Set<string> {
  const bound = new Set<string>()
  for (const el of body) {
    if (el.kind === "atom") {
      for (const t of el.atom.terms) if (t.kind === "var") bound.add(t.name)
    } else if (el.kind === "aggregation") {
      for (const v of el.agg.groupBy) bound.add(v)
      bound.add(el.agg.result)
    }
  }
  return bound
}

// ---------------------------------------------------------------------------
// The consumer's check: does this host satisfy what a pack or store declares?
// ---------------------------------------------------------------------------

export type DeclarationError =
  | { readonly kind: "unregisteredForeignRelation"; readonly predicate: string }
  | {
      readonly kind: "foreignDeclarationMismatch"
      readonly predicate: string
      readonly declared: ForeignDeclaration
      readonly registered: ForeignDeclaration
    }

/**
 * Compare declarations that travelled with data against what this host
 * registers. The engine never calls this; a consumer runs it when it links
 * a pack, so that a missing or mismatched relation fails there and not as
 * an empty relation at solve time.
 */
export function declarationErrors(
  declarations: readonly ForeignDeclaration[],
  host: Host | undefined,
): DeclarationError[] {
  const registered = new Map(
    foreignRelations(host).map(f => [f.predicate, f] as const),
  )
  const errors: DeclarationError[] = []
  for (const declared of declarations) {
    const found = registered.get(declared.predicate)
    if (found === undefined) {
      errors.push({
        kind: "unregisteredForeignRelation",
        predicate: declared.predicate,
      })
    } else if (
      found.version !== declared.version ||
      found.inputs.length !== declared.inputs.length ||
      found.inputs.some((input, i) => input !== declared.inputs[i])
    ) {
      errors.push({
        kind: "foreignDeclarationMismatch",
        predicate: declared.predicate,
        declared,
        registered: {
          predicate: found.predicate,
          inputs: found.inputs,
          version: found.version,
        },
      })
    }
  }
  return errors
}
