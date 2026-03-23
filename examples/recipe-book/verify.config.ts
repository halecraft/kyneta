import { defineConfig, parsers } from "@halecraft/verify"

export default defineConfig({
  tasks: [
    {
      key: "format",
      run: "biome check --write .",
      parser: parsers.biome,
    },
    {
      key: "logic",
      run: "vitest run",
      parser: parsers.vitest,
      reportingDependsOn: ["format"],
    },
  ],
  env: {
    NO_COLOR: "1",
  },
})
