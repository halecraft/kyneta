// Hidden preludes — the pure half.
//
// Our package READMEs are deliberately *narrative*: one block builds an
// exchange, and a block three sections later mutates a document from it. That
// reads well and is why 93 of 105 code blocks in this repo do not compile on
// their own — they are fragments, not programs.
//
// A compiler cannot be talked out of that. The standard remedy is to let the
// document carry the setup its examples assume, hidden from the reader: Rust's
// doctests hide lines with `#`, mdBook does the same, Scala's mdoc has silent
// blocks. Here it is an HTML comment, which markdown renderers drop, so npm and
// GitHub show only the example:
//
//     <!-- ts-docs-prelude
//     import { Exchange } from "@kyneta/exchange"
//     declare const exchange: Exchange
//     -->
//
// Each fence is compiled as `prelude + fence`, which makes it a real program
// without the prose repeating imports a reader has already seen.
//
// The alternative was one `ts-docs-verifier:ignore` marker per fragment. That
// costs the same number of annotations and verifies nothing.
//
// Everything here is a total function over strings. Writing files and running
// the compiler lives in `verify-docs.ts`.

import { extractFences, type Fence } from "./fences.js"

const PRELUDE_OPEN = /^<!--\s*ts-docs-prelude\s*$/
const SETUP_OPEN = /^<!--\s*ts-docs-setup\s*$/
const PRELUDE_CLOSE = /^-->\s*$/
const IGNORE = /^<!--\s*ts-docs-verifier:ignore\s*-->\s*$/
const STANDALONE = /^<!--\s*ts-docs-standalone\s*-->\s*$/

/** A fence paired with the prelude that was in effect where it appears. */
export interface PreparedBlock {
  /** Repo-relative path of the document the fence came from. */
  file: string
  /** 1-indexed line of the fence's first *code* line in that document. */
  codeLine: number
  /** How many lines of prelude are prepended, for mapping errors back. */
  preludeLines: number
  /** `prelude + code`, ready to compile. */
  source: string
  lang: string
}

/**
 * Collect the preludes in a document, keyed by the line they take effect from.
 *
 * Semantics are **replacement, not accumulation**: a fence uses the nearest
 * prelude above it, full stop. Accumulating would let two preludes declare the
 * same name and produce a redeclaration error that points at neither of them.
 * A section needing different setup states all of it, which is more repetition
 * in the source and far less to reason about.
 */
export function extractPreludes(
  markdown: string,
  marker: RegExp = PRELUDE_OPEN,
): Array<{ fromLine: number; code: string }> {
  const lines = markdown.split("\n")
  const out: Array<{ fromLine: number; code: string }> = []

  for (let i = 0; i < lines.length; i++) {
    if (!marker.test(lines[i].trim())) continue
    const body: string[] = []
    let end = i + 1
    while (end < lines.length && !PRELUDE_CLOSE.test(lines[end].trim())) {
      body.push(lines[end])
      end++
    }
    out.push({ fromLine: i + 1, code: body.join("\n") })
    i = end
  }

  return out
}

/**
 * The `ts-docs-setup` block attached to a fence, if any.
 *
 * Where a prelude is shared setup for a run of blocks, a setup block belongs to
 * exactly one fence and is *added* to the prelude rather than replacing it.
 * These READMEs need both: a file declares its schemas and transports once, but
 * whether a given block builds its own `exchange` or expects one to exist
 * alternates section by section, and only the block itself knows which.
 */
function setupFor(
  setups: Array<{ fromLine: number; code: string }>,
  fenceLine: number,
  previousFenceLine: number,
): string {
  const owned = setups.filter(
    s => s.fromLine < fenceLine && s.fromLine > previousFenceLine,
  )
  return owned.map(s => s.code).join("\n")
}

/**
 * Every marker line in the run of HTML comments directly above a fence.
 *
 * Scans the whole run rather than the single nearest line, because markers
 * stack: a fence can carry a `ts-docs-setup` block *and* be ignored. Checking
 * only the closest line makes the outer marker silently do nothing, which is a
 * bug that looks exactly like the marker being wrong.
 */
