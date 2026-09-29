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
      strategy: "sequential",
      reportingDependsOn: ["format"],
      children: [
        // The client's types are generated from prisma/schema.prisma.
        { key: "generate", run: "prisma generate --no-hints" },
        {
          key: "tsc",
          run: "tsgo --noEmit --skipLibCheck",
          parser: parsers.tsc,
        },
      ],
    },
  ],
  env: {
    NO_COLOR: "1",
  },
})
