import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/server.ts", "src/client.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
})