function markersAbove(markdown: string, fence: Fence): string[] {
  const lines = markdown.split("\n")
  const found: string[] = []
  // The fence's `line` is 1-indexed and points at the opening ```.
  let i = fence.line - 2

  while (i >= 0) {
    const line = lines[i].trim()
    if (line === "") {
      i--
      continue
    }
    if (line === "-->") {
      // Walk back over a multi-line comment to whatever opened it.
      while (i >= 0 && !lines[i].trim().startsWith("<!--")) i--
      if (i < 0) break
      found.push(lines[i].trim())
      i--
      continue
    }
    if (line.startsWith("<!--") && line.endsWith("-->")) {
      found.push(line)
      i--
      continue
    }
    break
  }

  return found
}

/** Whether a fence is explicitly opted out of compilation. */
function isIgnored(markdown: string, fence: Fence): boolean {
  return markersAbove(markdown, fence).some(m => IGNORE.test(m))
}

/**
 * Whether a fence brings its own imports and wants no prelude.
 *
 * A block that demonstrates *how to import something* is complete on its own,
 * and prepending a prelude that imports the same name turns a correct example
 * into a duplicate-identifier error. Marking it standalone is more honest than
 * thinning the prelude until no block collides with it, which would push setup
 * back into the prose for every other block.
 */
function isStandalone(markdown: string, fence: Fence): boolean {
  return markersAbove(markdown, fence).some(m => STANDALONE.test(m))
}

/** The prelude in effect at a given line: the nearest one above it. */
function preludeFor(
  preludes: Array<{ fromLine: number; code: string }>,
  line: number,
): string {
  let chosen = ""
  for (const p of preludes) {
    if (p.fromLine < line) chosen = p.code
    else break
  }
  return chosen
}

/**
 * Pair every compilable fence in a document with its prelude.
 *
 * Ignored fences are dropped rather than returned with a flag, because the
 * caller has nothing useful to do with a block it must not compile.
 */
export function prepareBlocks(markdown: string, file: string): PreparedBlock[] {
  const preludes = extractPreludes(markdown)
  const setups = extractPreludes(markdown, SETUP_OPEN)
  const allFences = extractFences(markdown, file)

  return allFences
    .filter(fence => !isIgnored(markdown, fence))
    .map(fence => {
      // A setup block belongs to the next fence after it, so the search window
      // starts at the previous fence — including ignored ones, which still
      // consume any setup written for them.
      const previous = allFences.filter(f => f.line < fence.line).at(-1)
      const parts = [
        isStandalone(markdown, fence) ? "" : preludeFor(preludes, fence.line),
        setupFor(setups, fence.line, previous?.line ?? 0),
      ].filter(part => part !== "")

      const prelude = parts.join("\n")
      const preludeLines = prelude === "" ? 0 : prelude.split("\n").length
      return {
        file,
        // +1 because `fence.line` is the ``` itself; code starts the line after.
        codeLine: fence.line + 1,
        preludeLines,
        source: prelude === "" ? fence.code : `${prelude}\n${fence.code}`,
        lang: fence.lang,
      }
    })
}

/**
 * Render prepared blocks as a markdown document the verifier can consume.
 *
 * The tool takes markdown and nothing else, so the synthesized blocks travel
 * back to it in the only format it reads. Block order is preserved, which is
 * what lets a reported "Code Block N" be mapped back to its origin.
 */
export function renderForCompiler(blocks: PreparedBlock[]): string {
  return blocks
    .map(b => "```" + b.lang + "\n" + b.source + "\n```")
    .join("\n\n")
}

/**
 * Map a location the compiler reported back to the document a reader edits.
 *
 * The compiler sees `prelude + code` and counts from the top of that; a reader
 * needs the line in the README. An error *inside* the prelude is reported at
 * the fence's first line, since that is the nearest real place to look.
 */
export function mapLocation(
  block: PreparedBlock,
  reportedLine: number,
): { file: string; line: number; inPrelude: boolean } {
  const withinCode = reportedLine - block.preludeLines
  return {
    file: block.file,
    line: block.codeLine + Math.max(0, withinCode - 1),
    inPrelude: withinCode < 1,
  }
}
