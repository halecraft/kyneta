import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/client.ts", "src/server.ts", "src/bun.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
})
