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
// What the engine can and cannot check. This module verifies *linkage*: that
// every name a rule needs is registered, and that no rule tries to derive a
// relation the host owns (`hostErrors`). Whether a rule uses one at the right
// *shape* is the same law for host code and rules alike, so it lives in one
// place for both — `analyzeArity` in `arity.ts`.
//
// What nothing can check is that two peers' registrations agree. That is the
// author's obligation, stated once here: same inputs, same output, on every
// peer, or the reality diverges silently. Declaring a `version` is what makes
// a disagreement *detectable* — it does not make it impossible.

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
   * The width of the tuples the relation holds.
   *
   * A name that resolves is not the same as a shape that fits: an atom
   * matching this relation at any other width unifies with nothing, so the
   * rule derives nothing and nothing complains. Declaring the width turns
   * that silence into a link error — `hostErrors` refuses the atom, and
   * `compute` yielding a tuple of another width throws.
   */
  readonly arity: number
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
   * predicate, each of the declared `arity`. Must be pure and total: a
   * function of `read` alone.
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
 * The data half of a point function — a function over single values, used by a
 * `compute` body element, as opposed to a relation over whole tables.
 *
 * This mirrors `ForeignDeclaration`: the parts a pack or a store can carry,
 * separated from the code, which cannot travel.
 */
export interface HostFunctionDeclaration {
  /**
   * How many arguments the function takes.
   *
   * Without it, a rule calling a 4-ary function with 3 arguments resolves by
   * name and then misbehaves by shape: the function reads `undefined` for the
   * missing argument and typically returns `NaN`, which the engine stores as
   * an ordinary value. Since `NaN` equals `NaN` under `Object.is`, that value
   * then joins with itself and spreads. Declaring the count makes it a link
   * error instead — and the check is *total*, because the argument count comes
   * from the rule rather than from the data, so every accepted program calls
   * every function at exactly this width.
   */
  readonly arity: number
  /**
   * The declaration's version. Two peers register their own code under the
   * same name; if the code differs they compute different realities from the
   * same store, silently. The engine cannot compare code — it can compare a
   * version a pack declares against a version a host registers, and refuse
   * where they disagree. A version is a claim about *meaning*, not a
   * fingerprint of bytes: two independent implementations should share one
   * when they compute the same function.
   */
  readonly version: string
}

/**
 * A declared point function with its implementation.
 *
 * Must be pure and deterministic. `undefined` means no result: the row is
 * dropped, the way a failed guard drops it.
 */
export interface HostFunction extends HostFunctionDeclaration {
  apply(args: readonly Value[]): Value | undefined
}

/**
 * The data half of a whole host — what a pack declares it needs, with no code
 * in it. `declarationErrors` checks one of these against a real `Host`.
 */
export interface HostDeclaration {
  readonly relations?: readonly ForeignDeclaration[]
  readonly functions?: Readonly<Record<string, HostFunctionDeclaration>>
}

/**
 * What the engine receives at creation. Both parts optional.
 *
 * Functions are keyed by name rather than carrying one, so the key is the
 * single source of truth and a typo cannot put `{ name: "uppr" }` under
 * `upper`. Relations carry `predicate` because a `ForeignRelation` travels on
 * its own — the stratifier stores one in `Stratum.foreign` — while a function
 * is only ever looked up by name.
 */
export interface Host {
  readonly relations?: readonly ForeignRelation[]
  readonly functions?: Readonly<Record<string, HostFunction>>
}

/** No host code. The default everywhere a host is optional. */
export const EMPTY_HOST: Host = {}

/** Shared empty registry for the evaluation functions' default parameter. */
export const NO_FUNCTIONS: ReadonlyMap<string, HostFunction> = new Map()

