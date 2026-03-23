import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    transforms: "src/transforms.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
})
