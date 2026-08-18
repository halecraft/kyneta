// Documentation import check — the pure half.
//
// A README that shows code which no longer compiles is worse than no example at
// all, because a reader trusts it. Nothing checked ours until now, and the 3.0
// audit found eighteen broken imports across the package READMEs that ship
// inside npm tarballs.
//
// This is the *wide* half of a two-layer guard. `typescript-docs-verifier`
// compiles the blocks that can stand alone, which makes those correct by
// construction — the markdown is the compiled artifact, so there is no second
// copy to drift from. But most of the ~110 fences in this repo are fragments
// that reference an `exchange` or `doc` built earlier in the prose, and no tool
// can compile those: a fragment genuinely lacks the information. What can still
// be checked is that the names and module paths they mention exist, which is
// exactly the defect class the audit found.
//
// Everything here is a total function over strings. The imperative half — file
// reading, module resolution — lives in the test that calls these.

/** A fenced code block found in a markdown document. */
export interface Fence {
  /** Repo-relative path of the document it came from. */
  file: string
  /** 1-indexed line of the opening fence, so a failure is clickable. */
  line: number
  /** The fence's language tag: `ts`, `tsx`, or `typescript`. */
  lang: string
  code: string
}

export type Mismatch =
  /** The fence imports a name the module does not export. */
  | {
      kind: "unknown-export"
      file: string
      line: number
      name: string
      spec: string
    }
  /** The fence imports from a module specifier that does not resolve. */
  | { kind: "unresolved-module"; file: string; line: number; spec: string }

const FENCE_OPEN = /^```(ts|tsx|typescript)\s*$/

/** Find every TypeScript fence in a markdown document. */
export function extractFences(markdown: string, file: string): Fence[] {
  const lines = markdown.split("\n")
  const fences: Fence[] = []

  for (let i = 0; i < lines.length; i++) {
    const opener = FENCE_OPEN.exec(lines[i].trim())
    if (!opener) continue

    const body: string[] = []
    let end = i + 1
    while (end < lines.length && lines[end].trim() !== "```") {
      body.push(lines[end])
      end++
    }

    fences.push({ file, line: i + 1, lang: opener[1], code: body.join("\n") })
    i = end
  }

  return fences
}

const IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g

/**
 * Check that every value imported in a fence is really exported.
 *
 * This is the wide, shallow net: it covers every fence, including the fragments
 * no compiler can take. It is deliberately *not* a substitute for compilation —
 * it cannot see a symbol used without being imported, which is a real defect
 * this repo has shipped — which is why `typescript-docs-verifier` runs over the
 * standalone blocks as well.
 *
 * `resolve` is injected rather than performed here so this stays pure. It
 * returns the module's exported value names, or `null` if the specifier does
 * not resolve at all.
 *
 * Type-only imports are skipped: types are erased at runtime, so a resolver
 * built from a module's runtime exports cannot see them. The compiler covers
 * those for the blocks it takes.
 */
export function checkImports(
  fences: Fence[],
  resolve: (spec: string) => ReadonlySet<string> | null,
): Mismatch[] {
  const out: Mismatch[] = []

  for (const fence of fences) {
    // `matchAll` rather than a stateful `exec` loop: it builds its own regex
    // internally, so the shared module-level pattern's `lastIndex` cannot leak
    // between fences.
    for (const [statement, clause, spec] of fence.code.matchAll(IMPORT)) {
      if (!spec.startsWith("@kyneta/")) continue

      const names = resolve(spec)
      if (names === null) {
        // A specifier that does not resolve is a worse defect than a wrong
        // name — the whole module is missing, not one export — so it is
        // reported rather than skipped. An earlier version of this check
        // skipped unresolved specifiers and consequently reported a README
        // with two broken subpaths as completely clean.
        out.push({
          kind: "unresolved-module",
          file: fence.file,
          line: fence.line,
          spec,
        })
        continue
      }

      const typeOnlyStatement = /import\s+type\s*\{/.test(statement)
      for (const raw of clause.split(",")) {
        const typeOnly = typeOnlyStatement || /^\s*type\s+/.test(raw)
        const name = raw
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          .trim()
        if (!name || typeOnly) continue
        if (!names.has(name)) {
          out.push({
            kind: "unknown-export",
            file: fence.file,
            line: fence.line,
            name,
            spec,
          })
        }
      }
    }
  }

  return out
}

/** Render a mismatch as one clickable line. */
export function formatMismatch(m: Mismatch): string {
  const at = `${m.file}:${m.line}`
  switch (m.kind) {
    case "unknown-export":
      return `${at}  "${m.name}" is not exported by ${m.spec}`
    case "unresolved-module":
      return `${at}  cannot resolve module ${m.spec}`
  }
}
