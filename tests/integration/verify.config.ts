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
