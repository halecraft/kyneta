/**
 * @kyneta/compiler
 *
 * Incremental view maintenance compiler for structured deltas.
 *
 * Takes TypeScript source with builder patterns over Changefeed-emitting
 * state and produces a classified IR annotated with incremental strategies.
 *
 * Target-agnostic: does not generate JavaScript code or reference DOM APIs.
 * Rendering targets (@kyneta/web, etc.) consume the IR and produce
 * target-specific output.
 *
 * @packageDocumentation
 */