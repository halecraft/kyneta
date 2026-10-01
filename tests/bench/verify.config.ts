import { defineConfig, parsers } from "@halecraft/verify"

// No `logic` task: the benchmarks measure, they do not assert, and they take
// seconds. Run them with `pnpm bench` after a build.
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
  ],
  env: {
    NO_COLOR: "1",
  },
})