/**
 * The host's point functions as a map, built once per evaluator — and the one
 * place a registration is checked for shape.
 *
 * Why the check exists. A host function used to be a bare function, and a bare
 * function already *has* a built-in `.apply`. So a registration left in the old
 * form would not fail cleanly here; it would be invoked later as
 * `Function.prototype.apply`, receiving the argument array as its `this` and no
 * arguments at all, and misbehave somewhere inside a join. TypeScript rejects
 * the old shape outright, so this guard is for everyone else — and it is the
 * difference between a clear failure at construction and a baffling one at
 * evaluation.
 */
export function hostFunctions(
  host: Host | undefined,
): ReadonlyMap<string, HostFunction> {
  if (host?.functions === undefined) return NO_FUNCTIONS
  for (const [name, fn] of Object.entries(host.functions)) {
    if (
      typeof fn !== "object" ||
      fn === null ||
      typeof fn.arity !== "number" ||
      typeof fn.version !== "string" ||
      typeof fn.apply !== "function"
    ) {
      throw new Error(
        `host function "${name}" must be registered as { arity, version, apply }, not as a bare function`,
      )
    }
  }
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
 * **Linkage.** A rule references host code by name, so the first thing that
 * can go wrong is a name that does not resolve — or one that resolves on both
 * sides at once, which is what a rule deriving a host-computed predicate is.
 *
 * **Static safety.** A compute element whose argument nothing binds would
 * otherwise be scheduled last by the planner and drop every row, which for a
 * compute whose result the head needs is an empty relation with no error.
 * Binding is computed to a fixed point, so a compute may feed another compute
 * in either textual order, but never itself or a cycle.
 *
 * What this function deliberately does *not* check is shape. Whether a rule
 * mentions a relation at the width that relation holds is the same law for
 * host-computed and rule-derived predicates alike, so it lives in one place
 * for both: `analyzeArity` in `arity.ts`.
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
      // A wildcard never resolves to a value, so an argument position holding
      // one drops every row the element sees. The binding check below cannot
      // catch this: it only inspects `var` terms, and a wildcard is its own
      // kind of term that is never "unbound" — it is never bound at all.
      const wildcard = el.args.findIndex(t => t.kind === "wildcard")
      if (wildcard !== -1) {
        errors.push({
          kind: "wildcardComputeArgument",
          fn: el.fn,
          index: wildcard,
          rule,
        })
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
  | { readonly kind: "unregisteredHostFunction"; readonly fn: string }
  | {
      readonly kind: "hostFunctionDeclarationMismatch"
      readonly fn: string
      readonly declared: HostFunctionDeclaration
      readonly registered: HostFunctionDeclaration
    }

/**
 * Compare a declaration that travelled with data against what this host
 * registers, for both halves of a host at once.
 *
 * The engine never calls this; a consumer runs it when it links a pack, so
 * that a missing or mismatched name fails *there* rather than as an empty
 * relation or a wrong answer at solve time. `HostDeclaration` is exactly the
 * data half of `Host`, so "does this host satisfy this declaration" is one
 * question with one answer rather than two parallel ones.
 */
export function declarationErrors(
  declaration: HostDeclaration,
  host: Host | undefined,
): DeclarationError[] {
  const errors: DeclarationError[] = []

  const relations = new Map(
    foreignRelations(host).map(f => [f.predicate, f] as const),
  )
  for (const declared of declaration.relations ?? []) {
    const found = relations.get(declared.predicate)
    if (found === undefined) {
      errors.push({
        kind: "unregisteredForeignRelation",
        predicate: declared.predicate,
      })
    } else if (
      found.arity !== declared.arity ||
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
          arity: found.arity,
          inputs: found.inputs,
          version: found.version,
        },
      })
    }
  }

  const functions = host?.functions ?? {}
  for (const [fn, declared] of Object.entries(declaration.functions ?? {})) {
    const found = functions[fn]
    if (found === undefined) {
      errors.push({ kind: "unregisteredHostFunction", fn })
    } else if (
      found.arity !== declared.arity ||
      found.version !== declared.version
    ) {
      errors.push({
        kind: "hostFunctionDeclarationMismatch",
        fn,
        declared,
        registered: { arity: found.arity, version: found.version },
      })
    }
  }

  return errors
}
