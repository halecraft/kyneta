import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // The backends are packages of their own, and run their own tests.
    include: ["src/**/*.test.ts"],
    // The ref lifetime tests force a collection (`globalThis.gc`).
    execArgv: ["--expose-gc"],
  },
})
