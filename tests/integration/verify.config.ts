import { defineConfig, parsers } from "@halecraft/verify"

export default defineConfig({
  tasks: [
    {
      key: "format",
      run: "biome check --write .",
      parser: parsers.biome,
    },
    {
      key: "types",
      run: "tsgo --noEmit --skipLibCheck",
      parser: parsers.tsc,
      reportingDependsOn: ["format"],
    },
    {
      // Compiles the code blocks in the root README straight out of the
      // markdown, so a documented example cannot be wrong: there is no second
      // copy of it anywhere to drift from.
      //
      // It runs here rather than from the repo root for two reasons. The tool
      // needs a host package declaring `main`/`exports`, and it resolves a
      // snippet's imports against that host's dependencies — and this is the
      // only package that has every @kyneta package installed. A package's own
      // README routinely demonstrates packages it does not itself depend on,
      // so running it from, say, `packages/exchange` reports correct examples
      // as broken.
      key: "docs",
      run: "bun src/doc-check/verify-docs.ts",
      parser: parsers.generic,
      reportingDependsOn: ["types"],
    },
    {
      key: "logic",
      strategy: "parallel",
      reportingDependsOn: ["format", "types"],
      children: [
        {
          key: "logic-node",
          run: "vitest run",
          parser: parsers.vitest,
        },
        {
          key: "logic-bun",
          run: "bun test bun.test.ts",
          parser: parsers.generic,
        },
      ],
    },
  ],
  env: {
    NO_COLOR: "1",
  },
})
